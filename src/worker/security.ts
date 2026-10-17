import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, isLocal, type Env } from './types';
export async function adminIdentity(request: Request, env: Env): Promise<string> {
  if (isLocal(env, request.url) && env.LOCAL_ADMIN_EMAIL) return env.LOCAL_ADMIN_EMAIL;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new AppError('UNAUTHORIZED', '請先透過內部登入入口驗證身分', 401);
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'] });
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('identity');
    return payload.email;
  } catch { throw new AppError('UNAUTHORIZED', '登入憑證無效或已過期', 401); }
}
export async function verifyTurnstile(token: unknown, request: Request, env: Env, requestFetch: typeof fetch = fetch) {
  if (typeof token !== 'string' || !token || token.length > 2048) throw new AppError('TURNSTILE_FAILED', '請先完成人機驗證', 403);
  if (!env.TURNSTILE_SECRET) throw new AppError('NOT_CONFIGURED', '人機驗證尚未設定', 503);
  const dummySecret = /^[123]x0+AA$/.test(env.TURNSTILE_SECRET);
  if (['staging', 'production'].includes(env.ENVIRONMENT) && (dummySecret || /^[123]x0+[A-Z]{2}$/.test(env.TURNSTILE_SITE_KEY))) throw new AppError('NOT_CONFIGURED', '正式環境不可使用人機驗證測試金鑰', 503);
  try {
    const r = await requestFetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') ?? undefined }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000) });
    const v = await r.json() as { success?: boolean; action?: string; hostname?: string };
    const hosts = env.EXPECTED_HOSTNAMES.split(',').map(s => s.trim()).filter(Boolean);
    if (!isLocal(env) && hosts.some(h => h === 'localhost' || h === '127.0.0.1')) throw new AppError('NOT_CONFIGURED', '驗證網域設定不正確', 503);
    // Official dummy keys currently return example.com without an action; the docs also show localhost/test.
    // Accept only these explicit test shapes, only for the exact dummy token, only on localhost.
    const localDummy = isLocal(env, request.url) && dummySecret && token === 'XXXX.DUMMY.TOKEN.XXXX';
    const contextMatches = localDummy
      ? (v.hostname === 'example.com' && v.action === undefined) || (!!v.hostname && hosts.includes(v.hostname) && ['test', 'classify'].includes(v.action ?? ''))
      : v.action === 'classify' && !!v.hostname && hosts.includes(v.hostname);
    if (!r.ok || v.success !== true || !contextMatches) throw new AppError('TURNSTILE_FAILED', '人機驗證無效或已過期，請重新驗證', 403);
  } catch (e) { if (e instanceof AppError) throw e; throw new AppError('TURNSTILE_UNAVAILABLE', '人機驗證暫時無法使用', 503); }
}
export async function consumeQuota(request: Request, env: Env, now = new Date()) {
  if (!env.RATE_LIMIT_SECRET) throw new AppError('NOT_CONFIGURED', '查詢額度尚未設定', 503);
  const ip = request.headers.get('CF-Connecting-IP') ?? (isLocal(env, request.url) ? 'local' : '');
  if (!ip) throw new AppError('INVALID_CLIENT', '無法確認連線來源', 403);
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const hour = now.toISOString().slice(0, 13);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RATE_LIMIT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${hour}:${ip}`)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const ipKey = `ip:${hash}:${hour}`, dayKey = `day:${day}`, expires = new Date(now.getTime() + 48 * 3600000).toISOString();
  const hourly = Number(env.PUBLIC_HOURLY_LIMIT), daily = Number(env.PUBLIC_DAILY_LIMIT);
  if (![hourly, daily].every(n => Number.isSafeInteger(n) && n > 0)) throw new AppError('NOT_CONFIGURED', '查詢額度設定不正確', 503);
  // The conditional insert and trigger are a single serialized SQLite statement.
  // Both counters advance together, so competing requests cannot overspend either quota.
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO rate_counters(key,count,expires_at) VALUES (?,0,?),(?,0,?)').bind(ipKey, expires, dayKey, expires),
    env.DB.prepare('INSERT INTO quota_leases(id,ip_key,day_key,created_at) SELECT ?,?,?,? WHERE (SELECT count FROM rate_counters WHERE key=?) < ? AND (SELECT count FROM rate_counters WHERE key=?) < ? RETURNING id').bind(crypto.randomUUID(), ipKey, dayKey, now.toISOString(), ipKey, hourly, dayKey, daily),
  ]);
  if (!results[1].results.length) throw new AppError('QUOTA_EXCEEDED', '本時段查詢額度已用完，請稍後再試', 429);
}
export async function audit(env: Env, actor: string, action: string, status: string, runId: string | null = null, latency: number | null = null, usage?: { input_tokens: number; output_tokens: number }) {
  await env.DB.prepare('INSERT INTO audit_events(id,created_at,actor,action,run_id,status,latency_ms,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), new Date().toISOString(), actor, action, runId, status, latency, usage?.input_tokens ?? null, usage?.output_tokens ?? null).run();
}
