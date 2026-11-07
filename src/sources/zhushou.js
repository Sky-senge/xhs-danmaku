import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { isDanmakuSocket } from '../xhs/decode.js';
import { consumeFrame } from './frames.js';

const APP_DIR_NAME = 'xhs-live-helper';
const APP_EXE = 'xhs-live-helper.exe';
const LAUNCHER_EXE = 'xhs-live-helper-launcher.exe';
const DEFAULT_PORT = 9222;

/** 盘符遍历：用户可能装在 D 盘（本机就在 D:\Program Files） */
function drives() {
  const out = [];
  for (const letter of 'CDEFGH') {
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) out.push(root);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function candidateDirs(extra) {
  const dirs = [extra, process.env.XHS_HELPER_DIR].filter(Boolean);
  for (const root of drives()) {
    dirs.push(path.join(root, 'Program Files', APP_DIR_NAME));
    dirs.push(path.join(root, 'Program Files (x86)', APP_DIR_NAME));
    dirs.push(path.join(root, APP_DIR_NAME));
  }
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(path.join(local, 'Programs', APP_DIR_NAME));
  const roaming = process.env.APPDATA;
  if (roaming) dirs.push(path.join(roaming, APP_DIR_NAME));
  return dirs;
}

/** 安装目录下按版本号挑最新的一份 */
function pickVersionedExe(base) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  // 传入的可能是 xhs-live-helper 安装目录（里面是 4.11.0_xxx/）
  const versions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const exe = path.join(base, e.name, APP_EXE);
    if (fs.existsSync(exe)) versions.push({ version: e.name, exe, dir: path.join(base, e.name) });
  }
  if (versions.length) {
    versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return versions[0];
  }
  // 也可能直接传的是版本目录本身
  const direct = path.join(base, APP_EXE);
  if (fs.existsSync(direct)) return { version: path.basename(base), exe: direct, dir: base };
  return null;
}

/**
 * 找到「小红书直播助手」的可执行文件。
 * 返回 { exe, dir, version, launcher } ，找不到返回 null。
 */
