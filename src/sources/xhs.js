import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { ROOT } from '../config.js';
import { isDanmakuSocket } from '../xhs/decode.js';
import { consumeFrame } from './frames.js';

const PROFILE_DIR = path.join(ROOT, 'data', 'browser-profile');

/** 常见浏览器安装位置，免去下载 Chromium */
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 小红书直播数据源
 * 思路：用真实浏览器（带持久化登录态）打开主播中控台，
 * 通过 Playwright 的 WebSocket 事件直接拿到帧，再由 decode.js 解析。
 * 好处：签名 / token / 设备指纹全由真实浏览器完成，不需要逆向。
 */
export class XhsSource extends EventEmitter {
  constructor(bus) {
    super();
    this.bus = bus;
    this.context = null;
    this.page = null;
    this.cfg = null;
    this._starting = false;
    this._wsSockets = new Map();
    this._closedByUs = false;
    this.status = {
      running: false,
      state: 'idle', // idle | launching | login-required | capturing | error
      message: '',
      browserPath: '',
      pageUrl: '',
      sockets: 0,
      frames: 0,
      events: 0,
      unknownTypes: {},
      lastFrameAt: 0,
      startedAt: 0,
    };
    this._probeTimer = null;
  }

  setStatus(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.status[k] !== v) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    Object.assign(this.status, patch);
    this.emit('status', this.status);
  }

  async start(cfg) {
    if (this._starting || this.status.running) return this.status;
    this._starting = true;
    this._closedByUs = false;
    // 允许传入整份 config 或只传 config.source
    const sc = cfg?.source ?? cfg ?? {};
    this.cfg = sc;
    this.setStatus({
      running: true,
      state: 'launching',
      message: '正在启动浏览器…',
      startedAt: Date.now(),
      frames: 0,
      events: 0,
      sockets: 0,
      unknownTypes: {},
    });

    try {
      const executablePath = findBrowser();
      if (!executablePath) {
        throw new Error(
          '没找到本机 Chrome / Edge。请安装 Chrome，或设置环境变量 CHROME_PATH 指向浏览器可执行文件。',
        );
      }
      this.setStatus({ browserPath: executablePath });

      fs.mkdirSync(PROFILE_DIR, { recursive: true });

      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath,
        headless: Boolean(sc.headless),
        viewport: null,
        acceptDownloads: false,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--hide-crash-restore-bubble',
          '--disable-blink-features=AutomationControlled',
          '--lang=zh-CN',
          '--start-maximized',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
      });

      this.context.on('page', (p) => this._attachPage(p));
      this.context.on('close', () => this._onContextClosed());

      const pages = this.context.pages();
      const page = pages[0] || (await this.context.newPage());
      this._attachPage(page);
      this.page = page;

      await this._navigateToConsole();
      this._startProbe();
    } catch (err) {
      this.setStatus({ running: false, state: 'error', message: err.message });
      await this._cleanup();
      this.emit('error', err);
    } finally {
      this._starting = false;
    }
    return this.status;
  }

  async _navigateToConsole() {
    const target = this.cfg.consoleUrl;
    this.setStatus({ message: `正在打开中控台：${target}` });
    try {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      this.bus.logRaw({ dir: 'nav-error', url: target, note: err.message });
    }
    this.setStatus({ pageUrl: this.page.url() });
  }

  _attachPage(page) {
    if (!page || page.__xhsAttached) return;
    page.__xhsAttached = true;

    page.on('websocket', (ws) => this._attachSocket(ws));
    page.on('framenavigated', () => {
      if (this.page === page) this.setStatus({ pageUrl: page.url() });
    });
    page.on('close', () => {
      if (this.page === page) this.page = null;
    });

    if (this.cfg?.captureHttp) {
      page.on('response', async (res) => {
        try {
          const url = res.url();
          if (!/danmu|comment|message|im\//i.test(url)) return;
          const ct = res.headers()['content-type'] || '';
          if (!ct.includes('json')) return;
          const body = await res.text();
          if (body.length > 4000) return;
          this.bus.logRaw({ dir: 'http', url, body: body.slice(0, 4000) });
        } catch {
          /* ignore */
        }
      });
    }
  }

  _attachSocket(ws) {
    const url = ws.url();
    const key = `${url}#${Math.random().toString(36).slice(2, 8)}`;
    const relevant = isDanmakuSocket(url);
    this._wsSockets.set(key, { url, relevant, frames: 0, openedAt: Date.now() });
    this.setStatus({ sockets: this._wsSockets.size });
    this.bus.logRaw({ dir: 'ws-open', url, relevant });

    ws.on('framesent', (ev) => {
      // 客户端发的第一帧通常就是 sid 鉴权，记下来方便排错
      const info = this._wsSockets.get(key);
      if (info && info.frames === 0) {
        const text = String(ev.payload ?? '');
        this.bus.logRaw({
          dir: 'ws-send-first',
          url,
          body: text.slice(0, 800),
        });
      }
      if (info) info.frames += 1;
    });

    ws.on('framereceived', (ev) => {
      const text = typeof ev.payload === 'string' ? ev.payload : Buffer.from(ev.payload).toString('utf8');
      consumeFrame({ bus: this.bus, status: this.status, setStatus: (p) => this.setStatus(p) }, text, url, relevant);
    });

    ws.on('close', () => {
      this._wsSockets.delete(key);
      this.setStatus({ sockets: this._wsSockets.size });
    });
  }

  /** 每 1.5 秒检查登录态，未登录时给出引导 */
  _startProbe() {
    clearInterval(this._probeTimer);
    this._probeTimer = setInterval(() => {
      if (!this.page || this.page.isClosed()) return;
      const url = this.page.url();
      this.setStatus({ pageUrl: url });
      if (/customer\.xiaohongshu\.com\/login/i.test(url)) {
        if (this.status.state !== 'login-required') {
          this.setStatus({
            state: 'login-required',
            message: '需要登录小红书：在弹出的浏览器窗口里扫码 / 登录，登录后会自动跳回中控台',
          });
        }
        return;
      }
      if (this.status.state === 'login-required') {
        this.setStatus({
          state: 'launching',
          message: '登录成功，正在进入中控台并等待弹幕通道…',
        });
        return;
      }
      // 打开 20 秒还没有任何 WebSocket：多半是中控台地址不对（方舟对非商家账号只给招商/入驻页）
      if (
        this.status.state === 'launching' &&
        this._wsSockets.size === 0 &&
        Date.now() - this.status.startedAt > 20000
      ) {
        this.setStatus({
          message:
            '还没发现弹幕通道。方舟（ark）是商家后台，非商家账号只会看到招商 / 入驻页；' +
            '达人直播请填蒲公英地址（pgy），或者直接在弹窗里点进能看见弹幕的页面——插件会自动接上任何标签页。',
        });
      }
    }, 1500);
  }

  /**
   * 登录页的 service 参数决定登录后跳回哪个后台。
   * 用户可能把中控台改成蒲公英，所以这里优先跟着 consoleUrl 走，避免登录完又被丢回方舟招商页。
   */
  _loginUrl() {
    const explicit = this.cfg.loginUrl;
    const console_ = this.cfg.consoleUrl || '';
    if (!console_) return explicit;
    const fallback = 'https://customer.xiaohongshu.com/login';
    if (!explicit || !/^https:\/\/customer\.xiaohongshu\.com\/login/i.test(explicit)) return explicit || fallback;
    return `${fallback}?service=${encodeURIComponent(console_)}`;
  }

  async openLogin() {
    if (!this.page) throw new Error('浏览器还没启动');
    await this.page.goto(this._loginUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  async reload() {
    if (!this.page) throw new Error('浏览器还没启动');
    await this.page.goto(this.cfg.consoleUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  async bringToFront() {
    if (this.page) await this.page.bringToFront().catch(() => {});
  }

  _onContextClosed() {
    clearInterval(this._probeTimer);
    const wasOurs = this._closedByUs;
    this.context = null;
    this.page = null;
    this._wsSockets.clear();
    this.setStatus({ running: false, state: 'idle', sockets: 0, message: '浏览器已关闭' });
    if (!wasOurs && this.cfg?.autoReconnect) {
      this.emit('reconnect');
    }
  }

  async _cleanup() {
    clearInterval(this._probeTimer);
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.page = null;
    this._wsSockets.clear();
  }

  async stop() {
    this._closedByUs = true;
    clearInterval(this._probeTimer);
    await this._cleanup();
    this.setStatus({ running: false, state: 'idle', sockets: 0, message: '已停止' });
  }
}
