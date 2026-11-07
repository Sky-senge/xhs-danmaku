import { XhsSource } from './xhs.js';
import { ZhushouSource } from './zhushou.js';
import { MockSource } from './mock.js';

/**
 * 数据源管理器：统一 mock / xhs（网页中控台）/ app（直播助手）三种实现，向 server 暴露同一套接口
 */
export class SourceManager {
  constructor(bus) {
    this.bus = bus;
    this.current = null;
    this.mode = null;
    this._listeners = new Set();
    this._reconnectTimer = null;
  }

  _bind(source, mode) {
    this.mode = mode;
    this.current = source;
    this._detach?.();

    const onStatus = (s) => this._emit();
    const onError = () => this._emit();
    const onReconnect = () => {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        this.start({ ...this._lastCfg }).catch(() => {});
      }, 4000);
    };

    source.on('status', onStatus);
    source.on('error', onError);
    if (mode === 'xhs' || mode === 'app') source.on('reconnect', onReconnect);

    this._detach = () => {
      source.off('status', onStatus);
      source.off('error', onError);
      source.off('reconnect', onReconnect);
      this._detach = null;
    };
  }

  _emit() {
    for (const fn of this._listeners) fn(this.getStatus());
  }

  onStatus(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  getStatus() {
    const base = this.current?.status || {
      running: false,
      state: 'idle',
      message: '未启动',
      frames: 0,
      events: 0,
      unknownTypes: {},
    };
    return { ...base, mode: this.mode };
  }

  async start(cfg) {
    this._lastCfg = cfg;
    const raw = cfg.source.mode;
    const wantMode = raw === 'mock' ? 'mock' : raw === 'app' ? 'app' : 'xhs';

    // 切换模式或重启：先关旧的
    if (this.current) {
      await this.stop();
    }

    const source =
      wantMode === 'mock'
        ? new MockSource(this.bus)
        : wantMode === 'app'
          ? new ZhushouSource(this.bus)
          : new XhsSource(this.bus);
    this._bind(source, wantMode);
    await source.start(cfg);
    this._emit();
    return this.getStatus();
  }

  async stop() {
    clearTimeout(this._reconnectTimer);
    if (!this.current) return this.getStatus();
    const src = this.current;
    await src.stop();
    this._emit();
    return this.getStatus();
  }

  async restart(cfg) {
    await this.stop();
    return this.start(cfg);
  }

  async openLogin() {
    if (!this.current) throw new Error('请先启动');
    return this.current.openLogin();
  }

  async reload() {
    if (!this.current) throw new Error('请先启动');
    return this.current.reload();
  }

  async focus() {
    if (!this.current) throw new Error('请先启动');
    return this.current.bringToFront();
  }
}
