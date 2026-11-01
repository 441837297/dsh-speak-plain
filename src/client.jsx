import React, { useEffect, useRef, useState } from 'react'
import { SpeakPlainContent } from './rich-content.jsx'
import { createAssistantShadow } from './shadow-answer.jsx'
import styles from './client.css'

export { SpeakPlainContent, createAssistantShadow }
const GENUI_CSS = '__DSH_SPEAK_PLAIN_GENUI_CSS_TEXT__'

export const inject = ['slots', 'connection', 'sessions']

const DEFAULT_SETTINGS = { enabled: false, provider: '', model: '', preference: '', timeoutMs: 60000 }

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '请求失败')
}

function normalizeSettings(value = {}) {
  return {
    enabled: value.enabled === true,
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    preference: typeof value.preference === 'string' ? value.preference : '',
    timeoutMs: Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : DEFAULT_SETTINGS.timeoutMs,
  }
}

/** A settings instance owns its requests; unloading never publishes their late results. */
export function SpeakPlainSettings({ call }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [providers, setProviders] = useState([])
  const [loading, setLoading] = useState(true)
  const [snapshotReady, setSnapshotReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const requests = useRef(new Set())
  const alive = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const controller of requests.current) controller.abort()
      requests.current.clear()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    requests.current.add(controller)
    setLoading(true)
    setError('')
    call('snapshot', {}, controller.signal).then(snapshot => {
      if (controller.signal.aborted) return
      setSettings(normalizeSettings(snapshot.settings))
      setProviders(Array.isArray(snapshot.providers) ? snapshot.providers : [])
      setSnapshotReady(true)
    }).catch(error => {
      if (!controller.signal.aborted) setError(`无法读取设置：${messageOf(error)}`)
    }).finally(() => {
      requests.current.delete(controller)
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [call, retry])

  const provider = providers.find(item => item.id === settings.provider)
  const models = Array.isArray(provider?.models) ? provider.models : []
  const knownProvider = providers.some(item => item.id === settings.provider)
  const knownModel = models.some(item => item.id === settings.model)
  const update = patch => { setSettings(previous => ({ ...previous, ...patch })); setNotice(''); setError('') }

  async function save(event) {
    event.preventDefault()
    if (saving || loading) return
    if (settings.enabled && (!knownProvider || !knownModel)) {
      setError('请先选择可用的渠道和模型。')
      return
    }
    const controller = new AbortController()
    requests.current.add(controller)
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const snapshot = await call('settings/save', { ...settings }, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      setSettings(normalizeSettings(snapshot.settings))
      setProviders(Array.isArray(snapshot.providers) ? snapshot.providers : [])
      setSnapshotReady(true)
      setNotice('已保存，之后完成的回答将使用这些设置。')
    } catch (error) {
      if (!controller.signal.aborted && alive.current) setError(`保存失败：${messageOf(error)}`)
    } finally {
      requests.current.delete(controller)
      if (!controller.signal.aborted && alive.current) setSaving(false)
    }
  }

  return <section className="speak-plain-settings">
    <h2>说人话</h2>
    <p className="speak-plain-muted">用你选择的模型整理最终回答，让表达更容易理解。原回答会保留，润色结果显示在它下方。</p>
    {loading ? <p role="status">正在读取设置…</p> : snapshotReady ? <form onSubmit={save}>
      <fieldset disabled={saving}>
        <label className="speak-plain-check"><input type="checkbox" checked={settings.enabled} onChange={event => update({ enabled: event.target.checked })} />启用最终回答润色</label>
        <div className="speak-plain-model-fields">
          <label>渠道<select value={settings.provider} onChange={event => update({ provider: event.target.value, model: '' })}>
            <option value="">请选择渠道</option>
            {settings.provider && !knownProvider && <option value={settings.provider}>当前渠道不可用（{settings.provider}）</option>}
            {providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select></label>
          <label>模型<select value={settings.model} disabled={!knownProvider} onChange={event => update({ model: event.target.value })}>
            <option value="">请选择模型</option>
            {settings.model && !knownModel && <option value={settings.model}>当前模型不可用（{settings.model}）</option>}
            {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select></label>
        </div>
        {providers.length === 0 && <p className="speak-plain-muted">还没有可用渠道，请先在 DSH 的模型设置中配置。</p>}
        <label className="speak-plain-preference">你希望怎么说话<textarea rows={5} value={settings.preference} placeholder="例如：像同事聊天一样解释，先说结果，术语第一次出现时解释一下，别写成工作汇报。" onChange={event => update({ preference: event.target.value })} /></label>
        <p className="speak-plain-muted">润色会额外调用所选模型，产生相应费用；不会改变原回答或已生成的历史结果。</p>
        <button type="submit">{saving ? '正在保存…' : '保存设置'}</button>
      </fieldset>
    </form> : null}
    {error && <div className="speak-plain-error" role="alert"><p>{error}</p>{!loading && !saving && <button type="button" onClick={() => { setNotice(''); setRetry(value => value + 1) }}>重新读取设置</button>}</div>}
    {notice && <p className="speak-plain-notice" role="status">{notice}</p>}
  </section>
}

/** Closed turns are durable: fetch once per identity, with an explicit retry only. */
export function SpeakPlainTurnTail({ call, sessionId, turn, seq, sendAction }) {
  const turnNumber = turn?.turn
  const closed = turn?.status === 'closed'
  const identity = JSON.stringify([sessionId, turnNumber, seq])
  const [state, setState] = useState({ identity: '', loading: false, result: null, error: '' })
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const [copyStatus, setCopyStatus] = useState('')
  const [showOriginal, setShowOriginal] = useState(false)
  const [foundOriginal, setFoundOriginal] = useState(false)
  const rootRef = useRef(null)
  const answerRef = useRef(null)
  const debugSent = useRef('')
  const currentIdentity = useRef(identity)
  const mounted = useRef(false)
  currentIdentity.current = identity
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    setExpanded(true)
    setCopyStatus('')
    if (!closed || typeof sessionId !== 'string' || !Number.isInteger(turnNumber)) {
      setState({ identity, loading: false, result: null, error: '' })
      return
    }
    const controller = new AbortController()
    setState({ identity, loading: true, result: null, error: '' })
    call('result/get', { sessionId, turn: turnNumber }, controller.signal).then(value => {
      if (controller.signal.aborted) return
      const result = value.result ?? null
      if (result && (result.sessionId !== sessionId || result.turn !== turnNumber)) throw new Error('返回的结果与当前回合不匹配。')
      if (result && result.originalSeq !== seq) {
        setState({ identity, loading: false, result: null, error: '' })
        return
      }
      if (result && !['ready', 'failed', 'skipped', 'pending'].includes(result.status)) throw new Error('返回了无法识别的润色状态。')
      if (result?.status === 'ready' && typeof result.text !== 'string') throw new Error('润色结果缺少正文。')
      setState({ identity, loading: false, result, error: '' })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ identity, loading: false, result: null, error: messageOf(error) })
    })
    return () => controller.abort()
  }, [call, sessionId, turnNumber, seq, closed, retry])

  const readyResult = state.identity === identity && state.result && state.result.status === 'ready' ? state.result : null

  // Reset the reveal toggle whenever we move to a different turn/answer.
  useEffect(() => { setShowOriginal(false); setFoundOriginal(false); answerRef.current = null }, [identity, readyResult === null])

  // Collapse the REAL original answer row (the chat's own, untouched render) by
  // hiding the sibling flow item, and reveal it only when the reader asks. This
  // never re-implements the answer renderer, so tool steps, reasoning, images and
  // copy keep working; if the row cannot be found we hide nothing (safe).
  useEffect(() => {
    if (readyResult === null) return undefined
    const apply = () => {
      const root = rootRef.current
      if (!root) return
      const myItem = root.closest('[data-chat-flow-kind]')
      let sib = myItem ? myItem.previousElementSibling : null
      let target = null
      const kinds = []
      while (sib) {
        const kind = sib.getAttribute ? sib.getAttribute('data-chat-flow-kind') : null
        kinds.push(kind)
        if (kind === 'assistant-step') { target = sib; break }
        sib = sib.previousElementSibling
      }
      answerRef.current = target
      if (!target) { setFoundOriginal(false); return }
      setFoundOriginal(true)
      if (showOriginal) target.removeAttribute('data-speak-plain-hidden')
      else target.setAttribute('data-speak-plain-hidden', '')
      if (debugSent.current !== identity) {
        debugSent.current = identity
        try { Promise.resolve(call('debug', { message: `hide turn=${turnNumber} found=1 kinds=${kinds.join('|')}` })).catch(() => {}) } catch { /* diagnostics must never break rendering */ }
      }
    }
    apply()
    const flow = rootRef.current ? rootRef.current.closest('[data-slot="conversation.chat.flow"]') : null
    let observer
    if (flow && typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => { if (rootRef.current) apply() })
      observer.observe(flow, { childList: true })
    }
    return () => {
      if (observer) observer.disconnect()
      if (answerRef.current) answerRef.current.removeAttribute('data-speak-plain-hidden')
    }
  }, [readyResult, showOriginal, identity, call, turnNumber])

  if (!closed || state.identity !== identity) return null
  if (state.loading) return <div className="speak-plain-tail speak-plain-muted" role="status">正在读取润色结果…</div>
  if (state.error) return <aside className="speak-plain-tail"><p className="speak-plain-error" role="alert">无法读取润色结果：{state.error} 原回答仍保留在上方。</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试读取</button></aside>
  const result = state.result
  if (!result || result.status === 'skipped') return null
  if (result.status === 'failed') return <aside className="speak-plain-tail"><strong>说人话</strong><p className="speak-plain-muted">润色未完成：{result.error || '模型调用失败。'} 原回答仍保留在上方。</p></aside>
  if (result.status === 'pending') return <aside className="speak-plain-tail"><p className="speak-plain-muted" role="status">润色结果尚未就绪，原回答仍保留在上方。</p><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></aside>

  async function copy() {
    const copiedIdentity = identity
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持复制，请选择正文复制。')
      await navigator.clipboard.writeText(result.text)
      if (mounted.current && currentIdentity.current === copiedIdentity) setCopyStatus('已复制')
    } catch (error) {
      if (mounted.current && currentIdentity.current === copiedIdentity) setCopyStatus(`复制失败：${messageOf(error)}`)
    }
  }

  return <aside className="speak-plain-tail" aria-label="说人话润色结果" ref={rootRef}>
    <div className="speak-plain-tail-heading">
      <button type="button" className="speak-plain-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>说人话 · {result.model || '润色结果'}</button>
      <span className="speak-plain-actions">
        {foundOriginal && <button type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)}>{showOriginal ? '收起原回答' : '查看原回答'}</button>}
        <button type="button" onClick={copy}>复制润色结果</button>
      </span>
    </div>
    <div className="speak-plain-result" hidden={!expanded}><SpeakPlainContent text={result.text} sessionId={sessionId} messageId={result.originalMessageId} originalSeq={seq} onAction={sendAction ? (action, payload) => sendAction(sessionId, action, payload) : undefined} /></div>
    {copyStatus && <p className="speak-plain-muted" role="status">{copyStatus}</p>}
  </aside>
}

