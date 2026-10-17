import type { EvalRecord } from './definitions';
const round = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const div = (a: number, b: number) => b ? round(a / b) : null;
export function binaryMetrics(records: EvalRecord[], threshold: number) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of records) {
    if (r.p_scam === null || r.error) continue;
    const pred = r.p_scam >= threshold, actual = r.label === 'scam';
    if (pred && actual) tp++; else if (pred) fp++; else if (actual) fn++; else tn++;
  }
  return { threshold, tp, fp, tn, fn, accuracy: div(tp + tn, tp + fp + tn + fn),
    precision: div(tp, tp + fp), recall: div(tp, tp + fn), f1: div(2 * tp, 2 * tp + fp + fn), false_positive_rate: div(fp, fp + tn) };
}
export function categoryMetrics(records: EvalRecord[]) {
  const rows = records.filter(r => r.label === 'scam' && r.choice !== null && !r.error);
  const per: Record<string, { n: number; correct: number; accuracy: number }> = {};
  let correct = 0;
  for (const r of rows) {
    const c = per[r.category] ??= { n: 0, correct: 0, accuracy: 0 };
    c.n++; if (r.choice === r.category) { c.correct++; correct++; }
  }
  for (const c of Object.values(per)) c.accuracy = round(c.correct / c.n);
  return { scam_category_accuracy: div(correct, rows.length), per_category: per };
}
export function summarize(records: EvalRecord[], threshold: number) {
  const valid = records.filter(r => r.p_scam !== null && !r.error).length;
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of records.filter(r => r.choice && !r.error)) {
    const row = confusion[r.category] ??= {};
    row[r.choice!] = (row[r.choice!] ?? 0) + 1;
  }
  return { n_total: records.length, n_valid: valid, n_errors: records.length - valid, success_rate: div(valid, records.length),
    binary_at_default_threshold: binaryMetrics(records, threshold),
    threshold_sweep: Array.from({ length: 7 }, (_, i) => binaryMetrics(records, (i + 3) / 10)),
    category: categoryMetrics(records), category_confusion: confusion };
}
export type Summary = ReturnType<typeof summarize>;
