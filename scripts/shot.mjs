/**
 * 开发用截图脚本：把弹幕层和后台各截一张，方便肉眼检查样式。
 * 用法：node scripts/shot.mjs [theme]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/sources/xhs.js';
import { ROOT } from '../src/config.js';

const OUT = path.join(ROOT, 'shots');
const BASE = 'http://127.0.0.1:8787';
const theme = process.argv[2];

fs.mkdirSync(OUT, { recursive: true });

const exe = findBrowser();
if (!exe) throw new Error('没找到浏览器');

const browser = await chromium.launch({ executablePath: exe, headless: true });

async function shotOverlay(file, { background = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await page.goto(`${BASE}/overlay`, { waitUntil: 'networkidle' });
  if (background) {
    await page.addStyleTag({
      content: `html,body{background:
        radial-gradient(90% 70% at 25% 15%, #3a4a6b 0%, #1b2233 45%, #0b0d12 100%) !important;}`,
    });
  }
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(OUT, file) });
  await page.close();
}

if (theme) {
  await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overlay: { theme } }),
  });
}
await shotOverlay(theme ? `overlay-${theme}.png` : 'overlay.png');

const admin = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await admin.waitForTimeout(2500);
await admin.screenshot({ path: path.join(OUT, 'admin.png'), fullPage: false });
await admin.close();

await browser.close();
console.log('shots ->', OUT);
