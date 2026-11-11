/**
 * 弹幕层渲染
 * 通过 WebSocket 接收后端广播的事件，渲染成 OBS 可用的 H5 弹幕。
 * 所有视觉参数来自 config.overlay，热更新无需刷新页面。
 */

const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const statusLabel = statusEl.querySelector('.label');
const customCssEl = document.getElementById('custom-css');

/** 页面版本；服务端比对后能发现「OBS 里开着的还是旧页面」这种坑 */
const OVERLAY_BUILD = '2026-11-11';

/** 控制台右栏的预览 iframe 也加载本页，但它不算「真正的弹幕层」：不播音、单独计数 */
const IS_PREVIEW = new URLSearchParams(location.search).has('preview');

// 写内联样式（不是 :root）：内联优先级最高，保证用户在控制台里改的值不会被主题 CSS 覆盖
const bodyStyle = document.body.style;

let cfg = null;
let ws = null;
let retry = 0;
let timer = null;

const seen = new Set();

/* ------------------------------ 图标 ------------------------------ */

const ICON = {
  enter:
    '<svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
  follow:
    '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  like:
    '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18"/><path d="M12 8v13"/><path d="M12 8S9.5 3 7 3a2.5 2.5 0 0 0 0 5h5zM12 8s2.5-5 5-5a2.5 2.5 0 0 1 0 5h-5z"/></svg>',
  system:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};

/* ------------------------------ 配置 ------------------------------ */

function applyConfig(o) {
  if (!o) return;
  cfg = o;

  bodyStyle.setProperty('--font-family', o.fontFamily);
  bodyStyle.setProperty('--font-size', `${o.fontSize}px`);
  bodyStyle.setProperty('--font-weight', String(o.fontWeight));
  bodyStyle.setProperty('--line-height', String(o.lineHeight));
  bodyStyle.setProperty('--color', o.color);
  bodyStyle.setProperty('--nick-color', o.nicknameColor);
  bodyStyle.setProperty('--gap', `${o.gap}px`);
  bodyStyle.setProperty('--max-width', `${o.maxWidthPct}vw`);
  bodyStyle.setProperty('--pad-top', `${o.paddingTop}px`);
  bodyStyle.setProperty('--pad-bottom', `${o.paddingBottom}px`);
  bodyStyle.setProperty('--pad-side', `${o.paddingSide}px`);

  bodyStyle.setProperty('--radius', `${o.card.radius}px`);
  bodyStyle.setProperty('--card-bg', o.card.bg);
  bodyStyle.setProperty('--card-border', o.card.border);
  bodyStyle.setProperty('--card-blur', `${o.card.blur}px`);
  bodyStyle.setProperty('--card-px', `${o.card.paddingX}px`);
  bodyStyle.setProperty('--card-py', `${o.card.paddingY}px`);

  bodyStyle.setProperty('--avatar-size', `${o.avatar.size}px`);
  bodyStyle.setProperty('--in-dur', `${o.animation.inDuration}ms`);
  bodyStyle.setProperty('--out-dur', `${o.animation.outDuration}ms`);

  bodyStyle.setProperty('--stroke-width', o.textStroke ? `${o.textStrokeWidth}px` : '0px');
  bodyStyle.setProperty('--stroke-color', o.textStrokeColor);

  const lines = Math.max(0, Number(o.maxLines) || 0);
  bodyStyle.setProperty('--lines', String(lines || 1));

  bodyStyle.setProperty('--hl-color', o.highlight.color);
  bodyStyle.setProperty('--hl-bg', o.highlight.bg);

  const body = document.body;
  body.dataset.theme = o.theme;
  body.dataset.align = o.align;
  body.dataset.anim = o.animation.in;
  body.dataset.newest = o.newestAt;
  body.dataset.card = o.card.enabled ? 'on' : 'off';
  body.dataset.avatar = o.avatar.show ? 'on' : 'off';
  body.dataset.stroke = o.textStroke ? 'on' : 'off';
  body.dataset.shadow = o.shadow ? 'on' : 'off';
  body.dataset.nickcolor = o.nicknameColorize ? 'on' : 'off';
  body.dataset.wrap = o.wrap ? 'on' : 'off';
  body.dataset.lines = String(lines);

  customCssEl.textContent = o.customCss || '';
  statusEl.hidden = !o.showStatus;

  // 最多条数被调小时，立刻收掉多出来的行
  trim();
}

/* ------------------------------ 小工具 ------------------------------ */

/** 昵称取色：同一个昵称永远同一个颜色 */
function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return `hsl(${h} 72% 74%)`;
}

