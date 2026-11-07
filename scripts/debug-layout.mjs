import { chromium } from 'playwright-core';
import { findBrowser } from '../src/sources/xhs.js';

const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('http://127.0.0.1:8787/overlay', { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

const info = await page.evaluate(() => {
  const stage = document.querySelector('.stage');
  const list = document.querySelector('.list');
  const rows = [...list.children].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: el.className,
      leaving: el.dataset.leaving || '',
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      style: el.getAttribute('style') || '',
    };
  });
  return {
    viewport: { w: innerWidth, h: innerHeight },
    stage: stage.getBoundingClientRect().toJSON(),
    list: list.getBoundingClientRect().toJSON(),
    listStyle: {
      justify: getComputedStyle(stage).justifyContent,
      marginTop: getComputedStyle(list).marginTop,
      gap: getComputedStyle(list).gap,
    },
    rows,
    bodyH: document.body.getBoundingClientRect().height,
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
