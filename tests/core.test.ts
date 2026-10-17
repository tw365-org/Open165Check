import { describe, expect, it, vi } from 'vitest';
import { binaryMetrics, categoryMetrics, summarize } from '../src/shared/metrics';
import { buildQuestions, type EvalRecord } from '../src/shared/definitions';
import { parseCSV, piiKinds, validateText } from '../src/worker/validation';
import { callJev, parseResponse } from '../src/worker/jev';
import { verifyTurnstile } from '../src/worker/security';
import type { Env } from '../src/worker/types';
import fixture from './fixtures/metrics.json';
import jev from './fixtures/jev.json';
import questions from './fixtures/questions.json';
const baseEnv = { ENVIRONMENT: 'test', JEV_API_KEY: 'test-only', JEV_API_URL: 'https://api.typesafe.ai/v1/systemone', JEV_MODEL: 'jev-latest', TURNSTILE_SECRET: 'test-only', EXPECTED_HOSTNAMES: 'example.test' } as Env;
describe('shared metrics and API contracts', () => {
  it('matches Python fixed-response fixture exactly', () => {
    const records = fixture.records as EvalRecord[];
    expect(binaryMetrics(records, fixture.threshold)).toEqual(fixture.binary);
    expect(categoryMetrics(records)).toEqual(fixture.category);
    expect(summarize(records, .7).success_rate).toBe(.8);
    expect(buildQuestions()).toEqual(questions);
  });
  it('reports zero F1 and excludes malformed responses', () => {
    expect(binaryMetrics([{ ...fixture.records[1], error: null } as EvalRecord], .7).f1).toBe(0);
    expect(binaryMetrics([], .7).f1).toBeNull();
  });
  it('parses actual documented shape and rejects missing fields, NaN, extra options and wrong choices', () => {
    expect(parseResponse(jev).p_scam).toBe(.99);
    const bad = structuredClone(jev); delete (bad.answers.category as Partial<typeof bad.answers.category>).probabilities;
    expect(() => parseResponse(bad)).toThrow();
    expect(() => parseResponse({})).toThrow();
    expect(() => parseResponse({ ...jev, answers: { ...jev.answers, urgency: { type: 'noul', noul: NaN } } })).toThrow();
    expect(() => parseResponse({ ...jev, answers: { ...jev.answers, category: { ...jev.answers.category, choice: '不存在' } } })).toThrow();
  });
});
describe('privacy and CSV', () => {
  it('recognizes valid Taiwan identifiers, phones and cards without rejecting arbitrary numbers', () => {
    expect(piiKinds('A123456789')).toContain('身分證字號');
    expect(piiKinds('A123456788')).toEqual([]);
    expect(piiKinds('０９１２－３４５－６７８')).toContain('手機號碼');
    expect(piiKinds('+886 912 345 678')).toContain('手機號碼');
    expect(piiKinds('4111 1111 1111 1111')).toContain('信用卡號');
    expect(piiKinds('銀行帳號：123456789012')).toContain('銀行帳號');
    expect(piiKinds('病歷號：MR1234')).toContain('病歷號或員工編號');
    expect(piiKinds('員工編號 E001')).toContain('病歷號或員工編號');
    expect(piiKinds('https://example.invalid/abc')).toEqual([]);
    expect(() => validateText(' ')).toThrow();
    expect(() => validateText('字'.repeat(10001))).toThrow();
  });
  const header = 'id,text,label,category\n';
  it('accepts BOM, multiline quoting, and consistent labels', () => {
    expect(parseCSV('\ufeff' + header + 'a,"第一行\n第二行",legit,正常訊息')[0].text).toContain('\n');
  });
  it('rejects duplicate IDs, inconsistent categories, PII metadata and first physical error line', () => {
    expect(() => parseCSV(header + 'a,你好,legit,正常訊息\na,你好,legit,正常訊息')).toThrow('第 3 行');
    expect(() => parseCSV(header + 'a,"第一行\n第二行",legit,正常訊息\nb,你好,scam,正常訊息')).toThrow('第 4 行');
    expect(() => parseCSV(header + 'a,0912345678,legit,正常訊息')).toThrow();
    expect(() => parseCSV('id,text,label,category,variant\na,你好,legit,正常訊息,0912345678')).toThrow();
    expect(() => parseCSV(header + 'a,你好,scam,toString')).toThrow();
    expect(() => parseCSV(header)).toThrow();
    expect(() => parseCSV(header + Array.from({length:301},(_,i) => `${i},你好,legit,正常訊息`).join('\n'))).toThrow();
    expect(() => parseCSV('x'.repeat(1048577))).toThrow();
  });
});
describe('external boundaries', () => {
  it('rejects forged/expired Turnstile responses and verifies action and hostname', async () => {
    for (const v of [{ success: false }, { success: true, action: 'other', hostname: 'example.test' }, { success: true, action: 'classify', hostname: 'evil.test' }]) {
      const mock = vi.fn().mockResolvedValue(Response.json(v));
      await expect(verifyTurnstile('token', new Request('https://example.test'), baseEnv, mock)).rejects.toThrow();
    }
    await expect(verifyTurnstile('token', new Request('https://example.test'), baseEnv, vi.fn().mockResolvedValue(Response.json({ success: true, action: 'classify', hostname: 'example.test' })))).resolves.toBeUndefined();
  });
  it('accepts the official dummy response only on localhost and rejects test keys in deployment', async () => {
    const e = { ...baseEnv, ENVIRONMENT:'local', TURNSTILE_SECRET:'1x0000000000000000000000000000000AA', EXPECTED_HOSTNAMES:'localhost,127.0.0.1' };
    const mock = vi.fn().mockImplementation(async () => Response.json({success:true,hostname:'example.com'}));
    await expect(verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX',new Request('http://localhost'),e,mock)).resolves.toBeUndefined();
    await expect(verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX',new Request('https://example.test'),e,mock)).rejects.toThrow();
    await expect(verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX',new Request('https://example.test'),{...e,ENVIRONMENT:'production'},mock)).rejects.toThrow('測試金鑰');
  });
  it('never retries permanent 4xx or malformed success and returns sanitized errors', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('secret echoed text', { status: 401 }));
    await expect(callJev(baseEnv, '虛構', undefined, mock)).rejects.toThrow('拒絕');
    expect(mock).toHaveBeenCalledTimes(1);
    const malformed = vi.fn().mockResolvedValue(Response.json({}));
    await expect(callJev(baseEnv, '虛構', undefined, malformed)).rejects.toThrow('格式');
    expect(malformed).toHaveBeenCalledTimes(1);
  });
  it('retries temporary errors, respecting the finite budget', async () => {
    vi.useFakeTimers();
    try {
      const mock = vi.fn().mockResolvedValueOnce(new Response(null, {status:529})).mockResolvedValueOnce(Response.json(jev));
      const pending = callJev(baseEnv, '虛構', undefined, mock);
      await vi.runAllTimersAsync();
      expect((await pending).attempts).toBe(2);
      expect(mock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
