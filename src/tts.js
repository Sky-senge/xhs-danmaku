import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { DATA_DIR } from './config.js';

/**
 * 弹幕语音播报
 *
 * 合成走 Edge 的「大声朗读」接口（免费、音色好、要联网），
 * 播放默认交给 OBS 浏览器源（弹幕层页面里用 <audio> 播），
 * 也可以切到本机播放（ffplay → 默认输出设备，供 OBS「应用音频采集」抓取）。
 *
 * 队列是故意做「丢」而不是做「排队到底」的：直播高峰一秒好几条，
 * 一首 TTS 要三四秒，如果全部排队，播出来的会是几分钟前的弹幕。
 */

export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 女 · 温柔（推荐）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 女 · 甜一点' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 男 · 活泼' },
  { id: 'zh-CN-YunjianNeural', name: '云健 · 男 · 浑厚' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 · 男 · 少年' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 · 男 · 播音腔' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 女 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 女 · 陕西话' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼 · 女 · 粤语' },
];

const DEFAULTS = {
  enabled: false,
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  volume: '+0%',
  readNickname: false,
  maxChars: 60,
  minIntervalMs: 800,
  maxQueue: 5,
  play: 'browser',
  skipNotice: true,
};

const AUDIO_TTL_MS = 120 * 1000;
const CACHE_LIMIT = 40;
/** 24kHz / 48kbit 单声道 mp3 ≈ 6000 字节/秒 */
const BYTES_PER_SECOND = 6000;

