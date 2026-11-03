import {
  DEFAULT_SETTINGS, MAX_INPUT_CHARS, SYSTEM_PROMPT, findCandidate,
  hashText, modelInput, resultKey, withinDeadline,
} from './engine.js';

export class SpeakPlainService {
  constructor(ctx, tables, helpers) {
    this.ctx = ctx;
    this.tables = tables;
    this.helpers = helpers;
    this.lifetime = new AbortController();
    this.active = new Map();
  }
  /** Old records have no autoPolish field: only an explicit true enables automatic polishing. */
  settings() {
    const raw = this.tables.settings.get('global') ?? {};
    return { ...DEFAULT_SETTINGS, ...raw, autoPolish: raw.autoPolish === true };
  }
  dispose() { this.lifetime.abort(new Error('插件已停用')); }
  async snapshot(signal) {
    const providers = await Promise.all(this.ctx.llm.listProviders().map(async provider => {
      let models = [];
      try {
        models = await withinDeadline(s => this.ctx.llm.listModels(provider.id, s), signal, this.lifetime.signal, 5000);
      } catch {
        signal?.throwIfAborted();
      }
      return { id: provider.id, name: provider.name ?? provider.id, models: models.map(m => ({ id: m.id, name: m.name ?? m.id })) };
    }));
    return { settings: this.settings(), providers };
  }
  async saveSettings(settings, signal) {
    if (settings.enabled) {
      const snapshot = await this.snapshot(signal);
      const route = snapshot.providers.find(p => p.id === settings.provider);
      if (!route?.models.some(m => m.id === settings.model)) throw new Error('请选择 DSH 已配置且可用的渠道和模型');
    }
    signal?.throwIfAborted();
    await this.tables.settings.put('global', settings);
    return this.snapshot(signal);
  }
  getResult(sessionId, turn) {
    const key = resultKey(sessionId, turn);
    const result = this.tables.results.get(key) ?? null;
    const s = this.settings();
    const canManual = Boolean(s.enabled && s.provider && s.model && !s.autoPolish);    if (result?.status === 'pending' && !this.active.has(key)) {
      return { result: { ...result, status: 'failed', error: '上次润色已中断，原回答已保留' }, canManual };
    }
    return { result, canManual };
  }
  async stopping({ agent, turn, signal }) {
    try {
      // roots() reflects live ownership, unlike fork lineage which can belong to a user session.
      if (!this.ctx.agents.roots().some(root => root.id === agent.id)) return;
      const settings = this.settings();
      if (!settings.enabled || !settings.autoPolish || !settings.provider || !settings.model || signal.aborted || this.lifetime.signal.aborted) return;
      const candidate = findCandidate(agent.session.log, turn);
      if (!candidate) return;
      const key = resultKey(agent.id, turn);
      // The serial hook normally prevents reentry, but do not duplicate provider calls if another emitter reenters.
      if (this.active.has(key)) { await this.active.get(key); return; }
      const signature = hashText(JSON.stringify([candidate.messageId, candidate.text, settings]));
      const old = this.tables.results.get(key);
      if (old?.signature === signature && old.status !== 'pending') return;
      const operation = this.polish(agent.id, turn, candidate, settings, signature, signal);
      this.active.set(key, operation);
      try { await operation; } finally { this.active.delete(key); }
    } catch {
      // A secondary editing failure must not turn a successful primary answer into an agent error.
      this.ctx.logger.warn('[speak-plain] 润色处理未完成，原回答已保留');
    }
  }
  /** Manual polish for one turn (used when automatic polishing is off). */
  async manualPolish(sessionId, turn, signal) {
    const settings = this.settings();
    if (!settings.enabled || !settings.provider || !settings.model) throw new Error('请先在“设置 → 说人话”里选好渠道和模型并启用');
    const agent = this.ctx.agents.get(sessionId);
    if (!agent) throw new Error('对应会话当前不可用，无法润色这段回答');
    const candidate = findCandidate(agent.session.log, turn);
    if (!candidate) throw new Error('这一段没有可润色的最终回答');
    const key = resultKey(sessionId, turn);
    if (this.active.has(key)) { await this.active.get(key); }
    else {
      const signature = hashText(JSON.stringify([candidate.messageId, candidate.text, settings]));
      const operation = this.polish(sessionId, turn, candidate, settings, signature, signal);
      this.active.set(key, operation);
      try { await operation; } finally { this.active.delete(key); }
    }
    const result = this.getResult(sessionId, turn).result;
    if (result?.status === 'ready') return result;
    throw new Error(result?.error || '润色未完成，原回答已保留');
  }
  async polish(sessionId, turn, candidate, settings, signature, parentSignal) {
    const key = resultKey(sessionId, turn);
    const base = {
      sessionId, turn, originalMessageId: candidate.messageId, originalSeq: candidate.event.seq,
      provider: settings.provider, model: settings.model, signature,
    };
    const save = value => this.tables.results.put(key, { ...base, ...value, updatedAt: Date.now() });
    if (candidate.text.length > MAX_INPUT_CHARS) {
      await save({ status: 'skipped', error: '回答较长，MVP 暂不自动润色，原回答已保留' });
      return;
    }
    await save({ status: 'pending' });
    try {
      const result = await withinDeadline(async signal => {
        const { protectedContent, requestText } = modelInput(candidate, settings.preference);
        const assembler = new this.helpers.BlockAssembler();
        // This is an independent, tool-free call. It never creates or steers another Agent.
        const stream = this.ctx.llm.stream({
          provider: settings.provider, model: settings.model,
          system: SYSTEM_PROMPT,
          messages: [this.helpers.createUserMessage({ source: { kind: 'speak-plain' }, content: [{ type: 'text', text: requestText }] })],
          signal,
        });
        let receivedChars = 0;
        for await (const chunk of stream) {
          signal.throwIfAborted();
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            receivedChars += chunk.text.length;
            if (receivedChars > 200000) throw new Error('润色输出超过限制');
          }
          assembler.push(chunk);
        }
        signal.throwIfAborted();
        if (assembler.finish?.kind !== 'stop') throw new Error('润色模型未完整返回回答');
        const blocks = assembler.blocks();
        if (blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) > 200000) throw new Error('润色输出超过限制');
        if (blocks.some(block => block.type === 'tool-call')) throw new Error('润色模型返回了意外工具调用');
        const edited = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n');
        const text = protectedContent.restore(edited);
        return { text, ...(assembler.usage ? { usage: assembler.usage } : {}) };
      }, parentSignal, this.lifetime.signal, settings.timeoutMs);
      parentSignal.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      await save({ status: 'ready', ...result });
    } catch {
      if (this.lifetime.signal.aborted) return;
      await save({ status: 'failed', error: parentSignal.aborted ? '已取消润色，原回答已保留' : '润色未完成（超时、模型失败或内容保护检查未通过），原回答已保留' });
    }
  }
}
