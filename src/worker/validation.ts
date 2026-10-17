import Papa from 'papaparse';
import { CATEGORY_CRITERIA, NORMAL, type Sample } from '../shared/definitions';
import { AppError } from './types';

function luhn(s: string) {
  let sum = 0;
  for (let i = s.length - 1, double = false; i >= 0; i--, double = !double) {
    let n = Number(s[i]); if (double) { n *= 2; if (n > 9) n -= 9; } sum += n;
  }
  return sum % 10 === 0;
}
function taiwanId(s: string) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
  const code = alphabet.indexOf(s[0]) + 10;
  const digits = `${code}${s.slice(1)}`.split('').map(Number);
  return digits.reduce((sum, v, i) => sum + v * [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1][i], 0) % 10 === 0;
}
export function piiKinds(input: string): string[] {
  const text = input.normalize('NFKC');
  const found = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/\b[A-Z][12]\d{8}\b/g)) if (taiwanId(m[0])) found.add('身分證字號');
  if (/(?<!\d)(?:09(?:[\s-]*\d){8}|\+?886[\s-]*9(?:[\s-]*\d){8})(?!\d)/.test(text)) found.add('手機號碼');
  for (const m of text.matchAll(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g)) {
    const n = m[0].replace(/\D/g, '');
    if (!/^0+$/.test(n) && luhn(n)) found.add('信用卡號');
  }
  if (/(?:銀行帳號|銀行賬號|收款帳號|匯款帳號|轉帳帳號|帳號|賬號)\s*[:：為是]?\s*\d(?:[\s-]?\d){7,19}(?!\d)/.test(text)) found.add('銀行帳號');
  if (/(?:病歷號(?:碼)?|員工編號|員工代號|工號)\s*[:：為是]?\s*[A-Za-z0-9][A-Za-z0-9-]{2,24}/.test(text)) found.add('病歷號或員工編號');
  return [...found];
}
export function validateText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('VALIDATION_ERROR', '請輸入訊息文字');
  const text = value.trim();
  if (text.length > 10000) throw new AppError('VALIDATION_ERROR', '單則訊息上限為 10,000 字元');
  const pii = piiKinds(text);
  if (pii.length) throw new AppError('PII_DETECTED', `偵測到${pii.join('、')}，請先以占位文字替換再送出。格式檢查無法保證完整去識別化。`);
  return text;
}
export function validateThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new AppError('VALIDATION_ERROR', '門檻必須介於 0 與 1');
  return value;
}
export function parseCSV(csv: string): Sample[] {
  if (new TextEncoder().encode(csv).length > 1024 * 1024) throw new AppError('VALIDATION_ERROR', 'CSV 不可超過 1 MB', 413);
  const result = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
  if (result.errors.length) throw new AppError('VALIDATION_ERROR', `第 ${(result.errors[0].row ?? 0) + 1} 行 CSV 格式不正確`);
  const [header, ...data] = result.data;
  if (!header || !['id', 'text', 'label', 'category'].every(k => header.includes(k)) || new Set(header).size !== header.length) throw new AppError('VALIDATION_ERROR', '第 1 行需包含不重複的 id、text、label、category 欄位');
  if (!data.length || data.length > 300) throw new AppError('VALIDATION_ERROR', 'CSV 必須包含 1 至 300 筆樣本');
  const ids = new Set<string>();
  // Parse a second time with cursor metadata to report physical start lines, including multiline fields.
  const physicalLines: number[] = [];
  let previousCursor = 0, nextPhysicalLine = 1;
  const raw = csv.replace(/^\uFEFF/, '');
  Papa.parse<string[]>(raw, { skipEmptyLines: 'greedy', step: r => {
    const prefix = raw.slice(previousCursor, r.meta.cursor);
    const leadingBlank = prefix.match(/^(?:[ \t]*\r?\n)*/)?.[0].length ?? 0;
    physicalLines.push(nextPhysicalLine + (prefix.slice(0, leadingBlank).match(/\r\n|\n|\r/g)?.length ?? 0));
    nextPhysicalLine += prefix.match(/\r\n|\n|\r/g)?.length ?? 0;
    previousCursor = r.meta.cursor;
  } });
  return data.map((cells, i) => {
    const line = physicalLines[i + 1] ?? i + 2;
    const fail = (message: string): never => { throw new AppError('VALIDATION_ERROR', `第 ${line} 行：${message}`); };
    if (cells.length !== header.length) fail('欄位數量不符');
    const row = Object.fromEntries(header.map((key, j) => [key, cells[j]?.trim() ?? '']));
    if (!row.id || row.id.length > 100) fail('id 必填，且最多 100 字元');
    if (ids.has(row.id)) fail('id 重複');
    ids.add(row.id);
    if (row.label !== 'scam' && row.label !== 'legit') fail('label 必須為 scam 或 legit');
    if (!Object.hasOwn(CATEGORY_CRITERIA, row.category) || (row.label === 'legit') !== (row.category === NORMAL)) fail('category 與 label 不一致或態樣不支援');
    try { row.text = validateText(row.text); } catch (e) { fail(e instanceof AppError ? e.message : '文字格式不正確'); }
    // Other metadata is persisted too, so apply the same protection to every supplied cell.
    if (piiKinds(cells.join(' ')).length) fail('含疑似個資，請先替換');
    return { id: row.id, text: row.text, label: row.label as 'scam' | 'legit', category: row.category, variant: (row.variant ?? '').slice(0, 200) };
  });
}
