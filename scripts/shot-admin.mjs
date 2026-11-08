/**
 * 控制台截图 + 交互冒烟
 * node scripts/shot-admin.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && fs.existsSync(p));

if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1020 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

const shot = async (name, full = false) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
  console.log('  → shots/' + name + '.png');
};

console.log('样式页');
await shot('admin-style');

// 主题卡片：点霓虹，确认写回配置
await page.click('.theme-card[data-theme="neon"]');
await page.waitForTimeout(700);
let cfg = (await (await fetch(`${BASE}/api/config`)).json()).config;
console.log('  主题 =', cfg.overlay.theme, cfg.overlay.theme === 'neon' ? 'OK' : 'FAIL');
// 主题必须把观感一起写进配置（否则会被主题 CSS 覆盖，改成配置驱动）
const neonOk =
  cfg.overlay.card.bg === 'rgba(6,8,16,0.68)' &&
  cfg.overlay.card.radius === 8 &&
  cfg.overlay.textStroke === false &&
  cfg.overlay.nicknameColor === '#59f0ff';
console.log('  主题观感 =', neonOk ? 'OK' : `FAIL ${JSON.stringify({
  bg: cfg.overlay.card.bg,
  radius: cfg.overlay.card.radius,
  stroke: cfg.overlay.textStroke,
  nick: cfg.overlay.nicknameColor,
})}`);

// 一键风格：带货醒目
await page.click('[data-preset="sales"]');
await page.waitForTimeout(700);
cfg = (await (await fetch(`${BASE}/api/config`)).json()).config;
console.log(
  '  预设 =',
  cfg.overlay.theme,
  cfg.overlay.fontSize,
  cfg.overlay.card.radius,
  cfg.overlay.theme === 'capsule' && cfg.overlay.fontSize === 30 ? 'OK' : 'FAIL',
);
await shot('admin-preset-sales');

// 回到经典
await page.click('[data-preset="classic"]');
await page.waitForTimeout(600);

// 各标签页
for (const tab of ['source', 'voice', 'message', 'filter', 'advanced', 'debug']) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(350);
  console.log('标签页', tab);
  await shot(`admin-${tab}`);
}

// 保存提示
await page.click('.tab[data-tab="style"]');
await page.waitForTimeout(300);
const savedText = await page.textContent('#savedHint');
console.log('  保存提示 =', savedText);

// 预览缩放是否生效
const scale = await page.evaluate(() => document.querySelector('#preview').style.transform);
console.log('  预览缩放 =', scale);

if (problems.length) {
  console.log('\n前端报错:');
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nNO FRONTEND ERRORS');
}

await browser.close();
