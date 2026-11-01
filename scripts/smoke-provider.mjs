// Deterministic, local-only provider used exclusively by the isolated smoke profile.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

export const name = 'speak-plain-smoke-provider';
export const inject = ['llm', 'agents', 'storageDomain', 'speakPlain'];
export async function apply(ctx) {
  let mainCalls = 0, editCalls = 0, auxiliaryCalls = 0;
  const requests = [];
  class LocalProvider extends LlmAdapter {
    async listModels() { return [{ id: 'local-main', name: 'Local Main' }, { id: 'local-editor', name: 'Local Editor' }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128000 }, defaultMaxTokens: 8000 }; }
    async *stream(request) {
      let text;
      requests.push({ model: request.model, purpose: request.purpose ?? 'conversation' });
      if (request.purpose) {
        auxiliaryCalls++;
        text = '本地润色功能验证';
      } else if (request.model === 'local-editor') {
        editCalls++;
        assert.equal(request.tools, undefined);
        const input = JSON.parse(request.messages.at(-1).content[0].text);
        assert.match(input.question, /验证润色/);
        assert.ok(!input.answer.includes('echo hello'));
        assert.ok(!input.answer.includes('"type":"keyvalue"'));
        text = input.answer.replace('多层约束之间存在冲突，导致表达别扭。', '要求太多，有些互相打架，所以回答很别扭。');
      } else {
        mainCalls++;
        text = '多层约束之间存在冲突，导致表达别扭。\n\n```sh\necho hello\n```\n\n```dsh-ui\n{"items":[{"type":"keyvalue","pairs":[{"key":"润色","value":"正常"}]}]}\n```';
      }
      await writeFile(new URL('../.smoke/model-calls.json', import.meta.url), JSON.stringify({ mainCalls, editCalls, auxiliaryCalls, requests, model: request.model, text }, null, 2));
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 40 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['speak-plain-local-test'], new LocalProvider());
  await ctx.storageDomain.get('speak_plain').table('settings').put('global', {
    enabled: true, provider: 'speak-plain-local-test', model: 'local-editor',
    preference: '用大白话说明', timeoutMs: 10000,
  });
}
