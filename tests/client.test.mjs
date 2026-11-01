import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_SETTINGS } from '../src/engine.js';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'localStorage', 'MutationObserver', 'DOMParser', 'ResizeObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
let client;
window.__ModuleLoader__ = { load({ id, factory }) {
  assert.equal(id, 'dsh-speak-plain');
  client = factory(id => id === '@deepseek-ai/dsh-client-ui-primitives'
    ? {
      MarkdownText: ({ text }) => React.createElement('pre', { 'data-markdown': true }, text),
      CodeBlock: ({ code, lang }) => React.createElement('pre', { 'data-code-lang': lang }, code),
      DiffBlock: () => React.createElement('pre', null, 'diff'),
      JsonTree: ({ value }) => React.createElement('pre', null, JSON.stringify(value)),
      writeClipboard: async text => navigator.clipboard?.writeText(text),
    }
    : require(id));
} };
vm.runInThisContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
after(() => browser.close());
const flush = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
async function mount(Component, props) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async p => { await act(async () => root.render(React.createElement(Component, p))); await flush(); };
  await render(props);
  return { container, render, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const ready = (sessionId = 'a', text = '你给的要求互相打架。', seq = 9) => ({ status: 'ready', sessionId, turn: 1, originalSeq: seq, model: 'plain', text });
const turnProps = call => ({ call, sessionId: 'a', turn: { turn: 1, status: 'closed' }, seq: 9 });

test('real ModuleLoader bundle registers additive settings/tail entries and cleans up styles', async () => {
  const entries = [], cleanups = [], sent = [];
  const ctx = {
    get: name => name === 'sessions'
      ? { scope: sessionId => ({ get: () => ({ send: async text => sent.push({ sessionId, text }) }) }) }
      : { rpc: { call: async () => ({ ok: true, value: {} }) } },
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); },
    slots: { inject: (_, setup) => setup(), register: (entry, Component) => { entries.push({ entry, Component }); } },
  };
  client.apply(ctx);
  assert.deepEqual(entries.map(e => e.entry.name), ['settings.section', 'conversation.chat.turnTail']);
  assert.ok(document.head.querySelector('style[data-speak-plain]'));
  assert.ok(!document.head.querySelector('style[data-speak-plain]').textContent.includes('__DSH_SPEAK_PLAIN_GENUI_CSS_TEXT__'));
  const call = entries[0].entry.inject().call;
  await call('snapshot', {});
  await entries[1].entry.inject().sendAction('answer-session', 'approve', { selected: 'a' });
  assert.equal(sent[0].sessionId, 'answer-session');
  assert.match(sent[0].text, /\[genui-action\] approve/);
  assert.match(sent[0].text, /"selected":"a"/);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(document.head.querySelector('style[data-speak-plain]'), null);
  await assert.rejects(call('snapshot', {}));
});
test('settings load model choices and save the complete settings payload', async () => {
  const snapshot = { settings: { ...DEFAULT_SETTINGS, enabled: true, provider: 'editor', model: 'plain' }, providers: [{ id: 'editor', name: '编辑渠道', models: [{ id: 'plain', name: '白话模型' }] }] };
  const calls = [];
  const ui = await mount(client.SpeakPlainSettings, { call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return snapshot; } });
  try {
    assert.match(ui.container.textContent, /说人话/);
    assert.match(ui.container.querySelectorAll('select')[0].textContent, /编辑渠道/);
    assert.match(ui.container.querySelectorAll('select')[1].textContent, /白话模型/);
    await act(async () => ui.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(calls[1].endpoint, 'settings/save');
    assert.deepEqual(calls[1].payload, snapshot.settings);
    assert.match(ui.container.textContent, /已保存/);
  } finally { await ui.close(); }
});
test('failed initial settings load cannot overwrite saved settings with empty defaults', async () => {
  const ui = await mount(client.SpeakPlainSettings, { call: async () => { throw new Error('offline'); } });
  try { assert.equal(ui.container.querySelector('form'), null); assert.match(ui.container.textContent, /无法读取设置/); }
  finally { await ui.close(); }
});
test('closed turn fetches once, renders formatted text safely and can fold it', async () => {
  let count = 0;
  const call = async () => { count++; return { result: ready('a', '<script>danger()</script>\n```sh\necho hi\n```') }; };
  const props = turnProps(call);
  const ui = await mount(client.SpeakPlainTurnTail, props);
  try {
    assert.equal(count, 1);
    assert.match(ui.container.querySelector('[data-markdown]').textContent, /echo hi/);
    assert.equal(ui.container.querySelector('script'), null);
    await ui.render({ ...props }); assert.equal(count, 1);
    const contentNode = ui.container.querySelector('[data-markdown]');
    await act(async () => ui.container.querySelector('button[aria-expanded]').click());
    assert.equal(ui.container.querySelector('.speak-plain-result').hidden, true);
    assert.equal(ui.container.querySelector('[data-markdown]'), contentNode);
  } finally { await ui.close(); }
});
test('does not request data for an open turn and ignores a stale original sequence', async () => {
  let count = 0;
  const call = async () => { count++; return { result: ready('a', 'old', 8) }; };
  const ui = await mount(client.SpeakPlainTurnTail, { ...turnProps(call), turn: { turn: 1, status: 'open' } });
  try {
    assert.equal(count, 0);
    await ui.render(turnProps(call));
    assert.equal(count, 1); assert.equal(ui.container.textContent, '');
  } finally { await ui.close(); }
});
test('switching session aborts slow old request and never mixes session results', async () => {
  let resolveA, signalA;
  const call = (_, payload, signal) => {
    if (payload.sessionId === 'a') { signalA = signal; return new Promise(resolve => { resolveA = resolve; }); }
    return Promise.resolve({ result: ready('b', '乙会话') });
  };
  const ui = await mount(client.SpeakPlainTurnTail, turnProps(call));
  try {
    await ui.render({ ...turnProps(call), sessionId: 'b' });
    assert.ok(signalA.aborted);
    assert.match(ui.container.textContent, /乙会话/);
    await act(async () => resolveA({ result: ready('a', '甲会话迟到') }));
    await flush();
    assert.ok(!ui.container.textContent.includes('甲会话'));
    assert.match(ui.container.textContent, /乙会话/);
  } finally { await ui.close(); }
});
test('null history is quiet; provider failure explains fallback to original', async () => {
  const empty = await mount(client.SpeakPlainTurnTail, turnProps(async () => ({ result: null })));
  assert.equal(empty.container.textContent, ''); await empty.close();
  const failed = await mount(client.SpeakPlainTurnTail, turnProps(async () => ({ result: { ...ready(), status: 'failed', error: '已超时' } })));
  assert.match(failed.container.textContent, /原回答仍保留/); await failed.close();
});

