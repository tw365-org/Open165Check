import { buildQuestions, CATEGORY_CRITERIA, SIGNALS, NORMAL, type Classification } from '../shared/definitions';
import { AppError, type Env } from './types';
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function parseResponse(raw: unknown): Classification {
  const r = object(raw), answers = object(r.answers), cat = object(answers.category), probs = object(cat.probabilities);
  const invalid = () => new AppError('INVALID_RESPONSE', '判斷服務回應格式不正確，請稍後再試', 502);
  if (typeof r.model !== 'string' || !r.model || cat.type !== 'choice' || typeof cat.choice !== 'string' || !Object.hasOwn(CATEGORY_CRITERIA, cat.choice)) throw invalid();
  if (Object.keys(probs).length !== Object.keys(CATEGORY_CRITERIA).length || !Object.keys(CATEGORY_CRITERIA).every(k => probability(probs[k]))) throw invalid();
  if (Math.abs(Object.values(probs).reduce<number>((sum, v) => sum + Number(v), 0) - 1) > 0.001) throw invalid();
  if (Number(probs[cat.choice]) + 1e-8 < Math.max(...Object.values(probs).map(Number))) throw invalid();
  const signals: Record<string, number> = {};
  for (const key of Object.keys(SIGNALS)) {
    const a = object(answers[key]);
    if (a.type !== 'noul' || !probability(a.noul)) throw invalid();
    signals[key] = a.noul;
  }
  const usage = object(r.usage);
  if (!['input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(usage[k]) && Number(usage[k]) >= 0)) throw invalid();
  return { choice: cat.choice, p_scam: 1 - Number(probs[NORMAL]), probabilities: probs as Record<string, number>, signals, model: r.model,
    usage: { input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) } };
}
export function mockResponse(text: string): Classification {
  const choice = text.includes('保證獲利') ? '假投資' : NORMAL;
  return parseResponse({ model: 'local-fixture-v1', answers: {
    category: { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(CATEGORY_CRITERIA).map(k => [k, k === choice ? 0.9 : 0.01])) },
    ...Object.fromEntries(Object.keys(SIGNALS).map(k => [k, { type: 'noul', noul: text.includes('保證獲利') ? 0.8 : 0.1 }]))
  }, usage: { input_tokens: 0, output_tokens: 0 } });
}
export async function callJev(env: Env, text: string, signal?: AbortSignal, requestFetch: typeof fetch = fetch, questions = buildQuestions()) {
  const start = performance.now();
  if (env.ENVIRONMENT === 'local' && env.LOCAL_MOCK_JEV === 'true') return { result: mockResponse(text), latency: performance.now() - start, attempts: 0 };
  if (!env.JEV_API_KEY) throw new AppError('NOT_CONFIGURED', '判斷服務尚未設定', 503);
  if (new URL(env.JEV_API_URL).protocol !== 'https:') throw new AppError('NOT_CONFIGURED', '判斷服務設定不正確', 503);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw new AppError('TIMEOUT', '執行已中斷或逾時', 504);
    let delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
    try {
      const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
      const r = await requestFetch(env.JEV_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.JEV_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.JEV_MODEL, state: text, questions }), signal: abort });
      if (!r.ok) {
        await r.body?.cancel();
        if (!(r.status === 429 || r.status >= 500)) throw new AppError('UPSTREAM_REJECTED', '判斷服務拒絕請求，請聯絡管理人員', 502);
        const retry = r.headers.get('Retry-After');
        if (retry) delay = Math.min(15000, Math.max(delay, (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) || 0));
      } else {
        const raw: unknown = await r.json();
        return { result: parseResponse(raw), latency: Math.round(performance.now() - start), attempts: attempt + 1 };
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof SyntaxError) throw new AppError('INVALID_RESPONSE', '判斷服務回應格式不正確', 502);
      if (signal?.aborted) throw new AppError('TIMEOUT', '執行已中斷或逾時', 504);
    }
    if (attempt < 4) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new AppError('TIMEOUT', '執行已中斷或逾時', 504)); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  }
  throw new AppError('UPSTREAM_UNAVAILABLE', '判斷服務暫時無法使用，請稍後再試', 503);
}
