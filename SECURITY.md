# 安全問題回報

Open165Check 是獨立社群專案，尚未完成正式服務環境的完整安全及上游驗證。模型風險分數不能保證訊息安全。

若發現權限繞過、金鑰外洩、敏感資料保存、限流繞過或其他可利用問題，請使用 GitHub 的 **Security → Advisories → Report a vulnerability** 私密回報：

https://github.com/tw365-org/Open165Check/security/advisories/new

請提供受影響版本或 commit、使用環境、以虛構資料重現的步驟、預期與實際行為。不要附真實金鑰、個資或受害者訊息。若私密回報功能暫時無法使用，請先建立不含利用細節的 issue，請維護者提供私密聯絡方式。

目前僅維護 main 的最新版本，尚無承諾修復時限。部署者仍須正確設定 Cloudflare Access、Turnstile、Secret、資料保留、上游條款及自身監控。