const fence = spec => '```dsh-ui\n' + JSON.stringify(spec) + '\n```';
test('real GenUI embed renders preserved keyvalue cards instead of JSON code', async () => {
  const text = fence({ items: [{ type: 'keyvalue', pairs: [{ key: '润色开关', value: '已开启' }] }] });
  const ui = await mount(client.SpeakPlainTurnTail, turnProps(async () => ({ result: ready('a', text) })));
  try {
    assert.ok(ui.container.querySelector('[data-genui]'));
    assert.match(ui.container.textContent, /润色开关/);
    assert.match(ui.container.textContent, /已开启/);
    assert.equal(ui.container.querySelector('[data-markdown]'), null);
  } finally { await ui.close(); }
});
test('real GenUI action button sends only to its own answer session after a click', async () => {
  const actions = [];
  const text = fence({ items: [{ type: 'button', label: '确认操作', action: 'approve' }] });
  const props = { ...turnProps(async () => ({ result: ready('a', text) })), sendAction: async (...args) => actions.push(args) };
  const ui = await mount(client.SpeakPlainTurnTail, props);
  try {
    assert.equal(actions.length, 0);
    const button = [...ui.container.querySelectorAll('button')].find(b => b.textContent === '确认操作');
    assert.ok(button); assert.equal(button.disabled, false);
    await act(async () => button.click()); await flush();
    assert.equal(actions.length, 1);
    assert.equal(actions[0][0], 'a'); assert.equal(actions[0][1], 'approve');
  } finally { await ui.close(); }
});
test('panel fences are not published again and malformed JSON keeps visible source', async () => {
  const panel = await mount(client.SpeakPlainContent, { text: fence({ panel: true, append: true, items: [{ type: 'text', text: '面板内容' }] }), sessionId: 'a', messageId: 'm1', originalSeq: 9 });
  try {
    assert.ok(panel.container.querySelector('[data-speak-plain-panel-reference]'));
    assert.equal(panel.container.querySelector('[data-genui]'), null);
  } finally { await panel.close(); }
  const invalid = await mount(client.SpeakPlainContent, { text: '```dsh-ui\n{broken}\n```', sessionId: 'a', messageId: 'm2', originalSeq: 10 });
  try {
    assert.match(invalid.container.textContent, /无法解析/);
    assert.match(invalid.container.querySelector('[data-markdown]').textContent, /broken/);
  } finally { await invalid.close(); }
});

