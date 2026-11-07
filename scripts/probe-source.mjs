import { loadConfig } from '../src/config.js';
import { bus } from '../src/bus.js';
import { SourceManager } from '../src/sources/index.js';

// 走真实的 SourceManager 路径，验证 config 形状、状态机、导航是否正常
const cfg = loadConfig();
cfg.source.mode = process.argv.includes('--mock') ? 'mock' : 'xhs';
cfg.source.headless = false;

bus.setFilters(() => ({ ...cfg.overlay.filter, show: cfg.overlay.show }));

const manager = new SourceManager(bus);
manager.onStatus((s) => {
  console.log(
    `[status] ${s.mode}/${s.state} :: ${s.message} :: url=${s.pageUrl} sockets=${s.sockets} frames=${s.frames} events=${s.events}`,
  );
});
bus.on('event', (e) => console.log('[event]', e.kind, e.user?.name, e.text || '', e.count ?? ''));

const seconds = Number(process.argv[2] || 20);

try {
  await manager.start(cfg);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const s = manager.getStatus();
  console.log('FINAL', JSON.stringify({ ...s, unknownTypes: s.unknownTypes }, null, 1));
} catch (err) {
  console.log('START FAILED:', err.message);
} finally {
  await manager.stop();
  process.exit(0);
}