export function findHelper(customPath) {
  const dirs = candidateDirs(customPath && !customPath.endsWith('.exe') ? customPath : null);
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
    } catch {
      continue;
    }
    const hit = pickVersionedExe(dir);
    if (hit) {
      const launcher = path.join(dir, LAUNCHER_EXE);
      return { ...hit, launcher: fs.existsSync(launcher) ? launcher : null };
    }
  }
  // 用户直接给了 exe
  if (customPath && customPath.endsWith('.exe')) {
    try {
      if (fs.existsSync(customPath)) {
        return { exe: customPath, dir: path.dirname(customPath), version: '', launcher: null };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function cdpAlive(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1200),
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const body = await res.json().catch(() => null);
  return Boolean(body && body.webSocketDebuggerUrl);
}

/** 列出所有可调试的页面目标（直播助手的每个窗口都是一个 page target） */
async function cdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) return null;
  return list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

function helperRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${APP_EXE}`, '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(String(stdout).toLowerCase().includes(APP_EXE));
      },
    );
  });
}

/**
 * 小红书直播助手（桌面 App）数据源
 *
 * 直播助手本身是 Electron 应用，弹幕走的是和网页中控台**同一条** RWP 长连接
 * （wss://apppush-rws.xiaohongshu.com/rwp），所以不需要另写协议：
 * 只要用 --remote-debugging-port 把它拉起来，再用 CDP 旁听它自己收到的帧，
 * 复用 decode.js 就能解出弹幕、进场、关注、点赞、礼物。
 *
 * 好处：普通用户没有蒲公英 / 方舟后台也能用，因为弹幕是开播工具自己在收。
 */
export class ZhushouSource extends EventEmitter {
  constructor(bus) {
    super();
    this.bus = bus;
    this.cfg = null;
    this.child = null;
    this._starting = false;
    this._closedByUs = false;
    this._wsSockets = new Map();
    this._pages = new Map(); // 页面 id -> { ws, url, title, ready }
    this._msgId = 0;
    this._probeTimer = null;
    this._spawnedByUs = false;
    this.status = {
      running: false,
      state: 'idle', // idle | launching | login-required | capturing | error
      message: '',
      appPath: '',
      appVersion: '',
      debugPort: DEFAULT_PORT,
      pages: 0,
      sockets: 0,
      frames: 0,
      events: 0,
      unknownTypes: {},
      lastFrameAt: 0,
      startedAt: 0,
    };
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
    const sc = cfg?.source ?? cfg ?? {};
    this.cfg = sc;
    const port = Number(sc.debugPort) || DEFAULT_PORT;
    this.setStatus({
      running: true,
      state: 'launching',
      message: '正在准备直播助手…',
      debugPort: port,
      startedAt: Date.now(),
      frames: 0,
      events: 0,
      sockets: 0,
      pages: 0,
      unknownTypes: {},
    });

    try {
      const found = findHelper(sc.appPath);
      if (!found) {
        throw new Error(
          '没找到「小红书直播助手」。请确认它已安装，或在控制台「采集 → 直播助手路径」里手动填 xhs-live-helper.exe 的完整路径。',
        );
      }
      this.setStatus({ appPath: found.exe, appVersion: found.version });

      if (await cdpAlive(port)) {
        // 用户自己就是带调试参数起的，直接连
        this.bus.logRaw({ dir: 'app-attach', port, note: '已有调试端口，直接连接' });
      } else {
        if (await helperRunning()) {
          throw new Error(
            '直播助手正在运行，但不是调试模式，插件连不上去。请先完全退出它（右键托盘图标 → 退出，确认任务管理器里没有 xhs-live-helper.exe），再点一次「启动采集」——插件会自动帮你带调试参数启动它。',
          );
        }
        this.setStatus({ message: '正在启动直播助手（带调试端口）…' });
        const spawned = await this._spawnApp(found, port);
        this.child = spawned.child;
        this._spawnedByUs = true;
        if (!spawned.shell) {
          // 直接启动时，子进程就是 App 本身，它退出才算 App 退出
          spawned.child.on('exit', () => {
            if (!this._closedByUs) this._onAppExit();
          });
        }

        const deadline = Date.now() + 45000;
        let up = false;
        while (Date.now() < deadline) {
          if (await cdpAlive(port)) {
            up = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!up) {
          throw new Error(
            '直播助手启动了，但没等到调试端口——如果刚才弹了 UAC 授权框，请点「是」再重试；' +
              '也可能是杀毒软件拦住了。你可以手动打开直播助手后用「网页中控台」模式。',
          );
        }
      }

      this.setStatus({ message: '正在连上直播助手…' });
      await this._attachTargets(port);
      if (!this._pages.size) {
        throw new Error(
          '调试端口通了，但没列出任何窗口。请把直播助手窗口打开（不要最小化到托盘）再试一次。',
        );
      }

      this.setStatus({
        state: 'launching',
        message: '已接上直播助手。请在窗口里登录，并进入直播中控台（弹幕面板要打开）。',
      });
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

  _send(ws, method, params) {
    try {
      ws.send(JSON.stringify({ id: ++this._msgId, method, params }));
    } catch {
      /* 连接没了 */
    }
  }

  /** 把当前所有页面窗口都挂上监听；新窗口（弹幕面板等）由 _startProbe 定时补上 */
  async _attachTargets(port) {
    const list = await cdpTargets(port);
    if (!list) return 0;
    for (const t of list) {
      if (this._pages.has(t.id)) continue;
      this._attachTarget(t);
    }
    this.setStatus({ pages: this._pages.size });
    return list.length;
  }

  _attachTarget(t) {
    let ws;
    try {
      ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    } catch (err) {
      this.bus.logRaw({ dir: 'app-cdp-error', note: err.message, url: t.url });
      return;
    }
    const entry = { ws, url: t.url || '', title: t.title || '', ready: false };
    this._pages.set(t.id, entry);

    ws.on('open', () => {
      entry.ready = true;
      this._send(ws, 'Network.enable');
      this.bus.logRaw({ dir: 'app-page', url: t.url, title: t.title });
    });
    ws.on('message', (raw) => this._onCdpMessage(t.id, raw));
    ws.on('error', () => {
      /* 单页报错不影响其它页 */
    });
    ws.on('close', () => {
      this._pages.delete(t.id);
      for (const [key, v] of this._wsSockets) {
        if (v.pageId === t.id) this._wsSockets.delete(key);
      }
      this.setStatus({ pages: this._pages.size, sockets: this._wsSockets.size });
    });
  }

  _onCdpMessage(pageId, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || !msg.method) return;

    if (msg.method === 'Network.webSocketCreated') {
      const url = msg.params?.url || '';
      const key = `${pageId}:${msg.params?.requestId}`;
      const relevant = isDanmakuSocket(url);
      this._wsSockets.set(key, { url, relevant, frames: 0, pageId, openedAt: Date.now() });
      this.setStatus({ sockets: this._wsSockets.size });
      if (relevant) this.bus.logRaw({ dir: 'ws-open', url, relevant, via: 'app' });
      return;
    }

    if (msg.method === 'Network.webSocketFrameReceived') {
      const key = `${pageId}:${msg.params?.requestId}`;
      const info = this._wsSockets.get(key);
      const url = info?.url || '';
      if (info) info.frames += 1;
      const payload = msg.params?.response?.payloadData;
      if (typeof payload !== 'string') return;
      consumeFrame(
        { bus: this.bus, status: this.status, setStatus: (p) => this.setStatus(p) },
        payload,
        url,
        info ? info.relevant : false,
      );
      return;
    }

    if (msg.method === 'Network.webSocketClosed') {
      this._wsSockets.delete(`${pageId}:${msg.params?.requestId}`);
      this.setStatus({ sockets: this._wsSockets.size });
    }
  }

  _countPages() {
    return this._pages.size;
  }

  _startProbe() {
    clearInterval(this._probeTimer);
    const port = this.status.debugPort || DEFAULT_PORT;
    this._probeTimer = setInterval(async () => {
      const list = await cdpTargets(port);
      if (!list) {
        // 调试端口没了 = 直播助手被关了
        this._onAppExit();
        return;
      }
      for (const t of list) if (!this._pages.has(t.id)) this._attachTarget(t);
      this.setStatus({ pages: this._pages.size, sockets: this._wsSockets.size });
      if (
        this.status.state === 'launching' &&
        this._wsSockets.size === 0 &&
        Date.now() - this.status.startedAt > 30000
      ) {
        this.setStatus({
          message:
            '还没发现弹幕通道。请确认：① 已经在直播助手里登录；② 已经进入「直播中控台」或开播页；' +
            '③ 弹幕面板是打开的。只有开播中的账号才有弹幕推送。',
        });
      }
    }, 2000);
  }

  _onAppExit() {
    clearInterval(this._probeTimer);
    this.setStatus({ running: false, state: 'idle', message: '直播助手已退出', sockets: 0, pages: 0 });
    if (!this._closedByUs && this.cfg?.autoReconnect) this.emit('reconnect');
  }

  _onDisconnected() {
    if (this._closedByUs) return;
    this.setStatus({ running: false, state: 'idle', message: '与直播助手的调试连接断开' });
    this.emit('reconnect');
  }

  /** 助手本身没有「登录页 / 中控台」概念，这两个动作统一做成把窗口调到前台 */
  /** 等 spawn 的成败（spawn 失败是异步的 'error' 事件，不处理会把整个服务带崩） */
  _waitSpawn(child, ms = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        child.off('spawn', onSpawn);
        child.off('error', onErr);
        resolve(err);
      };
      const onSpawn = () => finish(null);
      const onErr = (e) => finish(e);
      const t = setTimeout(() => finish(null), ms);
      child.once('spawn', onSpawn);
      child.once('error', onErr);
    });
  }

 /**
   * 启动直播助手。
   *
   * 坑：助手 exe 的清单里写了 requireAdministrator，普通（非管理员）进程直接 CreateProcess 会拿到
   * ERROR_ELEVATION_REQUIRED → Node 报 `EACCES`。所以先试直接启动（插件本身是管理员时能成），
   * 不行就走 ShellExecute（PowerShell 的 Start-Process），由系统静默提权 / 弹 UAC。
   *
   * 注意不能用 `cmd /c start`：cmd 会把 `--remote-debugging-port=9222` 当成要打开的文件。
   */
  async _spawnApp(found, port) {
    const arg = `--remote-debugging-port=${port}`;
    const attempts = [
      [
        '直接启动',
        false,
        () =>
          spawn(found.exe, [arg], {
            cwd: found.dir,
            detached: false,
            stdio: 'ignore',
            windowsHide: false,
          }),
      ],
      [
        '经由 PowerShell',
        true,
        () =>
          spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Start-Process -FilePath '${found.exe.replace(/'/g, "''")}' -ArgumentList '${arg}'`,
            ],
            { cwd: found.dir, detached: false, stdio: 'ignore', windowsHide: true },
          ),
      ],
    ];

    let lastErr = null;
    for (const [label, shell, make] of attempts) {
      let child;
      try {
        child = make();
      } catch (err) {
        lastErr = err;
        continue;
      }
      const err = await this._waitSpawn(child);
      if (!err) {
        child.on('error', () => {}); // 之后它再出错也不能把服务带崩
        this.bus.logRaw({ dir: 'app-spawn', label, ok: true, shell });
        return { child, shell };
      }
      lastErr = err;
      this.bus.logRaw({
        dir: 'app-spawn',
        label,
        ok: false,
        error: `${err.code || ''} ${err.message || err}`.trim(),
      });
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
    }

    const why = lastErr?.code || lastErr?.message || '未知错误';
    throw new Error(
      `插件没能启动直播助手（${why}）。可以试这两步：① 双击项目里的「启动直播助手(调试).cmd」，` +
        '它会以调试模式打开直播助手；② 再回到这里点一次「启动采集」。' +
        '（如果刚才弹了 UAC 授权框，记得点「是」。）',
    );
  }

  async openLogin() {
    await this.bringToFront();
  }

  async reload() {
    await this.bringToFront();
  }

  async bringToFront() {
    const first = [...this._pages.values()].find((p) => p.ready);
    if (!first) return;
    this._send(first.ws, 'Page.bringToFront');
  }

  async _cleanup() {
    clearInterval(this._probeTimer);
    for (const p of this._pages.values()) {
      try {
        p.ws.close();
      } catch {
        /* ignore */
      }
    }
    this._pages.clear();
    this._wsSockets.clear();
  }

  async stop() {
    this._closedByUs = true;
    await this._cleanup();
    this.setStatus({ running: false, state: 'idle', sockets: 0, pages: 0, message: '已停止' });
  }
}
