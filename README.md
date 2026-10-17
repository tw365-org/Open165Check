# Open165Check｜開放防詐訊息檢查

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/tw365-org/Open165Check/actions/workflows/ci.yml/badge.svg)](https://github.com/tw365-org/Open165Check/actions/workflows/ci.yml)

以台灣繁體中文為主的訊息風險檢查與模型評估工具。民眾可貼上可疑訊息，管理人員可用 CSV 測試集分析漏判、誤判與判斷門檻。目前判斷引擎整合 TypeSafe Jev。

**獨立、非官方專案。** 名稱向台灣 165 防詐意象致意，與警政署、165.gov.tw 及既有 Open165 社群專案無隸屬或背書關係。

程式碼採 [MIT 授權](LICENSE)。Jev 是外部服務，開源程式碼不包含 API 金鑰、免費用量或上游服務授權；部署者須自行申請、確認使用條件與資料政策。

## 第一版能力

- 公開文字查詢：態樣機率、風險信號、Turnstile 與匿名額度控制。
- 私有評估後台：Cloudflare Access、CSV 上傳、歷史紀錄、混淆矩陣、門檻掃描及漏判／誤判篩選。
- 資料保護：個資格式檢查、公開查詢不留存全文、內部樣本到期清除。
- 本機固定回應模式、25 筆虛構案例及自動化測試，不需要真實 Jev 即可驗證操作流程。

開發貢獻請見 [CONTRIBUTING.md](CONTRIBUTING.md)，資安問題請依 [SECURITY.md](SECURITY.md) 私密回報。

繁體中文公開訊息風險查詢，以及受 Cloudflare Access 保護的內部評估後台。React / Vite / TypeScript / Worker / D1。這個專案尚未完成真實 Jev 或雲端部署驗證，不能把本機固定回應當成偵測能力證明。

## 本機啟動

需要 Node.js 22.22 以上、npm、Python 3（僅用於離線腳本及交叉驗證）。實際驗證結果見 `VALIDATION.md`。

```powershell
npm ci
npm run build
Copy-Item .dev.vars.example .dev.vars.local
npm run db:local
npm run dev:worker
```

編輯被忽略的 `.dev.vars.local`：設定自己的隨機 `RATE_LIMIT_SECRET`，若僅做離線操作驗收，將 `LOCAL_MOCK_JEV=true`。本機後台身分由 `LOCAL_ADMIN_EMAIL` 指定，僅在 `ENVIRONMENT=local` 且請求主機為 localhost / 127.0.0.1 時生效。到終端顯示的網址使用公開頁及 `/admin`。開發前端可另開 `npm run dev`，由 Vite 將 `/api` 轉送至本機 Worker。

本機離線模型只按「保證獲利」關鍵字產生固定回應，其餘視為正常，**只用於流程測試**。公開頁仍需要 Turnstile 網路驗證。本機設定使用 Cloudflare 官方測試 sitekey / secret，正式環境必須換成真實元件。

官方測試 token 的 Siteverify 回應可能為 `example.com` 且無 action；只有本機、官方測試金鑰及精確 dummy token 可接受此已知格式。正式環境仍需 success、`classify` action 與設定的精確 hostname，並拒絕測試金鑰。

套件下載若遇企業 CA 憑證問題，可在該終端使用 `$env:NODE_OPTIONS='--use-system-ca'` 後重試；不要關閉 TLS 憑證驗證。

## 使用方式

- 公開頁：貼上不含個資的文字，完成 Turnstile 後分析。最多 10,000 字元，網址僅作字串分析。
- 內部後台：建立 CSV 評估，預覽前 5 筆，再到詳情點「開始同步評估」。需保持頁面開啟，最多執行 240 秒，不自動續跑。中斷結果於下一次讀取或排程時修復；失聯的 running 狀態在 10 分鐘後轉為中斷。
- CSV 格式：UTF-8，可有 BOM；必要 `id,text,label,category`，可選 `variant`。`label` 為 `scam` / `legit`；正常態樣必須為 `正常訊息`，詐騙態樣必須為 10 種既定選項之一。上限 1 MB / 300 筆，範例為 `data/fictional-25.csv`，全部虛構。
- 詳情頁可調整門檻、篩選漏判／誤判、查看模型版本與設定版本。重算由後端完成，不呼叫 Jev。分數未經校準，低分不能保證安全。
- 單則內部測試不保存文字或完整輸出，只留身分、時間、狀態、延遲及可用的 token 耗用量。

## 測試

```powershell
npm run check
npm test
npm run test:python
npm run build
npx playwright install chromium
npm run test:e2e
```

Worker 測試在 workerd + 本機 D1 執行，不存取真實 Jev。Python 與 TypeScript 使用相同的固定回應、問題定義及指標預期值。瀏覽器測試涵蓋桌面、手機、公開狀態及真實本機後台的 25 筆執行；公開 Turnstile 及模型的瀏覽器回應為 mock，真實 token 成功與重放拒絕仍需 staging 驗證。

Promptfoo 僅供開發驗證，使用原生 `typesafe` provider，套件隔離於 `tools/promptfoo`，避免其大量模型供應商依賴影響平台安裝。先執行 `npm install --prefix tools/promptfoo`，將 `TYPESAFE_API_KEY` 從自己的安全終端環境提供，再執行 `npm run eval:promptfoo`；這會呼叫真實服務並產生費用，不包含在一般測試內。修改題目時同步更新 `src/shared/definitions.ts`、Python 定義、固定題目 fixture 與 Promptfoo 設定，測試會檢查跨語言一致性。

## 部署前置條件

1. Cloudflare 帳號具有 Worker、D1、Access、Turnstile 權限；同步批次需使用能承受該批次 D1 / 外呼數的方案，建議 Workers Paid。免費方案的查詢及外呼限制可能使 300 筆執行失敗。確認帳號實際限額並以 staging 驗收容量，無法承受時降低批次上限。
2. 指定 staging 與 production 網域，各環境建立獨立 D1、Access application、Turnstile widget 與 Secret。`wrangler.jsonc` 的資料庫 ID / hostname / Access audience 空值為必填占位，不能直接部署。
3. 確認 TypeSafe 資料處理條款、保存政策、資料落地及對外服務使用條件。在確認前僅使用完全虛構資料。本站不保存公開全文不代表上游供應商不保存資料。
4. 選定可用的固定 Jev 版本填入 `JEV_MODEL`。開發預設 `jev-latest`；此別名可能改變，run 另記實際模型，且執行前不更換該 run 的題目設定。

## staging → production

先登入已核准的 Cloudflare 帳號。以下指令需由擁有帳號的人在自己的終端執行，不要把任何 Secret 貼進聊天或參數中。

```powershell
npx wrangler d1 create open165check-staging
npx wrangler secret put JEV_API_KEY --env staging
npx wrangler secret put TURNSTILE_SECRET --env staging
npx wrangler secret put RATE_LIMIT_SECRET --env staging
```

將建立出的 D1 ID 填入 staging 設定；設定 `EXPECTED_HOSTNAMES`（精確 hostname，不含協定或路徑）、`TURNSTILE_SITE_KEY`、`ACCESS_TEAM_DOMAIN`（例如 `team.cloudflareaccess.com`）、`ACCESS_AUD`。在 Cloudflare Dashboard 為 Worker 綁定指定 custom domain。若使用設定檔管理網域，可在相應 env 加入 `routes: [{ pattern: "你的網域", custom_domain: true }]`。

Access 分別保護同一網域的 `/admin*` 與 `/api/admin/*`，僅允許內部信箱群組，啟用 SSO 或一次性 PIN；公開 `/`、`/api/config`、`/api/classify` 不套用此內部政策。Worker 額外驗證 Access JWT 的簽章、期限、issuer、audience 與 email，不接受單獨的身分標頭。`workers.dev` 與預覽網址預設關閉。

Turnstile widget action 為 `classify`。後端同時檢查成功、action、hostname。正式環境 hostname 不得包含 localhost / 127.0.0.1；不可使用 Cloudflare 測試金鑰。`RATE_LIMIT_SECRET` 使用獨立隨機密鑰，不重用 Jev 金鑰；輪替會重設 IP 額度識別。

```powershell
npm run build
npx wrangler d1 migrations apply DB --remote --env staging
npm run deploy:staging
```

staging 驗收：真實 Turnstile 成功一次及同 token 重放失敗、未授權後台拒絕、真實 Jev 單筆格式、25 筆虛構 run、部分錯誤與門檻重算、檢查前端與回應沒有 Secret。以測試結果記錄實測時間與模型版本，不把固定回應測試時間當成上游 SLA。

通過後，為 production 重做資源建立與 Secret 設定，使用獨立 D1 ID、網域及 Access audience：

```powershell
npx wrangler d1 migrations apply DB --remote --env production
npm run deploy:production
```

正式環境不得設定 `LOCAL_ADMIN_EMAIL` 或 `LOCAL_MOCK_JEV`。資料遷移先在 staging 驗證，部署回復使用 Cloudflare Worker version rollback；D1 需另行備份與依資料庫復原程序處理，不假設 Worker 回復能還原資料庫。

## 保留、營運及限制

- 公開請求只寫必要營運紀錄，不存全文、完整模型輸出、輸入雜湊或原始 IP。HMAC IP 識別按小時變更，額度與 lease 紀錄到期 48 小時後由每小時排程清除（最長另加一次排程間隔）。
- 每 IP 每小時 10 次；全站依 Asia/Taipei 日期每日 500 次。D1 以條件插入＋trigger 在同一原子操作同時消耗兩種額度。額度按送出請求計，不因上游失敗退還；內部評估不計入匿名額度。
- 內部樣本文字與 variant 在 180 天後清除，保留去識別化 ID、標籤、模型結果及彙總。稽核紀錄預設也保留 180 天。D1 備份／Time Travel 的供應商保存政策需另行納入資料治理。
- 身分證與信用卡有校驗；手機依格式；帳號、病歷號、員工編號依明確文字上下文檢查。此規則不會辨識所有姓名、地址、特殊格式或刻意混淆資料，使用者仍須事先去識別化。
- Logs / Traces 不寫入樣本或金鑰，錯誤只記代碼。使用 Cloudflare Dashboard 觀察錯誤率、延遲、D1 用量與限流狀況。公開分數不作為封鎖、通報或司法判斷依據。
- 同步處理可能因瀏覽器、代理或執行環境限制中斷；不承諾 300 筆都在 240 秒完成。頁面能看到已保存結果，但不會自動重試整個 run。
- 全數失敗為 `failed`；錯誤比例超過 10% 為 `degraded`；有成功但執行中斷為 `interrupted`。`done` 仍可能有少量錯誤，必須同看成功率。

## 開源方案取捨

正式 Worker 直接呼叫 Jev，Promptfoo 僅作固定案例回歸，避免將整套工具加入邊緣執行環境。[Promptfoo Jev 整合](https://www.promptfoo.dev/docs/providers/typesafe/)。

未來候選：Cofacts 用於相似案例與查證證據（程式碼 MIT、資料另有 CC BY-SA 條款）；Label Studio 用於人工標註；Langfuse 用於多模型實驗及追蹤；Rspamd 用於完整郵件的規則基準。這些服務均未在第一版傳輸資料或成為部署依賴。

來源：[Cofacts](https://github.com/cofacts/rumors-api)、[資料條款](https://github.com/cofacts/rumors-api/blob/master/LEGAL.md)、[Label Studio](https://github.com/HumanSignal/label-studio)、[Langfuse](https://langfuse.com/self-hosting)、[Rspamd](https://docs.rspamd.com/developers/protocol/)、[Jev API](https://docs.typesafe.ai/api)、[Turnstile Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。
