# SDD：Open165Check 對外防詐服務與內部評估平台

版本：v0.2（實作基線）　日期：2026-10-17

## 1. 目標與使用者

公開頁讓民眾貼上去識別化文字，查看風險分數、可能態樣及風險信號；內部資安人員透過 Access 登入後，建立及管理批次評估，調整門檻、分析誤判與漏判。第一版不開啟網址、不處理圖片、不自動封鎖、不提供民眾批次上傳或查詢歷史。

## 2. 架構與介面

React + Vite + TypeScript 建置靜態頁，由同一 Cloudflare Worker 提供資產與 API，D1 儲存內部評估與必要營運紀錄。所有資產經 Worker 路由，確保 /admin 受保護。Cloudflare Access 保護 /admin* 與 /api/admin/*，Worker 額外驗證 JWT 簽章、issuer、audience、期限與 email；原 v0.1 僅檢查 email 標頭的要求由此取代。

公開介面繁體中文、支援手機與深色模式；風險分數不是經校準的真實詐騙機率。公開頁呈現資料傳輸說明與低風險仍需查證的提醒。

| 方法 | 路徑 | 行為 |
|---|---|---|
| GET | /api/config | 公開 sitekey、預設門檻與字數限制，無 Secret |
| GET | /api/health | 不呼叫 Jev 的健康檢查 |
| POST | /api/classify | JSON text、token；Turnstile 與匿名限額；不保存全文或結果 |
| GET | /api/admin/me | 驗證內部身分 |
| POST | /api/admin/classify | 內部單則測試；只保存稽核資料 |
| POST | /api/admin/runs | multipart file、threshold，完整驗證後建立 queued run，回傳 run_id |
| POST | /api/admin/runs/:id/execute | 原子取得 queued run，同步執行並回傳最終結果；重複執行為 409 |
| GET | /api/admin/runs | 每頁 20 筆，page 分頁，建立時間倒序 |
| GET | /api/admin/runs/:id | 指標、進度、設定版本、資料集指紋及模型版本 |
| GET | /api/admin/runs/:id/results | 每頁 50 筆；label、misses=1、false_positives=1 篩選 |
| PATCH | /api/admin/runs/:id/threshold | 完成後以既有有效結果於後端重算，不再次呼叫 Jev |

錯誤格式：`{ "error": { "code": "VALIDATION_ERROR", "message": "第 2 行：…" } }`。錯誤不包含樣本全文或供應商原始內容。

## 3. Jev 契約與評估

端點 `https://api.typesafe.ai/v1/systemone`，Bearer Secret 認證。預設開發模型 jev-latest；staging / production 建議固定已驗證版本。每則一次請求，questions 同時包含 11 選項 Choice 與 12 項 Noul，問題以 shared/definitions 與 Python 定義及固定 fixture 測試對齊。

官方 https://docs.typesafe.ai/api 已於 2026-10-17 文件查證：Choice 有 type、choice、probabilities（各選項分布）與 confidence；Noul 有 type、noul；頂層 model 為實際模型版本、usage 為 token 計數。本平台使用 probabilities、noul、model、usage；confidence 不作風險門檻。真實 API 單筆與 staging 驗證仍待部署階段完成。

所有必要使用欄位須存在，機率須為有限 0–1、完整選項且總和約為 1，choice 須為合法最高機率選項，12 個信號須完整。非法回應標記 INVALID_RESPONSE，不做硬判斷降級。429、5xx（含 529）與暫時網路錯誤有限次退避重試，最多 5 次嘗試；其他 4xx 不重試。單次請求 timeout 15 秒，公開與內部單則整體預算 45 秒。

`p_scam = 1 - P(正常訊息)`，`p_scam >= threshold` 視為詐騙，預設 0.7。有效樣本才計入二元與態樣指標；報表同時顯示總數、有效數、錯誤數與成功率。F1 直接由混淆計數計算 `2TP/(2TP+FP+FN)`，有分母但零命中為 0，零分母為 null。態樣準確率僅計有效詐騙樣本，門檻掃描 0.3–0.9 每 0.1。另提供完整態樣混淆明細。

## 4. 批次與資料

CSV UTF-8，可有 BOM，上限統一為 **1 MB、300 筆**；id、text、label、category 必填，variant 選填。scam 對應 10 種詐騙態樣之一，legit 對應正常訊息。同檔 id 不重複。單則文字上限 10,000 字元，保留欄位也需個資檢查，首個錯誤回傳實際起始行號。

run 先建立，再由使用者啟動同步執行；並行 5、總預算 240 秒，完成一筆即保存。關閉頁面後不保證繼續，不自動續跑。超時標記尚未完成項目 TIMEOUT，斷線為 INTERRUPTED；失聯 running 超過 10 分鐘由讀取或排程修復。全數失敗為 failed；有成功且中斷為 interrupted；完整結束但錯誤比例 >10% 為 degraded，其餘 done（仍顯示少量錯誤）。

D1 schema 以 migrations/0001_initial.sql 為準：runs 保存建立身分、時間、資料集名稱與 SHA-256、設定版本與題目快照、請求模型、實際模型清單、門檻、進度、狀態與摘要；results 保存每筆標註、去識別化文字、完整機率、信號、模型、延遲、嘗試數與錯誤碼。audit_events 獨立保存內部與匿名操作的必要 metadata；rate_counters 與 quota_leases 用於原子限額。

## 5. 公開服務與資料保護

公開請求必須先驗證輸入，再以 Siteverify 驗證 Turnstile success、action=classify 與精確 hostname。單次 token 生命週期由 Siteverify 驗證；頁面每次送出後重新取得 token。每 IP 每小時 10 次、全站依台北日期每日 500 次，以 D1 原子判斷與扣除，並行請求不可超額。送出後上游失敗不退額。額度為平台請求限制，非帳單保證。

IP 以帶密鑰 HMAC 按小時識別，不保存原始 IP，48 小時到期後由每小時排程清除。公開全文與輸出不寫入資料庫或日誌。僅保存時間、匿名 actor、狀態、耗用量及延遲，稽核預設保留 180 天。內部 results 文字與 variant 保留 180 天後清除，彙總與去識別化標註留存。供應商備份與資料保留需另確認。

前後台輸入在送往 Jev 前先檢查：台灣身分證與信用卡依校驗、手機依格式、帳號／病歷號／員工編號依上下文。命中拒絕並提示自行替換，不回顯個資。規則不能保證完整去識別化，使用者仍需自行確認；院內資料及外部服務條款未確認前只使用虛構資料。

Secret 僅由後端讀取，雲端使用 Worker Secret；localhost 可使用被忽略的本機開發檔。正式環境不得啟用開發身分或假模型；程式僅允許 local 環境及本機 host 使用開發身分。production 停用 workers.dev 與 preview URL，所有後台路徑須經 Access。日誌及追蹤僅記錄安全代碼，不記全文、token 或金鑰。

## 6. 開源重用與部署

Promptfoo 透過原生 typesafe provider 執行開發回歸，正式 Worker 直接呼叫 Jev。Cofacts（資料與查證）、Label Studio（標註）、Langfuse（多模型追蹤）、Rspamd（郵件規則比較）記為未來候選，第一版不傳資料至這些服務。

staging 與 production 各有獨立 D1、Secret、網域、Turnstile 與 Access audience。先 build，套用 D1 migrations，部署 staging，真實驗收後才部署 production。同步 run 容量需按 Cloudflare 帳號實際外呼及 D1 限額驗收，不能只靠本機成功推論可在免費方案執行 300 筆。

部署說明、必要設定、驗證清單與回復程序詳見 README。未提供網域、帳號資源及 Jev 金鑰之前，可完成本機程式與 mock 驗收，不能宣稱已完成真實 API 或正式部署。

## 7. 驗收

- Worker 單元及整合測試：公開成功／失敗、非法輸入、個資、Turnstile hostname/action、額度競爭與台北跨日、上游永久錯誤與重試、後台身分隔離。
- 評估：CSV 邊界及實際行號、有效回應、全數失敗、部分失敗、逾時與中斷、重複執行拒絕、門檻不重呼 API、資料保留。
- Python 與 TypeScript 固定回應、問題定義、混淆計數與 F1 完全一致。
- 桌面與手機瀏覽器：公開輸入／錯誤／結果／深色模式、CSV 非法提示、25 筆虛構流程、門檻與漏判篩選。
- staging：真實 token 成功與重放拒絕、真實 Jev 格式與模型版本、25 筆實測時間、Access 遮斷、無 Secret 洩漏。此項須另記錄真實驗證證據。
