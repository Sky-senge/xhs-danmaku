import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

/**
 * 统一事件模型
 * @typedef {Object} LiveEvent
 * @property {string} id
 * @property {'comment'|'enter'|'follow'|'like'|'gift'|'system'} kind
 * @property {number} ts
 * @property {{id:string,name:string,avatar:string,role:number}} user
 * @property {string} [text]
 * @property {{name:string,count:number}} [gift]
 * @property {number} [count]
 * @property {object} [raw]
 */

export const KIND_LABEL = {
  comment: '弹幕',
  enter: '进场',
  follow: '关注',
  like: '点赞',
  gift: '礼物',
  system: '系统',
};

export function makeEvent(patch) {
  const user = {
    id: String(patch.user?.id ?? ''),
    name: String(patch.user?.name ?? ''),
    avatar: String(patch.user?.avatar ?? ''),
    role: Number(patch.user?.role ?? 0) || 0,
  };
  return {
    id: patch.id || crypto.randomUUID(),
    kind: patch.kind || 'comment',
    ts: patch.ts || Date.now(),
    user,
    text: patch.text ?? '',
    ...(patch.gift ? { gift: patch.gift } : {}),
    ...(patch.count != null ? { count: patch.count } : {}),
    ...(patch.raw ? { raw: patch.raw } : {}),
  };
}

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    /** @type {LiveEvent[]} 环形缓冲，供 overlay 后接入时补发 */
    this.recent = [];
    this.recentLimit = 60;
    /** @type {object[]} 原始帧日志，协议变更时排错用 */
    this.rawLog = [];
    this.rawLimit = 200;
    this.stats = { total: 0, byKind: {}, startedAt: Date.now() };
    this._seen = new Set();
    this._userLast = new Map();
    this._secondBucket = { second: 0, count: 0 };
    this.filters = () => ({
      blockKeywords: [],
      blockUsers: [],
      minLength: 0,
      maxLength: 300,
      userCooldownMs: 0,
      ratePerSecond: 0,
    });
  }

  /** 注入过滤器配置（由 server 在配置变更时刷新） */
  setFilters(fn) {
    this.filters = fn;
  }

  push(event) {
    if (!event) return false;
    if (!this._passFilters(event)) return false;

    // 去重：同 id 只上一次
    if (event.id) {
      if (this._seen.has(event.id)) return false;
      this._seen.add(event.id);
      if (this._seen.size > 2000) {
        // 简单淘汰：清掉最早一半
        const arr = [...this._seen];
        this._seen = new Set(arr.slice(arr.length / 2));
      }
    }

    this.recent.push(event);
    if (this.recent.length > this.recentLimit) this.recent.shift();

    this.stats.total += 1;
    this.stats.byKind[event.kind] = (this.stats.byKind[event.kind] || 0) + 1;

    this.emit('event', event);
    return true;
  }

  _passFilters(e) {
    const f = this.filters() || {};
    const show = f.show || {};
    if (show[e.kind] === false) return false;

    if (e.kind === 'comment') {
      const text = (e.text || '').trim();
      if (text.length < (f.minLength || 0)) return false;
      if (f.maxLength && text.length > f.maxLength) return false;
      const lower = text.toLowerCase();
      for (const kw of f.blockKeywords || []) {
        if (kw && lower.includes(String(kw).toLowerCase())) return false;
      }
    }

    for (const u of f.blockUsers || []) {
      if (u && (e.user.name === u || e.user.id === String(u))) return false;
    }

    const cooldown = Number(f.userCooldownMs) || 0;
    if (cooldown > 0 && e.user.id) {
      const last = this._userLast.get(e.user.id) || 0;
      if (e.ts - last < cooldown) return false;
      this._userLast.set(e.user.id, e.ts);
    }

    const rps = Number(f.ratePerSecond) || 0;
    if (rps > 0) {
      const sec = Math.floor(e.ts / 1000);
      if (sec !== this._secondBucket.second) {
        this._secondBucket = { second: sec, count: 0 };
      }
      if (this._secondBucket.count >= rps) return false;
      this._secondBucket.count += 1;
    }
    return true;
  }

  /** 记录原始帧（截断，避免内存膨胀） */
  logRaw(entry) {
    this.rawLog.push({ ts: Date.now(), ...entry });
    if (this.rawLog.length > this.rawLimit) this.rawLog.shift();
    this.emit('raw', entry);
  }

  reset() {
    this.stats = { total: 0, byKind: {}, startedAt: Date.now() };
    this.recent = [];
    this._seen.clear();
  }
}

export const bus = new Bus();
