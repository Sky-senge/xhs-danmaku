import { chromium } from 'playwright-core';
import { findBrowser } from '../src/sources/xhs.js';
import { THEME_BUNDLES } from '../web/shared/themes.js';

const BASE = 'http://127.0.0.1:8787';
const THEMES = ['bubble', 'minimal', 'capsule', 'neon', 'glass'];

async function setTheme(theme) {
  const { config } = await (await fetch(`${BASE}/api/config`)).json();
  const next = { ...config, overlay: { ...config.overlay, theme, ...(THEME_BUNDLES[theme] || {}) } };
  const r = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!r.ok) throw new Error(`PUT config failed ${r.status}`);
}

const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
for (const theme of THEMES) {
  await setTheme(theme);
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await page.goto(`${BASE}/overlay`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      'background',
      'linear-gradient(150deg,#0f2027,#203a43 45%,#2c5364)',
      'important',
    );
  });
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `shots/theme-${theme}.png` });
  await page.close();
  console.log('shot', theme);
}
await setTheme('bubble');
await browser.close();
