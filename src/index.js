import { z } from 'zod';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { SpeakPlainService } from './service.js';

async function appendDebug(message) {
  try {
    const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'speak-plain-client.log');
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${new Date().toISOString()} ${message}\n`);
  } catch { /* diagnostics must never fail a request */ }
}

export const name = 'speak-plain';
export const inject = ['agents', 'llm', 'storageDomain'];
export const settingsSchema = z.object({
  enabled: z.boolean(), provider: z.string().max(500), model: z.string().max(500),
  preference: z.string().max(6000), timeoutMs: z.number().int().min(5000).max(180000),
}).strict();
const resultSchema = z.object({
  sessionId: z.string(), turn: z.number().int().nonnegative(),
  originalMessageId: z.string(), originalSeq: z.number().int().nonnegative(),
  provider: z.string(), model: z.string(), signature: z.string(),
  status: z.enum(['pending', 'ready', 'failed', 'skipped']),
  updatedAt: z.number(), text: z.string().optional(), error: z.string().optional(),
  // Usage is adapter-reported and stored separately from the primary answer's accounting.
  usage: z.record(z.string(), z.unknown()).optional(),
});
export const domainSpec = defineDomain({
  name: 'speak_plain', version: 0,
  tables: { settings: domainTable(settingsSchema), results: domainTable(resultSchema) },
});

const rpcSchema = z.object({
  type: z.literal('client-request'), rpcId: z.string().min(1).max(200),
  method: z.literal('speakPlain'),
  payload: z.object({ endpoint: z.string(), payload: z.unknown().optional() }).strict(),
}).strict();

export function createFetchHandler(service) {
  return async request => {
    let parsed;
    try { parsed = rpcSchema.safeParse(await request.json()); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!parsed.success) return new Response('Invalid RPC envelope', { status: 400 });
    const { rpcId, payload: { endpoint, payload } } = parsed.data;
    let result;
    try {
      request.signal.throwIfAborted();
      let value;
      if (endpoint === 'snapshot') value = await service.snapshot(request.signal);
      else if (endpoint === 'settings/save') value = await service.saveSettings(settingsSchema.parse(payload), request.signal);
      else if (endpoint === 'result/get') {
        const input = z.object({ sessionId: z.string().min(1).max(500), turn: z.number().int().nonnegative() }).strict().parse(payload);
        value = service.getResult(input.sessionId, input.turn);
      } else if (endpoint === 'debug') {
        const input = z.object({ message: z.string().max(4000) }).strict().parse(payload);
        await appendDebug(input.message);
        value = { ok: true };
      } else throw new Error('未知插件操作');
      result = { ok: true, value };
    } catch (error) {
      result = { ok: false, error: { code: 'speak-plain-error', message: error instanceof z.ZodError ? '设置或请求格式不正确' : (error?.message === '请选择 DSH 已配置且可用的渠道和模型' ? error.message : '操作未完成，请检查 DSH 连接后重试') } };
    }
    return Response.json({ type: 'server-response', rpcId, result });
  };
}

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(domainSpec);
  const service = new SpeakPlainService(ctx, {
    settings: domain.table('settings'), results: domain.table('results'),
  }, { BlockAssembler, createUserMessage });
  ctx.effect(() => () => { service.dispose(); return domain.close(); }, 'speak-plain: close service and storage');
  // Connection owns the authenticated /api carrier; no independent HTTP server or credentials.
  ctx.inject(['connection'], connectionCtx => connectionCtx.connection.fetch.register({
    path: '/api/speakPlain', methods: ['POST'], requestBody: 'buffered',
    fetch: createFetchHandler(service),
  }));
  ctx.on('agent/turn-stopping', payload => service.stopping(payload));
  ctx.provide('speakPlain', service);
  ctx.logger.info('[speak-plain] 已加载，在设置 → 说人话中选择润色模型后启用');
}
