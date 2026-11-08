import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 默认配置：所有可调项集中在这里，前端只管渲染 */
export const DEFAULTS = {
  server: {
    port: 8787,
    host: '127.0.0.1',
  },
  source: {
    /** xhs = 抓真实直播间；mock = 本地假数据，用于离线调试 */
    mode: 'app',
    /** auto 会在 chrome / msedge 之间自动挑一个，不用下载浏览器 */
    headless: false,
    /** 主播中控台；登录后小红书自己会跳转到这里。默认蒲公英（达人后台），商家账号请在控制台切成方舟 */
    consoleUrl: 'https://pgy.xiaohongshu.com/commerce/redlive/live_center_control',
    /** 登录页，未登录时我们主动导航过去 */
    loginUrl:
      'https://customer.xiaohongshu.com/login?service=https%3A%2F%2Fark.xiaohongshu.com%2Flive_center_control',
    /** 除了 WS，也尝试从 HTTP 响应里捞消息（部分事件只走接口） */
    captureHttp: false,
    /** 直播助手（桌面 App）的 exe 路径，留空自动探测 */
    appPath: '',
    /** 调试助手时用的本地 CDP 端口 */
    debugPort: 9222,
    autoStart: false,
    /** 关掉浏览器窗口后是否自动重连 */
    autoReconnect: true,
  },
  overlay: {
    // ---- 布局 ----
    theme: 'bubble', // bubble | minimal | capsule | neon | glass
    newestAt: 'bottom', // bottom | top
    align: 'left', // left | center | right
    maxItems: 8,
    ttlMs: 18000,
    gap: 8,
    // 默认按 OBS 浏览器源 800×1000 调过；换成 1920×1080 时把这几个值调大
    maxWidthPct: 100,
    paddingTop: 24,
    paddingBottom: 24,
    paddingSide: 20,
    // ---- 字体 ----
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif',
    fontSize: 22,
    fontWeight: 600,
    lineHeight: 1.45,
    color: '#ffffff',
    nicknameColor: '#ffd166',
    nicknameColorize: true,
    textStroke: true,
    textStrokeColor: 'rgba(0,0,0,0.85)',
    textStrokeWidth: 1.5,
    shadow: true,
    // ---- 长文本 ----
    wrap: true,
    maxLines: 3,
    // ---- 卡片 ----
    card: {
      enabled: true,
      bg: 'rgba(18,18,20,0.55)',
      radius: 10,
      paddingX: 11,
      paddingY: 6,
      blur: 8,
      border: '1px solid rgba(255,255,255,0.10)',
    },
    avatar: { show: true, size: 26 },
    // ---- 消息开关 ----
    show: { comment: true, enter: true, follow: true, like: true, gift: false },
    // ---- 文案 ----
    text: {
      enter: '来了',
      follow: '关注了主播',
      like: '点了赞',
      gift: '送出',
    },
    // ---- 高亮 ----
    highlight: {
      keywords: [],
      color: '#ffffff',
      bg: 'rgba(255,77,109,0.85)',
      bold: true,
    },
    // ---- 动效 ----
    animation: {
      in: 'slide', // slide | fade | pop | none
      inDuration: 240,
      outDuration: 320,
    },
    // ---- 过滤 ----
    filter: {
      blockKeywords: [],
      blockUsers: [],
      minLength: 0,
      maxLength: 300,
      /** 同一用户在此毫秒内只显示一条，防刷屏 */
      userCooldownMs: 0,
      /** 全局每秒最多显示条数，0 = 不限 */
      ratePerSecond: 0,
    },
    customCss: '',
    /** 右下角显示连接状态，正式推流前建议关掉 */
    showStatus: false,
  },
  /** 语音播报（Edge 神经音色，声音由弹幕层页面播放 → OBS 浏览器源「通过 OBS 控制音频」） */
  tts: {
    enabled: false,
    voice: 'zh-CN-XiaoxiaoNeural',
    /** 语速 / 音量，SSML 相对值 */
    rate: '+0%',
    volume: '+0%',
    /** 播报时是否先念昵称（「小明说，…」） */
    readNickname: false,
    /** 单条最多念多少字，超出截断 */
    maxChars: 60,
    /** 两条之间的最小间隔，防止叠音 */
    minIntervalMs: 800,
    /** 排队上限，超过就丢掉后来的（宁可少念，不能播上一分钟的） */
    maxQueue: 5,
    /** browser = 弹幕层页面播（推荐）；local = 服务端用 ffplay 播 */
    play: 'browser',
  },
};

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  let stored = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[config] 读取失败，使用默认配置:', err.message);
  }
  cached = deepMerge(structuredClone(DEFAULTS), stored);
  return cached;
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  cached = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE); // 原子写，避免半截文件
  return next;
}

export function resetConfig() {
  cached = structuredClone(DEFAULTS);
  return saveConfig({});
}
