import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { DEFAULT_SETTINGS, findCandidate, protectContent, withinDeadline } from '../src/engine.js';
import { SpeakPlainService } from '../src/service.js';
import { createFetchHandler } from '../src/index.js';

function table() {
  const data = new Map();
  return { get: key => data.get(key), put: async (key, value) => { data.set(key, structuredClone(value)); }, data };
}
function agent(id = 's1', text = '多层约束之间存在冲突，导致表达别扭。', overrides = {}) {
  const message = { id: `${id}-message`, role: 'assistant', source: { provider: 'main', model: 'main-model' }, content: [{ type: 'text', text }] };
  const event = { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message,
    stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }], ...overrides } };
  return { id, session: { log: [
    { type: 'user/message', seq: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '为什么回答别扭？' }] } },
    { type: 'user/message', seq: 2, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '不要把运行信息当问题' }] } }, event,
  ] } };
}
function fixture(options = {}) {
  const settings = table(), results = table();
  settings.data.set('global', { ...DEFAULT_SETTINGS, enabled: true, autoPolish: true, provider: 'editor', model: 'plain', timeoutMs: 5000, ...options.settings });
  const agents = options.agents ?? [agent()];
  const calls = [];
  const ctx = {
    agents: {
      roots: () => options.roots ?? agents,
      get: id => (options.roots ?? agents).find(a => a.id === id),
    },
    logger: { warn() {} },
    llm: {
      listProviders: () => [{ id: 'editor', name: '编辑渠道' }],
      listModels: async () => [{ id: 'plain', name: '白话模型' }],
      stream: request => {
        calls.push(request);
        return (async function* () {
          const input = JSON.parse(request.messages[0].content[0].text);
          if (options.stream) { yield* options.stream(request, input); return; }
          yield { type: 'text-delta', index: 0, text: input.answer.replace('多层约束之间存在冲突，导致表达别扭。', '要求太多，有些还互相打架，所以回答很别扭。') };
          yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 15 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  const service = new SpeakPlainService(ctx, { settings, results }, { BlockAssembler, createUserMessage });
  return { service, settings, results, agents, calls, ctx,
    stop: (a = agents[0], signal = new AbortController().signal) => service.stopping({ agent: a, turn: 1, signal }) };
}

test('selects successful last text and real user question using installed event shapes', () => {
  const a = agent();
  const c = findCandidate(a.session.log, 1);
  assert.equal(c.question, '为什么回答别扭？');
  assert.equal(c.messageId, 's1-message');
  assert.equal(findCandidate(a.session.log, 2), null);
  for (const kind of ['max-tokens', 'aborted', 'error', 'tool-calls']) {
    a.session.log[2].data.stream[0].chunk.reason.kind = kind;
    assert.equal(findCandidate(a.session.log, 1), null);
  }
});
test('does not polish tool requests or interrupted answers', () => {
  const a = agent();
  a.session.log[2].data.message.content.push({ type: 'tool-call', id: 't1', name: 'read', arguments: {} });
  assert.equal(findCandidate(a.session.log, 1), null);
  assert.equal(findCandidate(agent('s2', 'text', { interrupted: true }).session.log, 1), null);
});
test('round trips fenced blocks, inline commands, links, and GenUI without model rewriting them', () => {
  const source = '说明\n```sh\nrm -rf ./example\n```\n`x=1` [文件](C:/a/b.ts) https://example.com/x\n~~~dsh-ui\n{"items":[]}\n~~~\n';
  const protectedContent = protectContent(source);
  assert.ok(!protectedContent.text.includes('rm -rf'));
  assert.ok(!protectedContent.text.includes('example.com'));
  assert.equal(protectedContent.restore(protectedContent.text.replace('说明', '白话')), source.replace('说明', '白话'));
  assert.throws(() => protectedContent.restore('丢失标记'), /保留/);
  assert.throws(() => protectedContent.restore(protectedContent.text + protectedContent.text), /保留/);
});
test('unclosed code fence and longer closing fence are protected', () => {
  for (const source of ['前言\n```js\nunfinished', '前言\n```js\nx=1\n````\n后文']) {
    const p = protectContent(source);
    assert.equal(p.restore(p.text), source);
    assert.ok(!p.text.includes('x=1'));
  }
});
test('nested link/code syntax and indented or quoted code never create nested protection tokens', () => {
  for (const source of ['[`x`](https://example.com)', '`[x](https://example.com)`', '> ```js\n> x=1\n> ```', '    code()\n    keep()', '- ```js\n  x=1\n  ```']) {
    const p = protectContent(source);
    assert.equal(p.restore(p.text), source);
    assert.ok(!p.text.includes('x=1'));
    assert.ok(!p.text.includes('code()'));
  }
});
test('independent model request, durable result, original unchanged, and duplicate hooks cost only once', async () => {
  const f = fixture();
  const original = structuredClone(f.agents[0].session.log);
  await Promise.all([f.stop(), f.stop()]);
  await f.stop();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].provider, 'editor');
  assert.equal(f.calls[0].tools, undefined);
  assert.equal(f.calls[0].sessionId, undefined);
  assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).question, '为什么回答别扭？');
  const result = f.service.getResult('s1', 1).result;
  assert.equal(result.status, 'ready');
  assert.match(result.text, /要求太多/);
  assert.equal(result.originalSeq, 3);
  assert.deepEqual(f.agents[0].session.log, original);
  const resumed = new SpeakPlainService(f.ctx, { settings: f.settings, results: f.results }, { BlockAssembler, createUserMessage });
  assert.deepEqual(resumed.getResult('s1', 1).result, result);
});
test('disabled, root exclusion and oversized input do not call provider', async () => {
  const disabled = fixture({ settings: { enabled: false } }); await disabled.stop(); assert.equal(disabled.calls.length, 0);
  const child = fixture({ roots: [] }); await child.stop(); assert.equal(child.calls.length, 0);
  const large = fixture({ agents: [agent('long', '字'.repeat(60001))] }); await large.stop();
  assert.equal(large.calls.length, 0); assert.equal(large.service.getResult('long', 1).result.status, 'skipped');
});
test('finish error (not just thrown error), empty result, tool result and lost code all fail safely', async () => {
  const streams = [
    async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'secret upstream detail' } } }; },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; },
    async function* () { throw new Error('secret upstream detail'); },
    async function* () { yield { type: 'text-delta', index: 0, text: '删掉代码了' }; yield { type: 'finish', reason: { kind: 'stop' } }; },
  ];
  for (const stream of streams) {
    const f = fixture({ agents: [agent('s1', '正文 `echo hi`')], stream });
    await assert.doesNotReject(f.stop());
    const record = f.service.getResult('s1', 1).result;
    assert.equal(record.status, 'failed');
    assert.ok(!record.error.includes('secret'));
  }
});
test('deadline and cancellation finish even when provider ignores abort, without late success', async () => {
  const f = fixture({ settings: { timeoutMs: 20 }, stream: async function* () { await new Promise(() => {}); } });
  await f.stop();
  assert.equal(f.service.getResult('s1', 1).result.status, 'failed');
  const controller = new AbortController();
  const cancelled = fixture({ stream: async function* () { await new Promise(() => {}); } });
  const pending = cancelled.stop(cancelled.agents[0], controller.signal);
  controller.abort(); await pending;
  assert.equal(cancelled.service.getResult('s1', 1).result.status, 'failed');
});
test('concurrent sessions keep their own results', async () => {
  const f = fixture({ agents: [agent('a', '甲答案'), agent('b', '乙答案')] });
  await Promise.all(f.agents.map(a => f.stop(a)));
  assert.equal(f.service.getResult('a', 1).result.text, '甲答案');
  assert.equal(f.service.getResult('b', 1).result.text, '乙答案');
});
test('settings validate selected provider and persist only successful saves', async () => {
  const f = fixture();
  await assert.rejects(f.service.saveSettings({ ...f.service.settings(), model: 'missing' }), /请选择/);
  assert.equal(f.service.settings().model, 'plain');
  await f.service.saveSettings({ ...f.service.settings(), preference: '别写报告' });
  assert.equal(f.service.settings().preference, '别写报告');
});
test('RPC envelope, schema validation and result response match Connection protocol', async () => {
  const f = fixture();
  const handler = createFetchHandler(f.service);
  const call = async (endpoint, payload) => {
    const response = await handler(new Request('http://local/api/speakPlain', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test-1', method: 'speakPlain', payload: { endpoint, payload } }) }));
    return response.json();
  };
  const snapshot = await call('snapshot', {});
  assert.equal(snapshot.type, 'server-response'); assert.equal(snapshot.rpcId, 'test-1'); assert.equal(snapshot.result.ok, true);
  assert.equal((await call('settings/save', { enabled: 'yes' })).result.ok, false);
  assert.equal((await call('result/get', { sessionId: 's1', turn: 1 })).result.value.result, null);
  assert.equal((await call('result/get', { sessionId: 's1', turn: -1 })).result.ok, false);
  assert.equal((await handler(new Request('http://local', { method: 'POST', body: '{' }))).status, 400);
});
test('autoPolish off: stopping does nothing, canManual true, manual polish runs on demand', async () => {
  const f = fixture({ settings: { autoPolish: false } });
  await f.stop();
  assert.equal(f.calls.length, 0, 'auto off must not call the model');
  assert.equal(f.service.getResult('s1', 1).canManual, true);
  await f.service.manualPolish('s1', 1, new AbortController().signal);
  let record = null;
  for (let i = 0; i < 100; i++) {
    record = f.service.getResult('s1', 1).result;
    if (record && record.status !== 'pending') break;
    await new Promise(res => setTimeout(res, 5));
  }
  assert.equal(f.calls.length, 1, 'manual polish should call once');
  assert.equal(record.status, 'ready');
  assert.match(record.text, /要求太多/);
});
test('legacy settings without autoPolish (missing or null) are treated as manual mode', () => {
  for (const legacy of [undefined, null]) {
    const f = fixture({ settings: { autoPolish: legacy } });
    if (legacy === undefined) delete f.settings.data.get('global').autoPolish;
    assert.equal(f.service.settings().autoPolish, false, `autoPolish=${String(legacy)} must not auto-run`);
    assert.equal(f.service.getResult('s1', 1).canManual, true);
  }
});
test('autoPolish on: canManual false and stopping polishes automatically', async () => {
  const f = fixture();
  await f.stop();
  const got = f.service.getResult('s1', 1);
  assert.equal(got.canManual, false);
  assert.equal(got.result.status, 'ready');
});
