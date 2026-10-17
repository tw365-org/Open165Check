import { env, createExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../src/worker/index';
import { consumeQuota } from '../src/worker/security';
import { cleanup, createRun, executeRun, getRun } from '../src/worker/runs';
import { parseCSV } from '../src/worker/validation';
import type { Env } from '../src/worker/types';
import migration from '../migrations/0001_initial.sql?raw';
import jev from './fixtures/jev.json';
const bindings = env as unknown as Env;
const local = (): Env => ({ ...bindings, ENVIRONMENT: 'local', LOCAL_ADMIN_EMAIL: 'test@localhost', LOCAL_MOCK_JEV: 'true', RATE_LIMIT_SECRET: 'test-only', PUBLIC_HOURLY_LIMIT: 10, PUBLIC_DAILY_LIMIT: 500 });
const req = (path: string, init?: RequestInit, e = bindings) => worker.fetch(new Request(`http://localhost${path}`, init), e, createExecutionContext());
const csv = 'id,text,label,category\na,保證獲利請匯款,scam,假投資\nb,明天一起吃午餐,legit,正常訊息';
beforeAll(async () => {
  // exec accepts complete trigger bodies and the D1 migration verbatim.
  for (const sql of migration.split(/;\s*(?:\r?\n|$)(?! UPDATE|END)/).map(s => s.trim()).filter(Boolean)) {
    if (sql.startsWith('CREATE TRIGGER')) await bindings.DB.prepare(sql).run(); else await bindings.DB.exec(sql.replace(/\r?\n/g, ' '));
  }
});
beforeEach(async () => { await bindings.DB.batch(['results','runs','audit_events','quota_leases','rate_counters'].map(t => bindings.DB.prepare(`DELETE FROM ${t}`))); });
describe('application security', () => {
  it('serves health and rejects missing/forged admin credentials including static admin pages', async () => {
    expect((await req('/api/health')).status).toBe(200);
    for (const path of ['/api/admin/me','/api/admin/runs','/admin','/admin/nested']) {
      expect((await req(path, {headers:{'Cf-Access-Authenticated-User-Email':'forged@example.test','Cf-Access-Jwt-Assertion':'forged'}})).status).toBe(401);
    }
    const r = await req('/api/admin/me', undefined, local());
    expect(r.status).toBe(200);
    expect((await worker.fetch(new Request('https://evil.test/api/admin/me'), local(), createExecutionContext())).status).toBe(401);
  });
  it('accepts signed Access identity and rejects expired or wrong-audience tokens', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {extractable:true});
    const jwk = { ...await exportJWK(publicKey), kid:'test-key', alg:'RS256', use:'sig' };
    const e = { ...bindings, ACCESS_TEAM_DOMAIN:'team.cloudflareaccess.com', ACCESS_AUD:'internal-app' };
    const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async () => Response.json({keys:[jwk]}));
    const token = async (aud:string,exp:string) => new SignJWT({email:'verified@example.test'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer('https://team.cloudflareaccess.com').setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
    try {
      const valid = await req('/api/admin/me',{headers:{'Cf-Access-Jwt-Assertion':await token('internal-app','5m')}},e);
      expect(valid.status).toBe(200); expect(await valid.json()).toEqual({email:'verified@example.test'});
      for (const invalid of [await token('other-app','5m'),await token('internal-app','-1m')]) expect((await req('/api/admin/me',{headers:{'Cf-Access-Jwt-Assertion':invalid}},e)).status).toBe(401);
    } finally { mock.mockRestore(); }
  });
  it('rejects PII before any external call and does not retain submitted text', async () => {
    const response = await req('/api/classify', { method:'POST', body:JSON.stringify({text:'電話0912345678',token:'fake'}) }, local());
    expect(response.status).toBe(400);
    expect(await bindings.DB.prepare('SELECT count(*) AS n FROM results').first('n')).toBe(0);
    const audit = await bindings.DB.prepare('SELECT * FROM audit_events').all();
    expect(JSON.stringify(audit)).not.toContain('0912345678');
  });
  it('classifies public requests with verified tokens and records only safe metadata', async () => {
    const e = { ...local(), LOCAL_MOCK_JEV: 'false', JEV_API_KEY: 'fake-test-key', TURNSTILE_SECRET: 'fake-test-secret', EXPECTED_HOSTNAMES: 'example.test' };
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ success: true, action: 'classify', hostname: 'example.test' })).mockResolvedValueOnce(Response.json(jev));
    const submitted = '虛構投資內容保證獲利';
    try {
      const response = await req('/api/classify', {method:'POST',headers:{'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({text:submitted,token:'valid-once'})},e);
      expect(response.status).toBe(200);
      const json = await response.json() as {model:string}; expect(json.model).toBe('fixture-v1');
      expect(JSON.stringify(json)).not.toContain('fake-test-key');
      expect(await e.DB.prepare('SELECT count(*) AS n FROM results').first('n')).toBe(0);
      const audit = JSON.stringify((await e.DB.prepare('SELECT * FROM audit_events').all()).results);
      expect(audit).not.toContain(submitted); expect(audit).not.toContain('192.0.2.1'); expect(audit).not.toContain('valid-once');
      expect(audit).toContain('input_tokens');
    } finally { mock.mockRestore(); }
  });
  it('rejects replayed verification before spending quota or contacting Jev', async () => {
    const e = { ...local(), TURNSTILE_SECRET:'test-only', EXPECTED_HOSTNAMES:'example.test' };
    const mock = vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:false,'error-codes':['timeout-or-duplicate']}));
    try {
      expect((await req('/api/classify',{method:'POST',body:JSON.stringify({text:'虛構訊息',token:'replayed'})},e)).status).toBe(403);
      expect(await e.DB.prepare('SELECT count(*) AS n FROM quota_leases').first('n')).toBe(0);
      expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
  });
  it('prevents concurrent overspending of both IP and site quotas', async () => {
    const e = local(), r = new Request('http://localhost', {headers:{'CF-Connecting-IP':'192.0.2.1'}});
    const now = new Date('2026-10-17T15:59:00Z');
    const results = await Promise.allSettled(Array.from({length:16}, () => consumeQuota(r, e, now)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
    const nextDay = new Date('2026-10-17T16:01:00Z');
    await consumeQuota(r, e, nextDay);
    const keys = await e.DB.prepare("SELECT key,count FROM rate_counters WHERE key LIKE 'day:%' ORDER BY key").all();
    expect(keys.results.map(r => r.count)).toEqual([10,1]);
    const strict = { ...e, PUBLIC_DAILY_LIMIT: 1 };
    await expect(consumeQuota(new Request('http://localhost', { headers:{'CF-Connecting-IP':'192.0.2.2'} }), strict, nextDay)).rejects.toThrow('額度');
  });
});
describe('runs and retention', () => {
  it('executes once, persists complete summary and recalculates threshold without calling Jev', async () => {
    const e = local();
    const id = await createRun(e, parseCSV(csv), 'fictional.csv', .7, 'test@localhost', csv);
    const done = await executeRun(e, id, 'test@localhost');
    expect(done.status).toBe('done'); expect(done.summary.n_valid).toBe(2);
    await expect(executeRun(e,id,'test@localhost')).rejects.toThrow('不會重複');
    const r = await req(`/api/admin/runs/${id}/threshold`, {method:'PATCH',body:JSON.stringify({threshold:.05})},e);
    expect(r.status).toBe(200);
    const result = await r.json() as {summary:{binary_at_default_threshold:{fp:number}}};
    expect(result.summary.binary_at_default_threshold.fp).toBe(1);
    const filtered = await req(`/api/admin/runs/${id}/results?false_positives=1`,undefined,e);
    expect((await filtered.json() as {items:unknown[]}).items).toHaveLength(1);
  });
  it('records malformed model output as failure, never success', async () => {
    const e = { ...local(), LOCAL_MOCK_JEV:'false', JEV_API_KEY:'test-only' };
    const id = await createRun(e,parseCSV(csv),'fictional.csv',.7,'test@localhost',csv);
    const mock = vi.spyOn(globalThis,'fetch').mockImplementation(async () => Response.json({}));
    try { const r = await executeRun(e,id,'test@localhost'); expect(r.status).toBe('failed'); expect(r.summary.n_valid).toBe(0); }
    finally { mock.mockRestore(); }
  });
  it('handles mixed valid and invalid rows as degraded', async () => {
    const e = { ...local(), LOCAL_MOCK_JEV:'false', JEV_API_KEY:'test-only' };
    const id = await createRun(e,parseCSV(csv),'fictional.csv',.7,'test@localhost',csv);
    const mock = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(Response.json(jev)).mockResolvedValueOnce(Response.json({}));
    try { const r = await executeRun(e,id,'test@localhost'); expect(r.status).toBe('degraded'); expect(r.summary.success_rate).toBe(.5); }
    finally { mock.mockRestore(); }
  });
  it('interrupts exhausted budgets and preserves unfinished counts', async () => {
    const e = local(), id = await createRun(e, parseCSV(csv), 'fictional.csv', .7, 'test@localhost', csv);
    const abort = new AbortController(); abort.abort();
    const r = await executeRun(e,id,'test@localhost',abort.signal);
    expect(r.status).toBe('failed'); expect(r.n_unfinished).toBe(2);
  });
  it('aborts pending upstream calls on the run deadline', async () => {
    const e = { ...local(), LOCAL_MOCK_JEV:'false', JEV_API_KEY:'test-only' };
    const id = await createRun(e,parseCSV(csv),'fictional.csv',.7,'test@localhost',csv);
    const mock = vi.spyOn(globalThis,'fetch').mockImplementation((_url, init) => new Promise((_resolve,reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(new Error('aborted'));
      else signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
    }));
    try { const r = await executeRun(e,id,'test@localhost',undefined,10); expect(r.status).toBe('failed'); expect(r.n_unfinished).toBe(2); }
    finally { mock.mockRestore(); }
  });
  it('clears expired text and rate identifiers but retains aggregate results', async () => {
    const e = local(), id = await createRun(e,parseCSV(csv),'fictional.csv',.7,'test@localhost',csv);
    await executeRun(e,id,'test@localhost');
    await e.DB.prepare('UPDATE runs SET created_at=? WHERE id=?').bind('2020-01-01T00:00:00.000Z',id).run();
    await consumeQuota(new Request('http://localhost'),e,new Date('2020-01-01T00:00:00Z'));
    await cleanup(e);
    expect(await e.DB.prepare('SELECT text FROM results WHERE run_id=? LIMIT 1').bind(id).first('text')).toBeNull();
    expect((await getRun(e,id)).summary_json).not.toBeNull();
    expect(await e.DB.prepare('SELECT count(*) AS n FROM rate_counters').first('n')).toBe(0);
    expect(await e.DB.prepare('SELECT count(*) AS n FROM quota_leases').first('n')).toBe(0);
  });
});
