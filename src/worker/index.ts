import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { callJev } from './jev';
import { adminIdentity, audit, consumeQuota, verifyTurnstile } from './security';
import { parseCSV, piiKinds, validateText, validateThreshold } from './validation';
import { cleanup, createRun, executeRun, getRun, presentRun, recoverStaleRuns, toRecord } from './runs';
import { summarize } from '../shared/metrics';
import { AppError, type Env } from './types';

const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
app.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: { code: 'ORIGIN_REJECTED', message: '不接受跨網站請求' } }, 403);
  }
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
});
app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 + 16384, onError: c => c.json({ error: { code: 'BODY_TOO_LARGE', message: '請求內容過大' } }, 413) }));
app.onError((e, c) => {
  const known = e instanceof AppError;
  // Do not log exception messages: upstream errors can contain sensitive request data.
  console.log(JSON.stringify({ event: 'request_error', code: known ? e.code : 'INTERNAL_ERROR', status: known ? e.status : 500 }));
  return c.json({ error: { code: known ? e.code : 'INTERNAL_ERROR', message: known ? e.message : '服務暫時無法使用，請稍後再試' } }, known ? e.status : 500);
});
async function jsonBody(request: Request) {
  try { return await request.json(); } catch { throw new AppError('VALIDATION_ERROR', 'JSON 格式不正確'); }
}
const classifySchema = z.object({ text: z.string(), token: z.string().optional() });
app.get('/api/config', c => c.json({ siteKey: c.env.TURNSTILE_SITE_KEY, threshold: 0.7, maxTextLength: 10000, hourlyLimit: Number(c.env.PUBLIC_HOURLY_LIMIT), dailyLimit: Number(c.env.PUBLIC_DAILY_LIMIT), localMock: c.env.ENVIRONMENT === 'local' && c.env.LOCAL_MOCK_JEV === 'true' }));
app.get('/api/health', c => c.json({ status: 'ok' }));
app.post('/api/classify', async c => {
  const started = performance.now();
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  let status = 'error';
  try {
    const parsed = classifySchema.safeParse(await jsonBody(c.req.raw));
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '請提供訊息文字');
    const text = validateText(parsed.data.text);
    if (!c.env.JEV_API_KEY && !(c.env.ENVIRONMENT === 'local' && c.env.LOCAL_MOCK_JEV === 'true')) throw new AppError('NOT_CONFIGURED', '判斷服務尚未設定', 503);
    await verifyTurnstile(parsed.data.token, c.req.raw, c.env);
    await consumeQuota(c.req.raw, c.env);
    const { result } = await callJev(c.env, text, AbortSignal.any([AbortSignal.timeout(45000), c.req.raw.signal]));
    usage = result.usage; status = 'success';
    return c.json({ ...result, threshold: 0.7 });
  } catch (e) { status = e instanceof AppError ? e.code : 'INTERNAL_ERROR'; throw e; }
  finally { await audit(c.env, 'anonymous', 'classify', status, null, Math.round(performance.now() - started), usage); }
});
app.use('/api/admin/*', async (c, next) => { c.set('actor', await adminIdentity(c.req.raw, c.env)); await next(); });
app.use('/admin', async (c, next) => { await adminIdentity(c.req.raw, c.env); await next(); });
app.use('/admin/*', async (c, next) => { await adminIdentity(c.req.raw, c.env); await next(); });
app.get('/api/admin/me', c => c.json({ email: c.get('actor') }));
app.post('/api/admin/classify', async c => {
  let status = 'error'; const started = performance.now();
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  try {
    const parsed = classifySchema.safeParse(await jsonBody(c.req.raw));
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '請提供訊息文字');
    const { result } = await callJev(c.env, validateText(parsed.data.text), AbortSignal.any([AbortSignal.timeout(45000), c.req.raw.signal]));
    status = 'success'; usage = result.usage; return c.json(result);
  } catch (e) { status = e instanceof AppError ? e.code : 'INTERNAL_ERROR'; throw e; }
  finally { await audit(c.env, c.get('actor'), 'admin_classify', status, null, Math.round(performance.now() - started), usage); }
});
app.post('/api/admin/runs', async c => {
  let form: FormData;
  try { form = await c.req.raw.formData(); } catch { throw new AppError('VALIDATION_ERROR', '請上傳 CSV 檔案'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new AppError('VALIDATION_ERROR', '請上傳 CSV 檔案');
  if (file.size > 1024 * 1024) throw new AppError('VALIDATION_ERROR', 'CSV 不可超過 1 MB', 413);
  const threshold = validateThreshold(Number(form.get('threshold') ?? 0.7));
  const name = file.name.slice(0, 150);
  if (piiKinds(name).length) throw new AppError('PII_DETECTED', '檔名含疑似個資，請先重新命名');
  let csv: string;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new AppError('VALIDATION_ERROR', 'CSV 請使用 UTF-8 編碼'); }
  const id = await createRun(c.env, parseCSV(csv), name, threshold, c.get('actor'), csv);
  return c.json({ run_id: id }, 201);
});
app.post('/api/admin/runs/:id/execute', async c => c.json(await executeRun(c.env, c.req.param('id'), c.get('actor'), c.req.raw.signal)));
app.get('/api/admin/runs', async c => {
  await recoverStaleRuns(c.env);
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page'))) || 1));
  const { results } = await c.env.DB.prepare('SELECT * FROM runs ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?').bind((page - 1) * 20).all<Parameters<typeof presentRun>[0]>();
  return c.json({ items: results.map(presentRun), page, has_more: results.length === 20 });
});
app.get('/api/admin/runs/:id', async c => {
  await recoverStaleRuns(c.env);
  return c.json(presentRun(await getRun(c.env, c.req.param('id'))));
});
app.patch('/api/admin/runs/:id/threshold', async c => {
  const run = await getRun(c.env, c.req.param('id'));
  if (run.status === 'running' || run.status === 'queued') throw new AppError('RUN_NOT_FINISHED', '請等待評估結束後調整門檻', 409);
  const input = z.object({ threshold: z.number() }).safeParse(await jsonBody(c.req.raw));
  if (!input.success) throw new AppError('VALIDATION_ERROR', '請提供門檻');
  const threshold = validateThreshold(input.data.threshold);
  const { results } = await c.env.DB.prepare('SELECT * FROM results WHERE run_id=?').bind(run.id).all<Parameters<typeof toRecord>[0]>();
  const summary = summarize(results.map(toRecord), threshold);
  await c.env.DB.prepare('UPDATE runs SET threshold=?,summary_json=? WHERE id=?').bind(threshold, JSON.stringify(summary), run.id).run();
  await audit(c.env, c.get('actor'), 'change_threshold', 'success', run.id);
  return c.json(presentRun(await getRun(c.env, run.id)));
});
app.get('/api/admin/runs/:id/results', async c => {
  const run = await getRun(c.env, c.req.param('id'));
  const conditions = ['run_id=?']; const params: (string | number)[] = [run.id];
  const label = c.req.query('label');
  if (label) { if (!['scam', 'legit'].includes(label)) throw new AppError('VALIDATION_ERROR', 'label 必須為 scam 或 legit'); conditions.push('label=?'); params.push(label); }
  if (c.req.query('misses') === '1') { conditions.push("label='scam' AND error IS NULL AND p_scam < ?"); params.push(run.threshold); }
  if (c.req.query('false_positives') === '1') { conditions.push("label='legit' AND error IS NULL AND p_scam >= ?"); params.push(run.threshold); }
  const page = Math.max(1, Math.min(100000, Math.floor(Number(c.req.query('page'))) || 1));
  const { results } = await c.env.DB.prepare(`SELECT * FROM results WHERE ${conditions.join(' AND ')} ORDER BY sample_id LIMIT 50 OFFSET ?`).bind(...params, (page - 1) * 50).all();
  return c.json({ items: results.map(r => ({ ...r, probabilities: r.probs_json ? JSON.parse(String(r.probs_json)) : null, signals: r.signals_json ? JSON.parse(String(r.signals_json)) : null, probs_json: undefined, signals_json: undefined })), page, has_more: results.length === 50 });
});
app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND', message: '找不到此功能' } }, 404));
app.get('*', c => c.env.ASSETS.fetch(c.req.raw));
export default { fetch: app.fetch, async scheduled(_event: ScheduledController, env: Env) { await cleanup(env); } };
