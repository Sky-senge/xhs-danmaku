import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { WEB_DIR, loadConfig, saveConfig, resetConfig } from './config.js';
import { bus, makeEvent } from './bus.js';
import { avatarFor } from './avatar.js';

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
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname, url, manager);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
      }
      serveStatic(req, res, pathname);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
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
    ws.send(
      JSON.stringify({
        type: 'hello',
        overlay: current.overlay,
        source: manager.getStatus(),
        recent: bus.recent.slice(-20),
      }),
    );
    ws.on('error', () => {});
  });

  bus.on('event', (event) => broadcast({ type: 'event', data: event }));
  bus.on('raw', (entry) => broadcast({ type: 'raw', data: entry }));
  manager.onStatus((status) => broadcast({ type: 'source', data: status }));

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
      const next = saveConfig(patch);
      bus.setFilters(() => ({ ...next.overlay.filter, show: next.overlay.show }));
      broadcast({ type: 'config', data: next.overlay });
      return sendJson(res, 200, { ok: true, config: next });
    }

    if (pathname === '/api/config/reset' && method === 'POST') {
      const next = resetConfig();
      broadcast({ type: 'config', data: next.overlay });
      return sendJson(res, 200, { ok: true, config: next });
    }

    if (pathname === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        source: mgr.getStatus(),
        stats: bus.stats,
        clients: wss.clients.size,
        config: { port: loadConfig().server.port },
      });
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
