import { chromium } from 'playwright-core';
import { findBrowser } from '../src/sources/xhs.js';

const BASE = 'http://127.0.0.1:8787';
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${BASE}/overlay`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const out = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.row')].slice(0, 8).map((r) => {
    const body = r.querySelector('.body');
    const nick = r.querySelector('.nick');
    const cs = body ? getComputedStyle(body) : null;
    return {
      cls: r.className,
      nickText: nick?.textContent,
      nickColor: nick ? getComputedStyle(nick).color : null,
      bodyText: body?.textContent,
      bodyColor: cs?.color,
      bodyHtml: body?.innerHTML?.slice(0, 120),
      hlCount: r.querySelectorAll('mark.hl').length,
    };
  });
  return {
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    colorVar: getComputedStyle(document.body).getPropertyValue('--color'),
    rows,
    stylesheets: [...document.styleSheets].map((s) => s.href),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
