export interface Env extends Cloudflare.Env {
  JEV_API_KEY?: string; TURNSTILE_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; RATE_LIMIT_SECRET?: string;
  LOCAL_ADMIN_EMAIL?: string; LOCAL_MOCK_JEV?: string;
}
export class AppError extends Error {
  constructor(public code: string, message: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 | 504 = 400) { super(message); }
}
export function isLocal(env: Env, url?: string) {
  return env.ENVIRONMENT === 'local' && (!url || ['localhost', '127.0.0.1'].includes(new URL(url).hostname));
}