/** 把命中关键词的片段包成 <mark class="hl"> */
function highlightInto(el, text, keywords) {
  if (!keywords || !keywords.length) {
    el.textContent = text;
    return;
  }
  const words = [...keywords].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!words.length) {
    el.textContent = text;
    return;
  }
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(pattern, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.textContent = m[0];
    el.append(mark);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < text.length) el.append(document.createTextNode(text.slice(last)));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(kind) {
  const span = el('span', 'icon');
  span.innerHTML = ICON[kind] || ICON.system;
  return span;
}

function makeNick(ev) {
  const name = ev.user?.name || '观众';
  const nick = el('span', 'nick', name);
  if (cfg.nicknameColorize) nick.style.color = nameColor(name);
  return nick;
}

function makeBody(text) {
  const body = el('span', 'body');
  highlightInto(body, text, cfg.highlight.keywords);
  return body;
}

function makeAvatar(ev) {
  const name = ev.user?.name || '观众';
  const wrap = el('div', 'avatar-wrap');
  const src = ev.user?.avatar;
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.onerror = () => {
      wrap.textContent = name.slice(0, 1);
    };
    img.src = src;
    wrap.append(img);
  } else {
    wrap.textContent = name.slice(0, 1);
  }
  return wrap;
}

/* ------------------------------ 渲染 ------------------------------ */

function buildRow(ev) {
  const kind = ev.kind || 'comment';
  const row = el('div', `row row--${kind}${kind === 'comment' ? '' : ' row--event'}`);
  row.dataset.kind = kind;
  row.dataset.id = ev.id;
  row.dataset.ts = String(ev.ts || Date.now());

  row.append(makeAvatar(ev));

  const card = el('div', 'card');

  if (kind === 'comment') {
    card.append(makeNick(ev), makeBody(ev.text || ''));
  } else if (kind === 'system') {
    card.append(icon('system'), makeBody(ev.text || ''));
  } else {
    card.append(icon(kind), makeNick(ev));
    card.append(el('span', 'verb', cfg.text?.[kind] || ''));
    if (kind === 'gift' && ev.gift?.name) {
      card.append(el('span', 'gift-name', ev.gift.name));
    }
    const count = Number(ev.count) || 0;
    if (count > 1) card.append(el('span', 'num', `×${count}`));
  }

  row.append(card);
  return row;
}

function rows() {
  return [...listEl.children];
}

function removeRow(row, animate = true) {
  if (row.dataset.removing) return;
  row.dataset.removing = '1';
  const finish = () => row.remove();
  if (!animate) {
    finish();
    return;
  }
  // 先固定当前高度，再收到 0，列表不会跳
  row.style.height = `${row.offsetHeight}px`;
  row.style.overflow = 'hidden';
  row.classList.add('is-out');
  requestAnimationFrame(() => {
    row.style.height = '0px';
    row.style.marginTop = '0px';
  });
  setTimeout(finish, (cfg?.animation?.outDuration || 320) + 60);
}

function trim() {
  if (!cfg) return;
  const all = rows();
  const keep = Math.max(1, Number(cfg.maxItems) || 10);
  if (all.length <= keep) return;
  const overflow = all.length - keep;
  for (let i = 0; i < overflow; i += 1) {
    const target = cfg.newestAt === 'top' ? all[all.length - 1 - i] : all[i];
    if (target) removeRow(target);
  }
}

function addEvent(ev) {
  if (!cfg) return;
  if (ev.kind === 'comment' && cfg.show?.comment === false) return;
  if (ev.kind !== 'comment' && cfg.show?.[ev.kind] === false) return;
  if (ev.id && seen.has(ev.id)) return;
  if (ev.id) {
    seen.add(ev.id);
    if (seen.size > 400) {
      for (const id of [...seen].slice(0, 200)) seen.delete(id);
    }
  }

  const row = buildRow(ev);
  if (!row.dataset.ts) row.dataset.ts = String(Date.now());
  if (cfg.newestAt === 'top') listEl.prepend(row);
  else listEl.append(row);

  trim();
}

/** 按停留时长清理过期行 */
function sweep() {
  if (!cfg) return;
  const ttl = Number(cfg.ttlMs) || 0;
  if (ttl <= 0) return;
  const now = Date.now();
  for (const row of rows()) {
    if (row.dataset.removing) continue;
    if (now - Number(row.dataset.ts) > ttl) removeRow(row);
  }
}

/* ------------------------------ 连接状态 ------------------------------ */

function setStatus(state, text) {
  if (!statusEl) return;
  statusEl.dataset.state = state;
  if (statusLabel && text) statusLabel.textContent = text;
}

/* ------------------------------ WebSocket ------------------------------ */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