const URL_RE = /(https?:\/\/|www\.)\S+/gi;
const AT_RE = /@[^\s,，。！!？?]{1,20}/g;
/** 覆盖常见表情与符号，合成器读不出来会念成「笑脸」之类的噪声 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

export function cleanText(text, maxChars = 60) {
  let s = String(text || '');
  s = s.replace(URL_RE, ' ');
  s = s.replace(AT_RE, ' ');
  s = s.replace(EMOJI_RE, '');
  // 「666」「6666」这类刷屏，念成数字会变成「六百六十六」
  s = s.replace(/6{3,}/g, '六六六');
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 纯符号/纯表情的弹幕没必要念
  if (!/[\p{Script=Han}\p{L}\p{N}]/u.test(s)) return '';
  if (maxChars > 0 && s.length > maxChars) s = `${s.slice(0, maxChars)}…`;
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Tts extends EventEmitter {
  constructor() {
    super();
    this.cfg = { ...DEFAULTS };
    /** @type {{id:string,text:string,event:object}[]} */
    this.queue = [];
    this.cache = new Map();
    this.running = false;
    this.engine = null;
    this.engineKey = '';
    this.chain = Promise.resolve();
    this.stats = { spoken: 0, skipped: 0, failed: 0, lastError: '', lastAt: 0 };
  }

  configure(next) {
    const wasEnabled = this.cfg.enabled;
    this.cfg = { ...DEFAULTS, ...(next || {}) };
    if (this._key() !== this.engineKey) {
      try {
        this.engine?.close();
      } catch {
        /* 忽略 */
      }
      this.engine = null;
    }
    if (wasEnabled && !this.cfg.enabled) this.queue = [];
  }

  _key() {
    return `${this.cfg.voice}|${this.cfg.rate}|${this.cfg.volume}`;
  }

  get enabled() {
    return Boolean(this.cfg.enabled);
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      voice: this.cfg.voice,
      play: this.cfg.play,
      queue: this.queue.length,
      ...this.stats,
    };
  }

  /** 收到一条弹幕事件 */
  feed(event) {
    if (!this.cfg.enabled) return;
    if (!event || event.kind !== 'comment') return;
    const body = cleanText(event.text, this.cfg.maxChars);
    if (!body) return;

    if (this.queue.length >= Math.max(1, Number(this.cfg.maxQueue) || 5)) {
      this.stats.skipped += 1;
      this.emit('skip', { event, queue: this.queue.length });
      return;
    }

    const name = this.cfg.readNickname ? String(event.user?.name || '').trim() : '';
    const text = name ? `${name}说，${body}` : body;
    this.queue.push({ id: crypto.randomUUID().slice(0, 8), text, event });
    this._kick();
  }

  /** 立即播一条（控制台「试听」用） */
  preview(text, name = '') {
    const body = cleanText(text, this.cfg.maxChars);
    if (!body) return null;
    const item = {
      id: crypto.randomUUID().slice(0, 8),
      text: name ? `${name}说，${body}` : body,
      event: null,
    };
    this.queue.push(item);
    this._kick();
    return item;
  }

  audio(id) {
    const hit = this.cache.get(id);
    return hit ? hit.buf : null;
  }

  _kick() {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => this._drain());
  }

  async _drain() {
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        const started = Date.now();
        let buf = null;
        try {
          buf = await this._synth(item.text);
        } catch (err) {
          this.stats.failed += 1;
          this.stats.lastError = String(err?.message || err);
          this.emit('error', { message: this.stats.lastError });
          continue;
        }
        this._remember(item.id, buf);
        this.stats.spoken += 1;
        this.stats.lastAt = Date.now();

        this.emit('speak', {
          id: item.id,
          url: `/api/tts/audio/${item.id}`,
          text: item.text,
          name: item.event?.user?.name || '',
          bytes: buf.length,
        });

        // 本机播放：等 ffplay 播完再继续，天然不会叠音
        if (this.cfg.play === 'local') {
          try {
            await playLocal(item.id, buf);
          } catch (err) {
            this.stats.failed += 1;
            this.stats.lastError = String(err?.message || err);
          }
          continue;
        }

        // 浏览器播放：没有前端回报播放结束，用码率估时长来卡节奏
        const durationMs = Math.max(600, (buf.length / BYTES_PER_SECOND) * 1000);
        const waitMs = Math.max(durationMs, Number(this.cfg.minIntervalMs) || 0);
        const spent = Date.now() - started;
        if (waitMs > spent) await sleep(waitMs - spent);
      }
    } finally {
      this.running = false;
      if (this.queue.length) this._kick();
    }
  }

  _remember(id, buf) {
    this.cache.set(id, { buf, at: Date.now() });
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.at > AUDIO_TTL_MS) this.cache.delete(k);
    }
    while (this.cache.size > CACHE_LIMIT) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
  }

  async _synth(text) {
    const key = `${this.cfg.voice}|${this.cfg.rate}|${this.cfg.volume}`;
    if (!this.engine || this.engineKey !== key) {
      if (this.engine) {
        try {
          this.engine.close();
        } catch {
          /* 忽略 */
        }
      }
      const engine = new MsEdgeTTS({ connectionTimeoutMs: 10000, synthesisTimeoutMs: 15000 });
      await engine.setMetadata(this.cfg.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      engine.voiceName = this.cfg.voice;
      this.engine = engine;
      this.engineKey = key;
    }

    const opts = { rate: this.cfg.rate || '+0%', volume: this.cfg.volume || '+0%' };
    const buf = await new Promise((resolve, reject) => {
      const { audioStream } = this.engine.toStream(text, opts);
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('合成超时')), 20000);
      audioStream.on('data', (d) => chunks.push(d));
      audioStream.on('close', () => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks);
        if (!out.length) reject(new Error('合成结果为空'));
        else resolve(out);
      });
      audioStream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return buf;
  }

  close() {
    try {
      this.engine?.close();
    } catch {
      /* 忽略 */
    }
    this.engine = null;
  }
}

export const tts = new Tts();

/** 本机播放：把 mp3 落到 data/tts 再用 ffplay 播（OBS 可用「应用音频采集」抓 ffplay.exe） */
export async function playLocal(id, buf) {
  const dir = path.join(DATA_DIR, 'tts');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.mp3`);
  await fs.promises.writeFile(file, buf);
  await new Promise((resolve) => {
    const p = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const done = () => resolve();
    p.on('error', done);
    p.on('exit', done);
  });
  fs.promises.unlink(file).catch(() => {});
}
