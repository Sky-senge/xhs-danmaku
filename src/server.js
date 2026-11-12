import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { WEB_DIR, loadConfig, saveConfig, resetConfig } from './config.js';
import { bus, makeEvent } from './bus.js';
import { avatarFor } from './avatar.js';
import { tts, VOICES, cleanText } from './tts.js';

/** 与 web/overlay/overlay.js 里的 OVERLAY_BUILD 保持一致；不一致说明 OBS 里的页面是旧的 */
const OVERLAY_BUILD = '2026-11-11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const ROUTES = {
  '/': 'admin/index.html',
  '/admin': 'admin/index.html',
  '/admin/': 'admin/index.html',
  '/overlay': 'overlay/index.html',
  '/overlay/': 'overlay/index.html',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = ROUTES[pathname] || pathname.replace(/^\/+/, '');
  const filePath = path.resolve(WEB_DIR, rel.replace(/\.\./g, ''));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

export function startServer(manager) {
  const cfg = loadConfig();

  const server = http.createServer(async (req, res) => {
    try {
      let url;
      let pathname;
      try {
        url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        pathname = decodeURIComponent(url.pathname);
      } catch {
        // 畸形 URL（比如 GET /%）：直接 400，别让异常把请求挂死
        return sendJson(res, 400, { ok: false, error: 'Bad Request' });
      }
      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname, url, manager);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      }
      serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (msg) => {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(text);
    }
  };

  wss.on('connection', (ws) => {
    const current = loadConfig();
    ws.client = { kind: 'unknown', build: '' };
    ws.send(
      JSON.stringify({
        type: 'hello',
        build: OVERLAY_BUILD,
        overlay: current.overlay,
        source: manager.getStatus(),
        recent: bus.recent.slice(-20),
        tts: tts.status(),
      }),
    );
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        // 弹幕层页面自报身份：用来判断 OBS 里那页是不是旧版本
        ws.client = {
          kind: String(msg.kind || 'unknown').slice(0, 16),
          build: String(msg.build || '').slice(0, 24),
        };
        if (ws.client.kind === 'overlay' && ws.client.build !== OVERLAY_BUILD) {
          bus.logRaw({
            dir: 'tts',
            text: `弹幕层页面版本 ${ws.client.build || '未知'}，当前 ${OVERLAY_BUILD}（在 OBS 里右键该源 →「刷新页面」）`,
          });
        }
        return;
      }
      if (msg.type === 'speech-ack') {
        tts.noteAck(msg.data);
      }
    });
    ws.on('error', () => {});
  });

  bus.on('event', (event) => broadcast({ type: 'event', data: event }));
  bus.on('raw', (entry) => broadcast({ type: 'raw', data: entry }));
  manager.onStatus((status) => broadcast({ type: 'source', data: status }));

  tts.configure(cfg.tts);
  bus.on('event', (event) => tts.feed(event));
  tts.on('speak', (item) => broadcast({ type: 'speak', data: item }));
  tts.on('error', ({ message }) => {
    bus.logRaw({ dir: 'tts-error', text: message });
  });

  // 过滤器每次都从当前配置读，这样「恢复默认」也能立刻生效（以前用闭包捕获，复位后会失效）
  bus.setFilters(() => {
    const c = loadConfig();
    return { ...c.overlay.filter, show: c.overlay.show };
  });

  /** 只接受已知分区的对象，挡住 {"tts":"x"} 这类会把配置写坏的请求 */
  const SECTIONS = ['server', 'source', 'overlay', 'tts'];
  function sanitizePatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const key of SECTIONS) {
      const v = raw[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) out[key] = v;
    }
    return out;
  }

  function applyLive(next) {
    tts.configure(next.tts);
  }

  async function handleApi(req, res, pathname, url, mgr) {
    const method = req.method;

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, pid: process.pid, uptime: process.uptime() });
    }

    if (pathname === '/api/config' && method === 'GET') {
      return sendJson(res, 200, { ok: true, config: loadConfig() });
    }

    if (pathname === '/api/config' && (method === 'PUT' || method === 'POST')) {
      const patch = await readBody(req);
      const next = saveConfig(sanitizePatch(patch));
      applyLive(next);
      broadcast({ type: 'config', data: next.overlay });
      return sendJson(res, 200, { ok: true, config: next });
    }

    if (pathname === '/api/config/reset' && method === 'POST') {
      const next = resetConfig();
      applyLive(next);
      broadcast({ type: 'config', data: next.overlay });
      return sendJson(res, 200, { ok: true, config: next });
    }

    if (pathname === '/api/status') {
      const live = [...wss.clients].filter((c) => c.readyState === 1);
      const overlaySockets = live.filter((c) => c.client && c.client.kind === 'overlay');
      // 连上了却从没自报身份：多半是加语音之前就打开的旧页面（那段代码里没有 hello）
      const unknownClients = live.filter((c) => !c.client || c.client.kind === 'unknown').length;
      const overlayBuild = overlaySockets[0]?.client.build || '';
      return sendJson(res, 200, {
        ok: true,
        source: mgr.getStatus(),
        stats: bus.stats,
        tts: {
          ...tts.status(),
          overlayClients: overlaySockets.length,
          unknownClients,
          overlayBuild,
          overlayStale: Boolean(overlayBuild) && overlayBuild !== OVERLAY_BUILD,
        },
        clients: wss.clients.size,
        config: { port: loadConfig().server.port },
      });
    }

    if (pathname === '/api/tts/voices' && method === 'GET') {
      return sendJson(res, 200, { ok: true, voices: VOICES });
    }

    if (pathname === '/api/tts/preview' && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim() || '欢迎来到直播间，喜欢的话点个关注哦';
      const item = tts.preview(text, String(body.name || '').trim());
      return sendJson(res, 200, {
        ok: Boolean(item),
        item,
        cleaned: cleanText(text, loadConfig().tts.maxChars),
        error: item ? undefined : '这段文字没有可朗读的内容（可能全是表情或链接）',
      });
    }

    if (pathname.startsWith('/api/tts/audio/') && method === 'GET') {
      const id = pathname.slice('/api/tts/audio/'.length).replace(/\.mp3$/, '');
      const buf = tts.audio(id);
      if (!buf) return sendJson(res, 404, { ok: false, error: '音频不存在或已过期' });
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      return res.end(buf);
    }

    if (pathname === '/api/start' && method === 'POST') {
      const status = await mgr.start(loadConfig());
      return sendJson(res, 200, { ok: true, source: status });
    }

    if (pathname === '/api/stop' && method === 'POST') {
      const status = await mgr.stop();
      return sendJson(res, 200, { ok: true, source: status });
    }

    if (pathname === '/api/restart' && method === 'POST') {
      const status = await mgr.restart(loadConfig());
      return sendJson(res, 200, { ok: true, source: status });
    }

    if (pathname === '/api/login' && method === 'POST') {
      await mgr.openLogin();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/reload' && method === 'POST') {
      await mgr.reload();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/focus' && method === 'POST') {
      await mgr.focus();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/test' && method === 'POST') {
      const body = await readBody(req);
      const kind = body.kind || 'comment';
      const name = body.name || '测试观众';
      const event = makeEvent({
        kind,
        user: {
          id: `test-${Date.now()}`,
          name,
          avatar: body.avatar || avatarFor(name),
        },
        text: body.text ?? '这是一条测试弹幕 🎉',
        gift: kind === 'gift' ? { name: '小红花', count: 3 } : undefined,
        count: kind === 'like' ? 5 : undefined,
      });
      const ok = bus.push(event);
      return sendJson(res, 200, { ok, event });
    }

    if (pathname === '/api/raw' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      return sendJson(res, 200, { ok: true, items: bus.rawLog.slice(-limit) });
    }

    if (pathname === '/api/raw/clear' && method === 'POST') {
      bus.rawLog = [];
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'Not Found' });
  }

  const { host, port } = cfg.server;
  server.listen(port, host, () => {
    const base = `http://${host}:${port}`;
    console.log('');
    console.log('  ┌─────────────────────────────────────────────┐');
    console.log('  │  小红书弹幕 · OBS 浏览器源                   │');
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
    console.log(`  控制台    ${base}/admin`);
    console.log(`  弹幕层    ${base}/overlay     ← 填到 OBS 浏览器源`);
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${cfg.server.port} 被占用。改 data/config.json 里的 server.port，或用 --port 指定。`);
    } else {
      console.error('[server]', err);
    }
    process.exit(1);
  });

  return { server, wss, broadcast };
}
