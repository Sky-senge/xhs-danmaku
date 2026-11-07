/** 验证「控制台改样式 → 弹幕层实时生效」这条链路（不刷新页面） */
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/sources/xhs.js';

const BASE = 'http://127.0.0.1:8787';

const { config } = await (await fetch(`${BASE}/api/config`)).json();
const put = async (patch) => {
  const body = { ...config, overlay: { ...config.overlay, ...patch } };
  const r = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${r.status}`);
  return (await r.json()).config;
};

const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${BASE}/overlay`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const before = await page.evaluate(() => ({
  theme: document.body.dataset.theme,
  align: document.body.dataset.align,
  fontSize: getComputedStyle(document.querySelector('.card') || document.body).fontSize,
}));

await put({ theme: 'neon', align: 'right', fontSize: 34, maxItems: 8 });
await page.waitForTimeout(1200);

const after = await page.evaluate(() => ({
  theme: document.body.dataset.theme,
  align: document.body.dataset.align,
  fontSize: getComputedStyle(document.querySelector('.card') || document.body).fontSize,
  rows: document.querySelectorAll('.row').length,
}));

console.log('before', JSON.stringify(before));
console.log('after ', JSON.stringify(after));
console.log(after.theme === 'neon' && after.align === 'right' && after.fontSize === '34px' ? 'LIVE-UPDATE OK' : 'LIVE-UPDATE FAIL');

await put({ theme: config.overlay.theme, align: config.overlay.align, fontSize: config.overlay.fontSize, maxItems: config.overlay.maxItems });
await browser.close();
