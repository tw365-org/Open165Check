import { buildQuestions, CONFIG_VERSION, type EvalRecord, type Sample } from '../shared/definitions';
import { summarize } from '../shared/metrics';
import { callJev } from './jev';
import { audit } from './security';
import { AppError, type Env } from './types';
export interface RunRow {
  id: string; created_at: string; created_by: string; dataset_name: string; dataset_hash: string;
  config_version: string; config_json: string; requested_model: string; models_json: string;
  threshold: number; status: string; n_total: number; n_completed: number; n_errors: number;
  n_unfinished: number; started_at: string | null; finished_at: string | null; summary_json: string | null;
}
interface StoredResult { run_id: string; sample_id: string; label: 'scam' | 'legit'; category: string; variant: string; text: string | null; choice: string | null; p_scam: number | null; error: string | null; completed_at: string | null }
export function toRecord(r: StoredResult): EvalRecord { return { ...r, id: r.sample_id }; }
export async function getRun(env: Env, id: string) {
  const run = await env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
  if (!run) throw new AppError('NOT_FOUND', '找不到這次評估', 404);
  return run;
}
export function presentRun(run: RunRow) {
  return { ...run, summary: run.summary_json ? JSON.parse(run.summary_json) : null,
    models: JSON.parse(run.models_json), config: JSON.parse(run.config_json), summary_json: undefined, models_json: undefined, config_json: undefined };
}
export async function createRun(env: Env, rows: Sample[], name: string, threshold: number, actor: string, csv: string) {
  const id = crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(csv)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const statements = [env.DB.prepare('INSERT INTO runs(id,created_at,created_by,dataset_name,dataset_hash,config_version,config_json,requested_model,threshold,status,n_total) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), actor, name, hash, CONFIG_VERSION, JSON.stringify({ questions: buildQuestions(), concurrency: 5, budget_ms: 240000 }), env.JEV_MODEL, threshold, 'queued', rows.length),
    ...rows.map(r => env.DB.prepare('INSERT INTO results(run_id,sample_id,label,category,variant,text) VALUES (?,?,?,?,?,?)').bind(id, r.id, r.label, r.category, r.variant, r.text))];
  await env.DB.batch(statements);
  await audit(env, actor, 'create_run', 'queued', id);
  return id;
}
export async function finalizeRun(env: Env, id: string, interruption?: string) {
  const now = new Date().toISOString();
  if (interruption) await env.DB.prepare('UPDATE results SET error=?,completed_at=? WHERE run_id=? AND completed_at IS NULL').bind(interruption, now, id).run();
  const run = await getRun(env, id);
  const { results } = await env.DB.prepare('SELECT * FROM results WHERE run_id=? ORDER BY sample_id').bind(id).all<StoredResult>();
  const records = results.map(toRecord), summary = summarize(records, run.threshold);
  const { results: models } = await env.DB.prepare('SELECT DISTINCT actual_model FROM results WHERE run_id=? AND actual_model IS NOT NULL').bind(id).all<{ actual_model: string }>();
  const unfinished = records.filter(r => ['TIMEOUT', 'INTERRUPTED'].includes(r.error ?? '')).length;
  const status = summary.n_valid === 0 ? 'failed' : interruption ? 'interrupted' : summary.n_errors / run.n_total > 0.1 ? 'degraded' : 'done';
  await env.DB.prepare('UPDATE runs SET status=?,finished_at=?,summary_json=?,n_completed=?,n_errors=?,n_unfinished=?,models_json=? WHERE id=?')
    .bind(status, now, JSON.stringify(summary), records.filter(r => !['TIMEOUT', 'INTERRUPTED'].includes(r.error ?? '')).length, summary.n_errors, unfinished, JSON.stringify(models.map(m => m.actual_model)), id).run();
  return getRun(env, id);
}
export async function executeRun(env: Env, id: string, actor: string, requestSignal?: AbortSignal, budgetMs = 240000) {
  const run = await getRun(env, id);
  const claim = await env.DB.prepare("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='queued' RETURNING id").bind(new Date().toISOString(), id).all();
  if (!claim.results.length) throw new AppError('ALREADY_EXECUTED', '這次評估已開始或已結束；不會重複執行', 409);
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = AbortSignal.any([deadline, ...(requestSignal ? [requestSignal] : [])]);
  // Persisted configuration belongs to this run even if deployment settings change before execution.
  const runEnv = { ...env, JEV_MODEL: run.requested_model };
  const snapshot = JSON.parse(run.config_json) as { questions: ReturnType<typeof buildQuestions> };
  const { results: rows } = await env.DB.prepare('SELECT * FROM results WHERE run_id=? ORDER BY sample_id').bind(id).all<StoredResult>();
  let next = 0;
  try {
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (next < rows.length && !signal.aborted) {
        const row = rows[next++];
        try {
          if (row.text === null) throw new AppError('EXPIRED', '樣本文字已到期');
          const { result, latency, attempts } = await callJev(runEnv, row.text, signal, fetch, snapshot.questions);
          await env.DB.batch([
            env.DB.prepare('UPDATE results SET choice=?,p_scam=?,probs_json=?,signals_json=?,actual_model=?,latency_ms=?,attempts=?,completed_at=? WHERE run_id=? AND sample_id=? AND completed_at IS NULL')
              .bind(result.choice, result.p_scam, JSON.stringify(result.probabilities), JSON.stringify(result.signals), result.model, latency, attempts, new Date().toISOString(), id, row.sample_id),
            env.DB.prepare('UPDATE runs SET n_completed=n_completed+1 WHERE id=?').bind(id),
            env.DB.prepare('INSERT INTO audit_events(id,created_at,actor,action,run_id,status,latency_ms,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)')
              .bind(crypto.randomUUID(), new Date().toISOString(), actor, 'run_sample', id, 'success', latency, result.usage.input_tokens, result.usage.output_tokens),
          ]);
        } catch (e) {
          if (signal.aborted) break;
          const code = e instanceof AppError ? e.code : 'INTERNAL_ERROR';
          await env.DB.batch([
            env.DB.prepare('UPDATE results SET error=?,completed_at=? WHERE run_id=? AND sample_id=?').bind(code, new Date().toISOString(), id, row.sample_id),
            env.DB.prepare('UPDATE runs SET n_completed=n_completed+1,n_errors=n_errors+1 WHERE id=?').bind(id),
          ]);
        }
      }
    }));
  } catch {
    await finalizeRun(env, id, 'INTERRUPTED');
    throw new AppError('EXECUTION_FAILED', '執行中斷，已完成結果仍可查看', 500);
  }
  const result = await finalizeRun(env, id, signal.aborted ? (deadline.aborted ? 'TIMEOUT' : 'INTERRUPTED') : undefined);
  await audit(env, actor, 'execute_run', result.status, id);
  return presentRun(result);
}
export async function recoverStaleRuns(env: Env) {
  const stale = new Date(Date.now() - 10 * 60000).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM runs WHERE status='running' AND started_at < ?").bind(stale).all<{ id: string }>();
  for (const r of results) await finalizeRun(env, r.id, 'INTERRUPTED');
}
export async function cleanup(env: Env) {
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - 180 * 86400000).toISOString(), rateCutoff = new Date(Date.now() - 48 * 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE results SET text=NULL,variant=\'\' WHERE text IS NOT NULL AND run_id IN (SELECT id FROM runs WHERE created_at < ?)').bind(cutoff),
    env.DB.prepare('DELETE FROM quota_leases WHERE created_at < ?').bind(rateCutoff),
    env.DB.prepare('DELETE FROM rate_counters WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM audit_events WHERE created_at < ?').bind(cutoff),
  ]);
  await recoverStaleRuns(env);
}
