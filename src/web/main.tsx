import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { api } from './api';
import { NORMAL, SIGNAL_LABELS, type Classification } from '../shared/definitions';
import type { Summary } from '../shared/metrics';
import './style.css';

declare global { interface Window { turnstile?: { render: (el: HTMLElement, options: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void } } }
type Config = { siteKey: string; localMock: boolean; hourlyLimit: number; dailyLimit: number };
type Run = { id: string; dataset_name: string; status: string; created_at: string; n_total: number; n_completed: number; n_errors: number; n_unfinished: number; requested_model: string; models: string[]; threshold: number; summary: Summary | null; dataset_hash: string; config_version: string };
type ResultRow = { sample_id: string; text: string | null; label: string; category: string; choice: string | null; p_scam: number | null; error: string | null; probabilities: Record<string, number> | null; signals: Record<string, number> | null };
const pct = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const statuses: Record<string, string> = { queued: '待執行', running: '評估中', done: '已完成', degraded: '部分失敗', failed: '評估失敗', interrupted: '執行中斷' };
function Message({ children }: { children: React.ReactNode }) { return children ? <div className="notice error" role="alert">{children}</div> : null; }
function Bars({ values, labels }: { values: Record<string, number>; labels?: Record<string, string> }) {
  return <div className="bars">{Object.entries(values).sort((a, b) => b[1] - a[1]).map(([k, v]) => <div className="bar-row" key={k}><span>{labels?.[k] ?? k}</span><meter min="0" max="1" value={v}/><strong>{pct(v)}</strong></div>)}</div>;
}
function Verdict({ result }: { result: Classification }) {
  const risky = result.p_scam >= 0.7;
  return <section className="card result" aria-live="polite"><div className="eyebrow">分析結果</div><div className="verdict"><div><h2>{risky ? '這則訊息需要提高警覺' : '目前未達高風險門檻'}</h2><p>可能態樣：<strong>{result.choice}</strong></p></div><div className={`score ${risky ? 'danger' : ''}`}><strong>{(result.p_scam * 100).toFixed(1)}</strong><span>風險分數 / 100</span></div></div>
    <p className="notice">這是模型風險分數，並非經校準的真實詐騙機率。低分也無法保證安全；涉及付款、驗證碼或帳戶時，請透過官方管道查證。</p>
    <h3>訊息中的風險信號</h3><Bars values={result.signals} labels={SIGNAL_LABELS}/>
    <details><summary>查看態樣機率與模型資訊</summary><Bars values={result.probabilities}/><p className="muted">實際模型：{result.model}。態樣機率是在既定分類選項之間的相對分布。</p></details>
  </section>;
}
function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (s: string) => void; resetKey: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | undefined; let cancelled = false;
    const render = () => { if (!cancelled && el.current && window.turnstile && !id) id = window.turnstile.render(el.current, { sitekey: siteKey, action: 'classify', theme: 'auto', callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken('') }); };
    const existing = document.getElementById('turnstile-script');
    let script: HTMLScriptElement | undefined;
    if (!existing) { script = document.createElement('script'); script.id = 'turnstile-script'; script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; document.head.appendChild(script); }
    const timer = setInterval(render, 150); render();
    return () => { cancelled = true; clearInterval(timer); if (id) window.turnstile?.remove(id); };
  }, [siteKey, resetKey, onToken]);
  return <div className="verification" ref={el}/>;
}
function Classifier({ internal = false }: { internal?: boolean }) {
  const [text, setText] = useState(''), [result, setResult] = useState<Classification | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [config, setConfig] = useState<Config | null>(null), [token, setToken] = useState(''), [reset, setReset] = useState(0);
  useEffect(() => { api<Config>('/api/config').then(setConfig).catch(e => setError(e.message)); }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setResult(null);
    try { setResult(await api<Classification>(internal ? '/api/admin/classify' : '/api/classify', { method: 'POST', body: JSON.stringify({ text, token }) })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setToken(''); setReset(n => n + 1); }
  }
  return <><section className="card"><div className="card-heading"><div><div className="eyebrow">{internal ? '內部工具' : '開始檢查'}</div><h2>貼上讓你有疑慮的訊息</h2></div><span className="tag">僅分析文字</span></div>
    {config?.localMock && <p className="notice">本機示範模式：使用固定測試回應，結果不代表 Jev 的實際能力。</p>}
    <form onSubmit={submit}><label htmlFor={internal ? 'internal-text' : 'message'}>訊息內容</label><textarea id={internal ? 'internal-text' : 'message'} maxLength={10000} rows={8} value={text} onChange={e => { setText(e.target.value); setResult(null); }} placeholder="例如：投資老師保證獲利，請立即加入群組並匯款……" required disabled={busy}/>
    <div className="field-note"><span>請先替換姓名、電話、身分證、帳號等個資。</span><span>{text.length.toLocaleString()} / 10,000</span></div>
    {!internal && <><p className="privacy">送出即代表你了解：文字會交由 TypeSafe Jev 分析，並經 Cloudflare 傳輸；本站不保存公開查詢全文或結果。網址只作文字分析，不會開啟網站。格式檢查無法保證完整去識別化。</p>{config?.siteKey ? <Turnstile siteKey={config.siteKey} onToken={setToken} resetKey={reset}/> : <p className="notice">服務尚在設定中，暫不開放查詢。</p>}</>}
    <Message>{error}</Message><button className="primary" disabled={busy || !text.trim() || (!internal && !token)}>{busy ? '正在分析，請稍候…' : '檢查訊息風險'}<span aria-hidden="true">↗</span></button>
    {!internal && <p className="muted small">每個連線來源每小時最多 {config?.hourlyLimit ?? 10} 次；全站每日最多 {config?.dailyLimit ?? 500} 次。分析失敗的已送出請求也會計入額度。</p>}</form></section>{result && <Verdict result={result}/>}</>;
}
function Metrics({ summary }: { summary: Summary }) {
  const b = summary.binary_at_default_threshold;
  return <><div className="metrics">{[['準確率', b.accuracy], ['精確率', b.precision], ['召回率', b.recall], ['F1', b.f1], ['誤判率', b.false_positive_rate], ['成功率', summary.success_rate]].map(([label, v]) => <div className="metric" key={String(label)}><span>{label}</span><strong>{pct(v as number | null)}</strong></div>)}</div>
    <p className="muted">有效樣本 {summary.n_valid} / {summary.n_total}，錯誤 {summary.n_errors}。指標僅以有效樣本計算。</p>
    <h3>二元混淆矩陣</h3><div className="matrix"><div>正確辨識詐騙（TP）<strong>{b.tp}</strong></div><div>正常誤判詐騙（FP）<strong>{b.fp}</strong></div><div>詐騙漏判正常（FN）<strong>{b.fn}</strong></div><div>正確辨識正常（TN）<strong>{b.tn}</strong></div></div>
    <h3>門檻掃描</h3><div className="table-wrap"><table><thead><tr><th>門檻</th><th>精確率</th><th>召回率</th><th>F1</th><th>誤判率</th></tr></thead><tbody>{summary.threshold_sweep.map(m => <tr key={m.threshold}><td>{m.threshold}</td><td>{pct(m.precision)}</td><td>{pct(m.recall)}</td><td>{pct(m.f1)}</td><td>{pct(m.false_positive_rate)}</td></tr>)}</tbody></table></div>
    <h3>詐騙態樣準確率 · {pct(summary.category.scam_category_accuracy)}</h3><Bars values={Object.fromEntries(Object.entries(summary.category.per_category).map(([k, v]) => [`${k}（${v.correct}/${v.n}）`, v.accuracy]))}/>
    <details><summary>態樣混淆明細</summary><div className="table-wrap"><table><thead><tr><th>標註態樣</th><th>模型選項</th><th>筆數</th></tr></thead><tbody>{Object.entries(summary.category_confusion).flatMap(([actual, row]) => Object.entries(row).map(([pred, n]) => <tr key={`${actual}-${pred}`}><td>{actual}</td><td>{pred}</td><td>{n}</td></tr>))}</tbody></table></div></details></>;
}
function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null), [rows, setRows] = useState<ResultRow[]>([]), [error, setError] = useState(''), [filter, setFilter] = useState(''), [threshold, setThreshold] = useState(0.7), [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false), [rowsLoading, setRowsLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = () => api<Run>(`/api/admin/runs/${id}`).then(r => { if (active) { setRun(r); setThreshold(r.threshold); if (!['queued', 'running'].includes(r.status)) clearInterval(timer); } }).catch(e => { if (active) setError(e.message); });
    const timer = setInterval(load, 2000); void load(); return () => { active = false; clearInterval(timer); };
  }, [id]);
  useEffect(() => {
    let active = true; setRowsLoading(true);
    api<{ items: ResultRow[]; has_more: boolean }>(`/api/admin/runs/${id}/results?page=${page}${filter}`).then(r => { if (active) { setRows(r.items); setHasMore(r.has_more); setRowsLoading(false); } }).catch(e => { if (active) { setError(e.message); setRowsLoading(false); } });
    return () => { active = false; };
  }, [id, page, filter, run?.n_completed, run?.threshold, run?.status]);
  async function changeThreshold() { setBusy(true); try { setRun(await api<Run>(`/api/admin/runs/${id}/threshold`, { method: 'PATCH', body: JSON.stringify({ threshold }) })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function execute() { setBusy(true); setError(''); try { setRun(await api<Run>(`/api/admin/runs/${id}/execute`, { method: 'POST' })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="card"><button className="text-button" onClick={onClose}>← 返回執行清單</button><Message>{error}</Message>{run && <><div className="card-heading"><div><div className="eyebrow">評估詳情</div><h2>{run.dataset_name}</h2></div><span className="tag">{statuses[run.status]}</span></div>
    <p className="muted">{run.n_completed} / {run.n_total} 筆已處理 · 錯誤 {run.n_errors} · 未完成 {run.n_unfinished}</p>
    {run.models.includes('local-fixture-v1') && <p className="notice">此評估使用本機固定測試回應，僅驗證操作流程；指標不代表 Jev 的實際偵測能力。</p>}
    {run.status === 'running' && <><progress value={run.n_completed} max={run.n_total}/><p className="notice">同步執行中，請保持頁面開啟。最多執行 240 秒；關閉頁面後不保證繼續，亦不會自動重跑。</p></>}
    {run.status === 'queued' && <button className="primary" disabled={busy} onClick={execute}>開始同步評估</button>}
    {['failed', 'degraded', 'interrupted'].includes(run.status) && <p className="notice error">這次評估有失敗或未完成樣本，請同時檢查成功率與逐筆錯誤。</p>}
    {run.summary && <><div className="threshold"><label>判斷門檻 <input aria-label="判斷門檻" type="number" min="0" max="1" step="0.05" value={threshold} onChange={e => setThreshold(Number(e.target.value))}/></label><button disabled={busy} onClick={changeThreshold}>更新指標</button><span className="muted">使用既有結果重算，不會再次呼叫 Jev。</span></div><Metrics summary={run.summary}/></>}
    <details><summary>執行設定與可重現性</summary><p className="muted">請求模型：{run.requested_model}<br/>實際模型：{run.models.join('、') || '尚無'}<br/>設定版本：{run.config_version}<br/>資料集 SHA-256：{run.dataset_hash}</p></details>
    <div className="card-heading"><h3>逐筆結果</h3><select aria-label="結果篩選" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="">全部</option><option value="&misses=1">漏判</option><option value="&false_positives=1">誤判</option><option value="&label=scam">詐騙樣本</option><option value="&label=legit">正常樣本</option></select></div>
    <div className="table-wrap" aria-busy={rowsLoading}><table><thead><tr><th>ID / 訊息</th><th>標註</th><th>模型判斷</th><th>風險分數</th><th>狀態</th></tr></thead><tbody>{rowsLoading ? <tr><td colSpan={5}>載入結果中…</td></tr> : rows.map(r => <tr key={r.sample_id}><td><strong>{r.sample_id}</strong><p className="sample">{r.text ?? '文字已依保留期限清除'}</p>{r.signals && <details><summary>信號與機率</summary><Bars values={r.signals} labels={SIGNAL_LABELS}/>{r.probabilities && <Bars values={r.probabilities}/>}</details>}</td><td>{r.category}</td><td>{r.choice ?? '—'}</td><td>{pct(r.p_scam)}</td><td>{r.error ?? (r.choice ? '完成' : '待處理')}</td></tr>)}</tbody></table></div>{!rowsLoading && !rows.length && <p className="empty">此篩選沒有結果。</p>}
    <div className="pagination"><button disabled={page === 1 || rowsLoading} onClick={() => setPage(p => p - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={!hasMore || rowsLoading} onClick={() => setPage(p => p + 1)}>下一頁</button></div>
  </>}</section>;
}
function Admin() {
  const [email, setEmail] = useState(''), [error, setError] = useState(''), [tab, setTab] = useState('runs'), [runs, setRuns] = useState<Run[]>([]), [selected, setSelected] = useState('');
  const [page, setPage] = useState(1), [more, setMore] = useState(false), [refresh, setRefresh] = useState(0), [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState<Record<string, string>[]>([]), [threshold, setThreshold] = useState(0.7), [busy, setBusy] = useState(false);
  useEffect(() => { api<{ email: string }>('/api/admin/me').then(r => setEmail(r.email)).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (email) api<{ items: Run[]; has_more: boolean }>(`/api/admin/runs?page=${page}`).then(r => { setRuns(r.items); setMore(r.has_more); }).catch(e => setError(e.message)); }, [email, page, refresh, selected]);
  async function chooseFile(value: File | null) {
    setFile(null); setPreview([]); setError(''); if (!value) return;
    if (value.size > 1024 * 1024) { setError('CSV 不可超過 1 MB'); return; }
    try { const text = await value.text(); const parsed = Papa.parse<Record<string, string>>(text, { header: true, preview: 5, skipEmptyLines: 'greedy' }); if (parsed.errors.length) throw new Error('CSV 格式不正確'); setPreview(parsed.data); setFile(value); } catch (e) { setError((e as Error).message); }
  }
  async function upload(e: React.FormEvent) {
    e.preventDefault(); if (!file) return; setBusy(true); setError('');
    const form = new FormData(); form.set('file', file); form.set('threshold', String(threshold));
    try { const { run_id } = await api<{ run_id: string }>('/api/admin/runs', { method: 'POST', body: form }); setSelected(run_id); setTab('runs'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><div className="section-head"><div><div className="eyebrow">工作空間</div><h1>內部評估後台</h1></div><span className="muted">{email}</span></div><Message>{error}</Message>{email && <><nav className="tabs" aria-label="後台功能">{[['runs', '評估紀錄'], ['upload', '建立評估'], ['test', '單則測試']].map(([k, title]) => <button className={tab === k ? 'active' : ''} key={k} onClick={() => { setTab(k); setSelected(''); }}>{title}</button>)}</nav>
    {tab === 'test' && <Classifier internal/>}
    {tab === 'upload' && <section className="card"><h2>上傳測試資料集</h2><p className="muted">CSV 需含 id、text、label、category；最多 300 筆、1 MB。請僅使用公開或完全虛構且已去識別化的樣本。</p><form onSubmit={upload}><label className="dropzone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void chooseFile(e.dataTransfer.files[0] ?? null); }}><strong>{file?.name ?? '將 CSV 拖放到這裡，或點擊選取'}</strong><input aria-label="選擇 CSV" type="file" accept=".csv,text/csv" onChange={e => void chooseFile(e.target.files?.[0] ?? null)}/></label>
    {preview.length > 0 && <><h3>前 5 筆預覽</h3><div className="table-wrap"><table><thead><tr><th>ID</th><th>訊息</th><th>標籤</th><th>態樣</th></tr></thead><tbody>{preview.map((r, i) => <tr key={i}><td>{r.id}</td><td>{r.text}</td><td>{r.label}</td><td>{r.category}</td></tr>)}</tbody></table></div></>}
    <label>初始判斷門檻<input type="number" min="0" max="1" step="0.05" value={threshold} onChange={e => setThreshold(Number(e.target.value))}/></label><button className="primary" disabled={!file || busy}>{busy ? '驗證與建立中…' : '建立評估'}</button><p className="muted small">建立後需在詳情頁開始執行；文字保存 180 天。</p></form></section>}
    {tab === 'runs' && (selected ? <RunDetail id={selected} onClose={() => { setSelected(''); setRefresh(n => n + 1); }}/> : <section className="card"><div className="card-heading"><h2>歷次評估</h2><button onClick={() => setRefresh(n => n + 1)}>重新整理</button></div><div className="table-wrap"><table><thead><tr><th>資料集 / 時間</th><th>模型</th><th>門檻</th><th>F1</th><th>態樣準確率</th><th>狀態</th></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td><button className="text-button" onClick={() => setSelected(r.id)}>{r.dataset_name}</button><p className="muted small">{new Date(r.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</p></td><td>{r.models.join('、') || r.requested_model}</td><td>{r.threshold}</td><td>{pct(r.summary?.binary_at_default_threshold.f1)}</td><td>{pct(r.summary?.category.scam_category_accuracy)}</td><td><span className="tag">{statuses[r.status]}</span></td></tr>)}</tbody></table></div>{!runs.length && <p className="empty">還沒有評估紀錄。先建立一份測試資料集。</p>}<div className="pagination"><button disabled={page === 1} onClick={() => setPage(p => p - 1)}>上一頁</button><span>第 {page} 頁</span><button disabled={!more} onClick={() => setPage(p => p + 1)}>下一頁</button></div></section>)}
  </>}</>;
}
function App() {
  const internal = location.pathname.startsWith('/admin');
  const [dark, setDark] = useState(() => localStorage.getItem('jev-theme') === 'dark' || (!localStorage.getItem('jev-theme') && matchMedia('(prefers-color-scheme: dark)').matches));
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('jev-theme', dark ? 'dark' : 'light'); }, [dark]);
  return <><header className="site-header"><a className="brand" href="/"><span className="brand-mark">165</span><span>Open165Check<span className="brand-sub">訊息風險檢查</span></span></a><div className="header-actions"><a href={internal ? '/' : '/admin'}>{internal ? '公開查詢' : '內部登入'}</a><button aria-label="切換深色模式" onClick={() => setDark(v => !v)}>{dark ? '☀ 淺色' : '◐ 深色'}</button></div></header>
  <main>{internal ? <Admin/> : <><section className="hero"><div className="eyebrow"><span className="dot"/> 先停一下，再做決定</div><h1>可疑訊息，<br/><em>多一層判斷。</em></h1><p>收到要求付款、點擊連結或提供資料的訊息？<br/>貼上文字，檢查可能的詐騙態樣與風險信號。</p><div className="hero-meta"><span>01 貼上文字</span><span>02 分析信號</span><span>03 官方查證</span></div></section><Classifier/><section className="safety-grid"><article><span>↗</span><h3>網址不會被開啟</h3><p>只分析訊息中的文字，並不確認網站本身是否安全。</p></article><article><span>◈</span><h3>查詢全文不留存</h3><p>本站只保留必要營運紀錄；分析內容會送往 TypeSafe Jev。</p></article><article><span>!</span><h3>有疑慮，先停止操作</h3><p>不要依訊息中的聯絡方式查證，請自行尋找官方管道。</p></article></section></>}</main><footer>Open165Check 訊息風險檢查 <span>模型判斷供參考，請保持查證習慣。</span></footer></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