test('assistant shadow collapses only the polished turn-final answer and delegates the rest', async () => {
  const Default = () => React.createElement('div', { 'data-default': true }, '原回答内容');
  const make = result => client.createAssistantShadow({ Default, call: async () => ({ result }) });
  const props = (over = {}) => ({
    node: { location: { kind: 'step', turn: { turn: 3, status: 'closed' } }, data: { status: 'settled', finalNode: { seq: 5 } } },
    sessionId: 's',
    useTurnData: key => key === 'turn-tail' ? { closing: { finalNode: { seq: 5 } } } : undefined,
    ...over,
  });
  // ready + matching final seq -> collapsed details showing the original
  const ui = await mount(make({ status: 'ready', originalSeq: 5 }), props());
  await flush(); await flush();
  try {
    const details = ui.container.querySelector('details.speak-plain-original');
    assert.ok(details, 'final polished answer should collapse the original');
    assert.equal(details.open, false);
    assert.match(ui.container.querySelector('summary').textContent, /查看原回答/);
    assert.ok(ui.container.querySelector('[data-default]'), 'original must still render inside details');
  } finally { await ui.close(); }
  // no polished record -> plain default, not hidden
  const none = await mount(make(null), props());
  try { assert.equal(none.container.querySelector('details'), null); assert.ok(none.container.querySelector('[data-default]')); }
  finally { await none.close(); }
  // a diagnostic-only / mismatched seq -> do not collapse
  const stale = await mount(make({ status: 'ready', originalSeq: 5 }), props({ useTurnData: k => k === 'turn-tail' ? { closing: { finalNode: { seq: 9 } } } : undefined }));
  try { assert.equal(stale.container.querySelector('details'), null); }
  finally { await stale.close(); }
  // still running -> default, not hidden
  const running = await mount(make({ status: 'ready', originalSeq: 5 }), props({ node: { location: { kind: 'step', turn: { turn: 3, status: 'open' } }, data: { status: 'running' } } }));
  try { assert.equal(running.container.querySelector('details'), null); }
  finally { await running.close(); }
  // intermediate tool step (tail closing points elsewhere) -> default, not hidden
  const mid = await mount(make({ status: 'ready', originalSeq: 5 }), props({ node: { location: { kind: 'step', turn: { turn: 3, status: 'closed' } }, data: { status: 'settled', finalNode: { seq: 2 } } } }));
  try { assert.equal(mid.container.querySelector('details'), null); }
  finally { await mid.close(); }
});

test('turn tail hides the sibling assistant-step answer row and can reveal it', async () => {
  const flow = document.createElement('div'); flow.setAttribute('data-slot', 'conversation.chat.flow');
  const user = document.createElement('div'); user.setAttribute('data-chat-flow-kind', 'user');
  const ans = document.createElement('div'); ans.setAttribute('data-chat-flow-kind', 'assistant-step'); ans.textContent = '原回答正文';
  const tail = document.createElement('div'); tail.setAttribute('data-chat-flow-kind', 'turn-tail');
  flow.append(user, ans, tail); document.body.append(flow);
  const call = async endpoint => endpoint === 'debug' ? { ok: true } : { result: ready('a', '润色后的正文') };
  const root = createRoot(tail);
  await act(async () => root.render(React.createElement(client.SpeakPlainTurnTail, { call, sessionId: 'a', turn: { turn: 1, status: 'closed' }, seq: 9 })));
  await flush(); await flush();
  try {
    assert.ok(ans.hasAttribute('data-speak-plain-hidden'), 'answer row should start hidden');
    assert.match(tail.textContent, /润色后的正文/);
    const reveal = [...tail.querySelectorAll('button')].find(b => b.textContent === '查看原回答');
    assert.ok(reveal, 'reveal button should exist');
    await act(async () => reveal.click()); await flush();
    assert.equal(ans.hasAttribute('data-speak-plain-hidden'), false, 'reveal shows the real original');
    const hide = [...tail.querySelectorAll('button')].find(b => b.textContent === '收起原回答');
    await act(async () => hide.click()); await flush();
    assert.ok(ans.hasAttribute('data-speak-plain-hidden'), 'collapse hides it again');
  } finally {
    await act(async () => root.unmount());
    flow.remove();
  }
  assert.equal(ans.hasAttribute('data-speak-plain-hidden'), false, 'unmount restores the original row');
});