// ---------------------------------------------------------------------------
// 语音播报
// 服务端合成好 mp3 后用 WS 推一条 { id, url }，这里按顺序播。
// 声音由这个页面发出，OBS 里记得勾上「通过 OBS 控制音频」。
// ---------------------------------------------------------------------------
const speechQueue = [];
let speechPlaying = false;

function send(msg) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  } catch {
    /* 忽略 */
  }
}

/**
 * 页面是旧版本时自动刷新一次（30 秒内只刷一次，避免来回刷）。
 * 刷新后拿到的新脚本版本号与服务端一致，就不会再触发。
 */
function autoReloadOnce() {
  try {
    const last = Number(sessionStorage.getItem('xhs-overlay-reload') || 0);
    if (Date.now() - last < 30000) return false;
    sessionStorage.setItem('xhs-overlay-reload', String(Date.now()));
  } catch {
    /* 隐私模式拿不到 sessionStorage，就只刷这一次 */
  }
  console.warn('[overlay] 页面版本过旧，自动刷新一次');
  setTimeout(() => location.reload(), 200);
  return true;
}

function enqueueSpeech(item) {
  if (!item || !item.url) return;
  if (speechQueue.length > 6) speechQueue.shift();
  speechQueue.push(item);
  playNextSpeech();
}

function playNextSpeech() {
  if (speechPlaying) return;
  const item = speechQueue.shift();
  if (!item) return;
  speechPlaying = true;
  const started = Date.now();

  // 挂到 DOM 上再播：有些 OBS/CEF 版本对「游离的 Audio 对象」处理不稳定
  const audio = new Audio(item.url);
  audio.preload = 'auto';
  audio.style.display = 'none';
  document.body.appendChild(audio);

  let settled = false;
  const done = (ok, reason) => {
    if (settled) return;
    settled = true;
    speechPlaying = false;
    try {
      audio.pause();
      audio.remove();
    } catch {
      /* 忽略 */
    }
    send({ type: 'speech-ack', data: { id: item.id, ok, reason: reason || '', ms: Date.now() - started } });
    playNextSpeech();
  };

  audio.onended = () => done(true);
  audio.onerror = () => done(false, '音频加载失败（服务重启后旧音频会过期）');
  // 兜底：万一既没 ended 也没 error（CEF 偶发），别把队列卡死
  setTimeout(() => done(false, '播放超时'), 30000);

  const attempt = (tries) => {
    const p = audio.play();
    if (!p || typeof p.then !== 'function') return;
    p.then(() => {
      /* 真正开始播了，等 onended */
    }).catch((err) => {
      const name = (err && err.name) || 'Error';
      if (name === 'NotAllowedError' && tries > 0) {
        // 自动播放被拦：等一小会儿再试一次（OBS 里通常不需要）
        setTimeout(() => attempt(tries - 1), 400);
        return;
      }
      if (name === 'NotAllowedError') {
        done(false, '浏览器拦截了自动播放（OBS 里一般不会，普通浏览器要先点一下页面）');
        return;
      }
      if (name === 'NotSupportedError') {
        done(false, '音频格式不支持');
        return;
      }
      done(false, `播放失败：${name}`);
    });
  };
  attempt(1);
}

function connect() {
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleRetry();
    return;
  }

  ws.onopen = () => {
    retry = 0;
    setStatus('ok', '已连接');
    send({ type: 'hello', kind: IS_PREVIEW ? 'preview' : 'overlay', build: OVERLAY_BUILD });
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      // 服务端版本比本页面新 → 说明 OBS 里跑的还是很早之前加载的旧页面，自动刷一次
      if (msg.build && msg.build !== OVERLAY_BUILD && autoReloadOnce()) return;
      applyConfig(msg.overlay);
      const now = Date.now();
      for (const ev of msg.recent || []) addEvent({ ...ev, ts: now });
      return;
    }
    if (msg.type === 'event') {
      addEvent(msg.data);
      return;
    }
    if (msg.type === 'config') {
      applyConfig(msg.data);
      return;
    }
    if (msg.type === 'speak') {
      // 预览 iframe 不播音：否则控制台和 OBS 会各播一遍，回执也会算重
      if (!IS_PREVIEW) enqueueSpeech(msg.data);
    }
  };

  ws.onclose = () => {
    setStatus('err', '重连中…');
    scheduleRetry();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
  };
}

function scheduleRetry() {
  clearTimeout(timer);
  retry = Math.min(retry + 1, 5);
  const wait = Math.min(500 * 2 ** retry, 8000);
  timer = setTimeout(connect, wait);
}

/* ------------------------------ 启动 ------------------------------ */

setStatus('err', '连接中…');
connect();
setInterval(sweep, 500);
