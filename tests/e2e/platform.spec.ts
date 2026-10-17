import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import jev from '../fixtures/jev.json' with { type: 'json' };
test('public lookup handles verification, privacy errors, success and theme', async ({ page }, testInfo) => {
  // Browser contract test; the real server-side Turnstile contract is tested separately.
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', route => route.fulfill({ contentType: 'application/javascript', body: 'window.turnstile={render:(el,opts)=>{el.textContent="測試驗證已完成";opts.callback("test-token");return "test"},remove:()=>{},reset:()=>{}};' }));
  await page.route('**/api/classify', async route => {
    const data = route.request().postDataJSON();
    if (data.text.includes('0912')) return route.fulfill({ status:400, json:{error:{code:'PII_DETECTED',message:'偵測到手機號碼，請先替換'}} });
    return route.fulfill({ json:{choice:'假投資',p_scam:.99,probabilities:jev.answers.category.probabilities,signals:Object.fromEntries(Object.keys(jev.answers).filter(k=>k!=='category').map(k=>[k,.8])),model:'fixture-v1',usage:{input_tokens:100,output_tokens:20}} });
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/可疑訊息，\s*多一層判斷。/})).toBeVisible();
  await page.getByLabel('訊息內容').fill('電話0912345678');
  await page.getByRole('button',{name:'檢查訊息風險'}).click();
  await expect(page.getByRole('alert')).toContainText('手機號碼');
  await page.getByLabel('訊息內容').fill('保證獲利請立即入金');
  await page.getByRole('button',{name:'檢查訊息風險'}).click();
  await expect(page.getByRole('heading',{name:'這則訊息需要提高警覺'})).toBeVisible();
  await expect(page.getByText('99.0',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'切換深色模式'}).click();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path:testInfo.outputPath('public-dark.png'), fullPage:true });
});
test('25 fictional samples complete, reports filter and threshold recalculates', async ({ page }, testInfo) => {
  await page.goto('/admin');
  await page.getByRole('button',{name:'建立評估',exact:true}).click();
  await page.getByLabel('選擇 CSV').setInputFiles({ name:'fictional-25.csv', mimeType:'text/csv', buffer:readFileSync('data/fictional-25.csv') });
  await expect(page.getByRole('heading',{name:'前 5 筆預覽'})).toBeVisible();
  await page.getByRole('button',{name:'建立評估',exact:true}).last().click();
  await page.getByRole('button',{name:'開始同步評估'}).click();
  await expect(page.getByText('25 / 25 筆已處理',{exact:false})).toBeVisible({timeout:60000});
  await expect(page.getByText('有效樣本 25 / 25',{exact:false})).toBeVisible();
  await expect(page.locator('tbody').last().getByRole('row').first()).toContainText('完成');
  await page.screenshot({ path:testInfo.outputPath('admin-report.png'), fullPage:true });
  await page.getByLabel('結果篩選').selectOption('&misses=1');
  await expect(page.locator('tbody').last().getByRole('row')).toHaveCount(9);
  await page.getByLabel('判斷門檻').fill('0.05');
  await page.getByRole('button',{name:'更新指標'}).click();
  await expect(page.getByText('此篩選沒有結果。')).toBeVisible();
});
test('invalid CSV produces actionable validation error', async ({ page }) => {
  await page.goto('/admin');
  await page.getByRole('button',{name:'建立評估',exact:true}).click();
  await page.getByLabel('選擇 CSV').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from('id,text,label,category\na,你好,scam,正常訊息')});
  await page.getByRole('button',{name:'建立評估',exact:true}).last().click();
  await expect(page.getByRole('alert')).toContainText('第 2 行');
});
