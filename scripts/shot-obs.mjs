/** 临时：按 OBS 浏览器源尺寸（800x1000）检查排版 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const W = Number(process.argv[2] || 800);
const H = Number(process.argv[3] || 1000);
const name = process.argv[4] || `obs-${W}x${H}`;

const TEXTS = [
  '主播好厉害！',
  '这个颜色也太好看了吧！！我昨天在别家买的同款完全不是这个色',
  '求链接',
  '这个颜色也太好看了吧！！我昨天在别家买的同款完全不是这个色，主播能不能讲讲这次的面料和做工',
  '已下单',
  '什么时候上架',
  '能不能再便宜一点呀主播，我想买两件',
];

const post = (body) =>
  fetch('http://127.0.0.1:8787/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto('http://127.0.0.1:8787/overlay', { waitUntil: 'networkidle' });
await page.evaluate(() =>
  document.documentElement.style.setProperty(
    'background',
    'linear-gradient(150deg,#0f2027,#203a43 45%,#2c5364)',
    'important',
  ),
);
await page.waitForTimeout(400);

const names = ['不加香菜', '芝士就是力量', 'momo', '阿柚柚', '海边散步', '小熊软糖', '橘子汽水'];
for (let i = 0; i < TEXTS.length; i += 1) {
  await post({ kind: i === 3 ? 'follow' : 'comment', name: names[i], text: TEXTS[i] });
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1200);

const rows = await page.$$eval('.row', (els) =>
  els.map((e) => {
    const card = e.querySelector('.card');
    const body = e.querySelector('.body');
    const r = card.getBoundingClientRect();
    const lh = body ? parseFloat(getComputedStyle(body).lineHeight) : 0;
    return {
      kind: [...e.classList].find((c) => c.startsWith('row--')),
      w: Math.round(r.width),
      h: Math.round(r.height),
      lines: body && lh ? Math.round(body.getBoundingClientRect().height / lh) : 0,
    };
  }),
);
console.table(rows);
const list = await page.$eval('.list', (e) => {
  const r = e.getBoundingClientRect();
  return { w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) };
});
console.log('list', JSON.stringify(list), 'viewport', W, 'x', H);

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
await page.screenshot({ path: path.join(ROOT, 'shots', `${name}.png`) });
console.log('->', path.join(ROOT, 'shots', `${name}.png`));
await browser.close();
process.exit(0);