export function apply(ctx) {
  const connection = ctx.get('connection')
  const lifetime = new AbortController()
  const call = async (endpoint, payload, signal) => {
    const fusedSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal
    const response = await connection.rpc.call('/api', 'speakPlain', { endpoint, payload }, fusedSignal)
    fusedSignal.throwIfAborted()
    if (!response?.ok) throw new Error(response?.error?.message || '请求失败，请稍后重试。')
    return response.value
  }
  const sendAction = async (sessionId, action, payload) => {
    lifetime.signal.throwIfAborted()
    const conversation = ctx.get('sessions').scope(sessionId)?.get('conversation')
    if (!conversation) throw new Error('对应会话当前不可用')
    const data = Object.keys(payload ?? {}).length ? ` 组件数据: ${JSON.stringify(payload)}` : ''
    await conversation.send(`[genui-action] ${action}。用户刚刚在界面中触发了动作 "${action}"，请根据组件数据执行相应操作，并用 dsh-ui 输出更新后的界面。${data}`)
  }
  ctx.effect(() => () => lifetime.abort(), 'speak-plain: cancel client requests')
  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset.speakPlain = 'true'
    element.textContent = styles + '\n' + GENUI_CSS
    document.head.append(element)
    return () => element.remove()
  }, 'speak-plain: theme styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'speak-plain', order: 30, label: () => '说人话', inject: () => ({ call }),
  }, SpeakPlainSettings))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'speak-plain', order: 10, inject: () => ({ call, sendAction }),
  }, SpeakPlainTurnTail))

  // The collapse is done from the turn tail by hiding the sibling answer flow item
  // (see SpeakPlainTurnTail). We deliberately do NOT shadow the assistant-step
  // renderer here, keeping DSH's own answer rendering untouched.
}
