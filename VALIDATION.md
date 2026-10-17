# 本機驗證紀錄

驗證日期：2026-10-17（Asia/Taipei）

## 已通過

| 檢查 | 結果 |
|---|---|
| Wrangler 產生 binding types、TypeScript、Vite 正式建置 | 通過 |
| Worker 單元／整合測試 | 22 / 22，workerd + 本機 D1 |
| Python 離線及跨語言 fixture 測試 | 6 / 6 |
| Playwright 桌面／手機操作驗收 | 6 / 6 |
| staging 部署封裝 dry-run | 通過；未部署雲端資源 |
| 部署前置檢查 | 正確拒絕尚未填入的 D1 / hostname / Turnstile / Access 設定 |

瀏覽器最終一輪共 34.6 秒；25 筆虛構樣本的操作案例桌面 4.5 秒、手機 2.9 秒，**包含上傳與操作步驟，且使用固定本機回應，不能推論真實 Jev 延遲或偵測品質**。截圖於 test-results 產生並已檢查，非版本控制內容。

測試涵蓋：合法／非法 Jev 回應、固定指標、F1 零值、CSV 多行及邊界、台灣個資格式、公開查詢不保存全文、Turnstile action／hostname／重放失敗、匿名額度競爭及台北跨日、有效／過期／錯誤 audience Access JWT、前後台隔離、部分／全部失敗、期限中斷、重複執行拒絕、後端重算門檻、漏判／誤判篩選、180 天清除、桌面／手機及深色模式。

另以官方 dummy token / secret 實際呼叫 Siteverify，並成功完成本機 `/api/classify` 流程（模型仍為 `local-fixture-v1`）。官方測試回應實測為 `hostname=example.com` 且無 action，與文件範例不同；程式僅在 localhost + local 環境 + 官方測試金鑰及精確 dummy token 時接受此已知格式，部署環境仍拒絕測試金鑰。測試 token 的成功不能證明真實 token 或重放防護已完成 staging 驗證。

## 待完成的實際環境驗證

- TypeSafe 資料處理與對外使用條件確認。
- 正式 Jev 單筆回應、實際模型版本、25 筆虛構資料執行時間與成本。
- Promptfoo 透過真實 Jev 的回歸執行；目前只驗證其設定與題目一致，沒有消耗真實 API。
- 真實 Turnstile token 成功與重放拒絕；本機以 mock 及官方測試設定驗證契約。
- staging 網域、獨立 D1、Secret、Access 政策及 Cloudflare 帳號實際批次容量。
- staging 通過後的 production 部署及排程／監控驗證。

本次沒有建立雲端資源、寫入真實 Secret 或對外發布網站。必要設定與部署步驟見 README。
