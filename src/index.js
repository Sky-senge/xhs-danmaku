import { spawn } from 'node:child_process';
import { loadConfig, saveConfig } from './config.js';
import { bus } from './bus.js';
import { SourceManager } from './sources/index.js';
import { startServer } from './server.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const cfg = loadConfig();

// 命令行参数只影响本次运行，不写回 config.json（避免排查问题时污染配置）
if (flag('mock')) cfg.source.mode = 'mock';
if (flag('headless')) cfg.source.headless = true;

const port = Number(value('port') || process.env.PORT || cfg.server.port);
if (port && port !== cfg.server.port) cfg.server.port = port;

bus.setFilters(() => ({ ...cfg.overlay.filter, show: cfg.overlay.show }));

const manager = new SourceManager(bus);

const { server } = startServer(manager);

/** 启动后自动打开控制台，省得自己找端口 */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn(`start "" "${url}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开也不要紧，命令行里已经打印了地址 */
  }
}

if (!flag('no-open')) {
  const host = cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
  server.once('listening', () => setTimeout(() => openBrowser(`http://${host}:${cfg.server.port}/admin`), 300));
}

if (flag('auto-start') || cfg.source.autoStart || flag('mock')) {
  manager.start(loadConfig()).catch((err) => console.error('[source]', err.message));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在退出…`);
  try {
    await manager.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

// 这是个常驻的本地服务（OBS 还在连着），宁可把异常打出来也不要让进程直接退出
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
  bus.logRaw({ dir: 'error', note: String(err?.message || err) });
});
