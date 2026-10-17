import { readFileSync } from 'node:fs';
const target = process.argv[2];
if (!['staging', 'production'].includes(target)) throw new Error('Specify staging or production');
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const selected = config.env[target], vars = selected.vars;
const errors = [];
if (!selected.d1_databases.every(db => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(db.database_id) && !/^0+-/.test(db.database_id))) errors.push('D1 database_id 尚未設定');
if (!vars.TURNSTILE_SITE_KEY || /^[123]x0+[A-Z]{2}$/.test(vars.TURNSTILE_SITE_KEY)) errors.push('需正式 Turnstile sitekey');
const hosts = vars.EXPECTED_HOSTNAMES.split(',').map(h => h.trim()).filter(Boolean);
if (!hosts.length || hosts.some(h => !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(h) || ['localhost','127.0.0.1'].includes(h))) errors.push('需設定精確正式 hostname');
if (!/^[a-z\d-]+\.cloudflareaccess\.com$/i.test(vars.ACCESS_TEAM_DOMAIN) || !vars.ACCESS_AUD) errors.push('需設定 Access team domain 與 audience');
if (vars.LOCAL_ADMIN_EMAIL || vars.LOCAL_MOCK_JEV) errors.push('雲端環境不得啟用本機測試設定');
if (errors.length) { console.error(`無法部署 ${target}：\n${errors.map(e => `- ${e}`).join('\n')}`); process.exitCode = 1; }
else console.log(`${target} 設定檢查通過。此檢查不驗證雲端 Secret、Access 政策或上游條款。`);
