/**
 * 控制台前端
 * 配置改动 -> 去抖 PUT /api/config -> 服务端深度合并并广播 -> 弹幕层热更新
 * 状态每秒轮询一次，够用且实现简单。
 */

import { THEME_BUNDLES } from '/shared/themes.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  config: null,
  rawOn: false,
  rawTimer: null,
  statusTimer: null,
  saveTimer: null,
};

/* ------------------------------ 工具 ------------------------------ */

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------ 配置绑定 ------------------------------ */

const isBoolSelect = (el) =>
  el.tagName === 'SELECT' &&
  el.options.length > 0 &&
  [...el.options].every((o) => o.value === 'true' || o.value === 'false');

function readControl(el, path) {
  if (el.type === 'checkbox') return el.checked;
  if (isBoolSelect(el)) return el.value === 'true';
  if (el.dataset.percent) {
    const n = Number(el.value) || 0;
    return `${n >= 0 ? '+' : ''}${n}%`;
  }
  if (el.type === 'number' || el.type === 'range') return Number(el.value);
  if (el.dataset.array) {
    return el.value
      .split(/[\n,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return el.value;
}

function writeControl(el, value) {
  if (el.type === 'checkbox') {
    el.checked = Boolean(value);
  } else if (isBoolSelect(el)) {
    el.value = value ? 'true' : 'false';
  } else if (el.dataset.percent) {
    const n = parseInt(String(value ?? '0'), 10) || 0;
    if (el.value !== String(n)) el.value = String(n);
    if (el.dataset.range) {
      const out = document.getElementById(el.dataset.range);
      if (out) out.textContent = `${n >= 0 ? '+' : ''}${n}%`;
    }
    return;
  } else if (el.dataset.array) {
    el.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  } else if (el.value !== String(value ?? '')) {
    el.value = String(value ?? '');
  }
  if (el.dataset.range) {
    const out = document.getElementById(el.dataset.range);
    if (out) out.textContent = el.value;
  }
}

/** 把 state.config 灌回所有控件（不重复绑定事件） */
function fillControls() {
  for (const el of $$('[data-path]')) {
    const value = getPath(state.config, el.dataset.path);
    if (value !== undefined) writeControl(el, value);
  }
  syncThemeCards();
  syncConsolePreset();
  syncModeFields();
}

/** 按「数据源」切换时要显示哪些设置（.mode-xhs / .mode-app） */
function syncModeFields() {
  const mode = state.config?.source?.mode || 'xhs';
  for (const el of $$('.mode-xhs')) el.hidden = mode !== 'xhs';
  for (const el of $$('.mode-app')) el.hidden = mode !== 'app';
}

function bindControls() {
  for (const el of $$('[data-path]')) {
    const path = el.dataset.path;
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    if (el._bound) continue;
    el._bound = true;
    el.addEventListener(evt, () => {
      setPath(state.config, path, readControl(el, path));
      if (el.dataset.range) {
        const out = document.getElementById(el.dataset.range);
        if (out) out.textContent = el.value;
      }
      if (path === 'overlay.theme') syncThemeCards();
      if (path === 'source.mode') {
        syncModeFields();
        markDirty('切换数据源后需要重启采集');
      }
      scheduleSave();
    });
  }
}

/** 一次性写入一组配置（主题联动、一键风格、导入） */
function applyPatch(patch, { silent = false } = {}) {
  for (const [path, value] of Object.entries(flatten(patch))) {
    setPath(state.config, path, value);
  }
  fillControls();
  if (!silent) scheduleSave();
}

function markDirty(text = '保存中…') {
  const el = $('#savedHint');
  if (!el) return;
  el.textContent = text;
  el.classList.add('dirty');
}

function markSaved() {
  const el = $('#savedHint');
  if (!el) return;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.textContent = `已保存 ${t}`;
  el.classList.remove('dirty');
}

function scheduleSave() {
  markDirty();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveConfig, 260);
}

async function saveConfig() {
  if (!state.config) return;
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        overlay: state.config.overlay,
        source: state.config.source,
      }),
    });
    markSaved();
  } catch (err) {
    markDirty(`保存失败：${err.message}`);
    toast(`保存失败：${err.message}`);
  }
}

/* ------------------------------ 主题 / 预设 ------------------------------ */

function syncThemeCards() {
  const theme = state.config?.overlay?.theme;
  for (const card of $$('.theme-card')) {
    card.classList.toggle('active', card.dataset.theme === theme);
  }
}

/**
 * 中控台地址下拉：方舟是商家（店铺）后台，蒲公英是达人后台，普通个人账号进方舟只会看到招商页。
 * 拿不准就选「自定义」，把能看见弹幕的那个网页地址粘进去——插件认的是页面里的弹幕通道，不认域名。
 */
const CONSOLE_PRESETS = {
  ark: 'https://ark.xiaohongshu.com/live_center_control',
  pgy: 'https://pgy.xiaohongshu.com/commerce/redlive/live_center_control',
};

function syncConsolePreset() {
  const sel = $('#consolePreset');
  if (!sel) return;
  const url = (state.config?.source?.consoleUrl || '').trim();
  const hit = Object.entries(CONSOLE_PRESETS).find(([, v]) => v === url);
  sel.value = hit ? hit[0] : 'custom';
}

function bindConsolePreset() {
  const sel = $('#consolePreset');
  if (sel && !sel._bound) {
    sel._bound = true;
    sel.addEventListener('change', () => {
      const url = CONSOLE_PRESETS[sel.value];
      if (!url) {
        $('[data-path="source.consoleUrl"]')?.focus();
        return;
      }
      applyPatch({ source: { consoleUrl: url } });
      toast('已切换中控台地址');
    });
  }
}

/** 一键风格：只覆盖观感相关的字段，不影响采集设置（数值按 800×1000 的源调） */
const PRESETS = {
  classic: {
    overlay: {
      theme: 'bubble',
      fontSize: 22,
      fontWeight: 600,
      lineHeight: 1.45,
      color: '#ffffff',
      nicknameColor: '#ffd166',
      nicknameColorize: true,
      textStroke: true,
      textStrokeWidth: 1.5,
      textStrokeColor: 'rgba(0,0,0,0.85)',
      shadow: true,
      maxItems: 8,
      ttlMs: 18000,
      maxWidthPct: 100,
      animation: { in: 'slide', inDuration: 240, outDuration: 320 },
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
      text: { enter: '来了', follow: '关注了主播', like: '点了赞', gift: '送出' },
    },
  },
  clean: {
    overlay: {
      theme: 'minimal',
      fontSize: 23,
      fontWeight: 600,
      lineHeight: 1.4,
      color: '#ffffff',
      nicknameColor: '#7ee0a1',
      nicknameColorize: false,
      textStroke: true,
      textStrokeWidth: 1.5,
      textStrokeColor: 'rgba(0,0,0,0.9)',
      shadow: true,
      maxItems: 9,
      ttlMs: 15000,
      maxWidthPct: 100,
      animation: { in: 'fade', inDuration: 200, outDuration: 260 },
      card: { enabled: false, bg: 'transparent', radius: 0, paddingX: 4, paddingY: 3, blur: 0, border: 'none' },
      avatar: { show: false, size: 22 },
    },
  },
  sales: {
    overlay: {
      theme: 'capsule',
      fontSize: 24,
      fontWeight: 700,
      lineHeight: 1.4,
      color: '#ffffff',
      nicknameColor: '#ffe066',
      nicknameColorize: false,
      textStroke: true,
      textStrokeWidth: 1.5,
      textStrokeColor: 'rgba(0,0,0,0.9)',
      shadow: true,
      maxItems: 7,
      ttlMs: 26000,
      maxWidthPct: 100,
      animation: { in: 'pop', inDuration: 220, outDuration: 300 },
      card: {
        enabled: true,
        bg: 'linear-gradient(135deg, rgba(255,46,77,0.88), rgba(255,110,60,0.88))',
        radius: 999,
        paddingX: 13,
        paddingY: 7,
        blur: 0,
        border: '1px solid rgba(255,255,255,0.22)',
      },
      avatar: { show: true, size: 24 },
      text: { enter: '来啦', follow: '关注了你', like: '给你点赞', gift: '送出' },
    },
  },
  esports: {
    overlay: {
      theme: 'neon',
      fontSize: 22,
      fontWeight: 700,
      lineHeight: 1.4,
      color: '#eafff9',
      nicknameColor: '#00e5ff',
      nicknameColorize: true,
      textStroke: true,
      textStrokeWidth: 1.5,
      textStrokeColor: 'rgba(0,0,0,0.95)',
      shadow: true,
      maxItems: 8,
      ttlMs: 20000,
      maxWidthPct: 100,
      animation: { in: 'pop', inDuration: 240, outDuration: 300 },
      card: {
        enabled: true,
        bg: 'rgba(8,20,28,0.72)',
        radius: 4,
        paddingX: 10,
        paddingY: 6,
        blur: 6,
        border: '1px solid rgba(0,229,255,0.55)',
      },
      avatar: { show: true, size: 24 },
    },
  },
};

function bindThemeAndPresets() {
  for (const card of $$('.theme-card')) {
    card.addEventListener('click', () => {
      const theme = card.dataset.theme;
      applyPatch({ overlay: { theme, ...(THEME_BUNDLES[theme] || {}) } });
      toast(`主题：${card.querySelector('em').textContent}`);
    });
  }

  for (const chip of $$('[data-preset]')) {
    chip.addEventListener('click', () => {
      const patch = PRESETS[chip.dataset.preset];
      if (!patch) return;
      applyPatch(patch);
      toast(`已套用「${chip.textContent}」`);
    });
  }
}

/* ------------------------------ 标签页 ------------------------------ */

const TABS = ['style', 'source', 'voice', 'message', 'filter', 'advanced', 'debug'];

function activateTab(name) {
  if (!TABS.includes(name)) name = 'style';
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of $$('.pane')) p.classList.toggle('active', p.dataset.pane === name);
  try {
    localStorage.setItem('xhs-admin-tab', name);
  } catch {
    /* ignore */
  }
  if (name === 'debug' && state.rawOn) refreshRaw();
}

function initTabs() {
  for (const b of $$('.tab')) b.addEventListener('click', () => activateTab(b.dataset.tab));
  let saved = 'style';
  try {
    saved = localStorage.getItem('xhs-admin-tab') || 'style';
  } catch {
    /* ignore */
  }
  activateTab(saved);
}

/* ------------------------------ 状态 ------------------------------ */

const STATE_TEXT = {
  idle: '未启动',
  launching: '启动中',
  'login-required': '等待登录',
  capturing: '接收中',
  error: '出错',
};

function renderStatus(data) {
  const s = data.source || {};
  const badge = $('#stateBadge');
  const text = STATE_TEXT[s.state] || s.state || '未启动';

  badge.dataset.state =
    s.state === 'capturing' ? 'ok' : s.state === 'error' || s.state === 'login-required' ? 'err' : 'idle';
  $('#stateText').textContent = s.mode === 'mock' ? `模拟 · ${text}` : text;

  $('#kvState').textContent = text;
  $('#kvFrames').textContent = s.frames ?? 0;
  $('#kvEvents').textContent = s.events ?? 0;
  $('#kvSockets').textContent = s.sockets ?? 0;
  $('#kvClients').textContent = Number.isFinite(data.clients) ? data.clients : $('#kvClients').textContent;

  const notice = $('#sourceNotice');
  notice.className = 'notice';

  if (s.mode === 'mock') {
    notice.classList.add('ok');
    notice.textContent = '当前是模拟数据源，不会联网，也不会抓真实弹幕。想正式使用请把「数据源」切回真实数据源并重启。';
  } else if (s.state === 'login-required') {
    notice.classList.add('warn');
    notice.textContent =
      s.mode === 'app'
        ? '需要在直播助手里登录：在弹出的 App 窗口里登录你开播的账号。'
        : '需要登录：在弹出的 Chrome 窗口里扫码登录小红书，登录成功后会自动跳回中控台。';
  } else if (s.state === 'error') {
    notice.classList.add('err');
    notice.textContent = s.message || '启动失败，请查看命令行输出。';
  } else if (s.state === 'capturing') {
    notice.classList.add('ok');
    notice.textContent = `已连上弹幕通道${s.pageUrl ? `：${s.pageUrl}` : ''}`;
  } else if (s.state === 'launching') {
    notice.textContent = s.message || '正在启动浏览器…';
  } else {
    notice.textContent =
      s.mode === 'app'
        ? '点右上角「启动采集」，插件会拉起「小红书直播助手」并接上它的弹幕通道（请先把 App 完全退出）。'
        : '点右上角「启动采集」开始。首次使用会打开浏览器让你登录小红书。';
  }

  const unknown = s.unknownTypes || {};
  const names = Object.keys(unknown);
  if (names.length) {
    notice.classList.add('warn');
    notice.textContent += `　｜　未识别的事件 type：${names.map((n) => `${n}×${unknown[n]}`).join('、')}`;
  }

  renderTtsState(data.tts);
}

function renderTtsState(t) {
  const el = $('#ttsState');
  if (!el) return;
  if (!t) {
    el.textContent = '';
    return;
  }
  if (!t.enabled) {
    el.textContent = '未开启（打开上面的开关后，每一条弹幕都会被念出来）';
    return;
  }
  const parts = [`已播 ${t.spoken || 0} 条`];
  if (t.overlayStale) {
    parts.push('⚠ 弹幕层页面是旧版本（在 OBS 里右键该源 →「刷新页面」）');
  } else if (typeof t.overlayClients === 'number') {
    if (t.overlayClients > 0) {
      parts.push(`弹幕层连接 ${t.overlayClients} 个`);
    } else if (Number(t.unknownClients) > 0) {
      // 有 WebSocket 连着但没自报身份 —— 多半是加语音之前就打开的旧页面
      parts.push('⚠ 连上的弹幕层页面是旧版本，在 OBS 里右键该源 →「刷新页面」');
    } else {
      parts.push('⚠ 没有弹幕层页面连接（OBS 里那个浏览器源没开？）');
    }
  }
  if (t.lastPlay && t.overlayClients > 0) {
    parts.push(
      t.lastPlay.ok
        ? `最近一次：弹幕层已播放`
        : `最近一次：弹幕层没播出来（${t.lastPlay.reason || '原因未知'}）`,
    );
  }
  if (t.skipped) parts.push(`跳过 ${t.skipped} 条（排队满了）`);
  if (t.queue) parts.push(`队列 ${t.queue}`);
  if (t.failed) parts.push(`合成失败 ${t.failed}`);
  if (t.lastError) parts.push(`最近错误：${t.lastError}`);
  el.textContent = parts.join('　·　');
}

/** 试听：在控制台页面自己播一遍，不依赖 OBS 那边有没有开 */
async function playPreviewLocally(id) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(`/api/tts/audio/${id}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
        return true;
      }
    } catch {
      /* 还没合成好，继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function pollStatus() {
  try {
    const data = await api('/api/status');
    state.lastStatus = data;
    renderStatus(data);
  } catch {
    /* 服务没起来时静默 */
  }
}

/* ------------------------------ 原始帧 ------------------------------ */

function fmtRaw(entry) {
  const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
  let body = '';
  if (entry.dir === 'ws-frame') {
    body = `解析 ${entry.parsed} 条${entry.unknown?.length ? `，未知 ${entry.unknown.join(',')}` : ''}\n${entry.sample || ''}`;
  } else if (entry.dir === 'ws-open') {
    body = `${entry.url}${entry.relevant ? '（疑似弹幕通道）' : ''}`;
  } else if (entry.dir === 'ws-send-first') {
    body = `首帧发送：${entry.body || ''}`;
  } else if (entry.dir === 'http') {
    body = `${entry.url}\n${entry.body || ''}`;
  } else {
    body = JSON.stringify(entry, null, 0).slice(0, 1200);
  }
  return { time, dir: entry.dir, body };
}

function renderRaw(items) {
  const box = $('#rawLog');
  $('#rawCount').textContent = `${items.length} 条`;
  if (!items.length) {
    box.innerHTML = '<div class="empty">还没有记录</div>';
    return;
  }
  box.innerHTML = '';
  for (const item of items.slice(-80)) {
    const { time, dir, body } = fmtRaw(item);
    const div = document.createElement('div');
    div.className = 'raw-item';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = time;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = dir;
    div.append(t, tag, document.createTextNode(body));
    box.append(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function refreshRaw() {
  try {
    const data = await api('/api/raw?limit=80');
    renderRaw(data.items || []);
  } catch {
    /* ignore */
  }
}

function toggleRaw() {
  state.rawOn = !state.rawOn;
  $('#btnRawToggle').textContent = state.rawOn ? '停止记录' : '开始记录';
  clearInterval(state.rawTimer);
  if (state.rawOn) {
    refreshRaw();
    state.rawTimer = setInterval(refreshRaw, 1500);
  }
}

/* ------------------------------ 预览缩放 ------------------------------ */

/* 预览按 OBS 浏览器源的真实尺寸 800×1000 等比缩放 */
const PREVIEW_W = 800;

function fitPreview() {
  const wrap = document.querySelector('.preview-wrap');
  const frame = $('#preview');
  if (!wrap || !frame) return;
  const scale = wrap.clientWidth / PREVIEW_W;
  frame.style.transform = `scale(${scale})`;
}

/* ------------------------------ 事件 ------------------------------ */

async function action(fn, okText) {
  try {
    await fn();
    if (okText) toast(okText);
    pollStatus();
  } catch (err) {
    toast(err.message);
  }
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `xhs-danmaku-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('已导出配置文件');
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || typeof parsed !== 'object') throw new Error('不是合法的配置 JSON');
      await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ overlay: parsed.overlay, source: parsed.source }),
      });
      const data = await api('/api/config');
      state.config = data.config;
      fillControls();
      markSaved();
      toast('配置已导入');
    } catch (err) {
      toast(`导入失败：${err.message}`);
    }
  };
  reader.readAsText(file);
}

function wireActions() {
  $('#btnStart').onclick = () =>
    action(async () => {
      await saveConfig();
      await api('/api/start', { method: 'POST' });
    }, '已开始采集');

  $('#btnStop').onclick = () => action(() => api('/api/stop', { method: 'POST' }), '已停止');

  $('#btnRestart').onclick = () =>
    action(async () => {
      await saveConfig();
      await api('/api/restart', { method: 'POST' });
    }, '已重启');

  $('#btnLogin').onclick = () =>
    action(() => api('/api/login', { method: 'POST' }), '已打开登录页');

  $('#btnReload').onclick = () =>
    action(() => api('/api/reload', { method: 'POST' }), '已刷新中控台');

  $('#btnFocus').onclick = () =>
    action(() => api('/api/focus', { method: 'POST' }), '已切换窗口');

  const btnFocusApp = $('#btnFocusApp');
  if (btnFocusApp) {
    btnFocusApp.onclick = () => action(() => api('/api/focus', { method: 'POST' }), '已切换窗口');
  }

  const btnTtsTest = $('#btnTtsTest');
  if (btnTtsTest) {
    btnTtsTest.onclick = async () => {
      const text = ($('#ttsTestText').value || '').trim();
      btnTtsTest.disabled = true;
      const label = btnTtsTest.textContent;
      btnTtsTest.textContent = '合成中…';
      try {
        const r = await api('/api/tts/preview', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        toast(r.cleaned ? `正在念：${r.cleaned.slice(0, 24)}` : '已发送');
        if (r.item && r.item.id) {
          const ok = await playPreviewLocally(r.item.id);
          if (!ok) toast('合成超时了，稍后再试；或检查能不能连上微软朗读接口');
        }
      } catch (err) {
        toast(`试听失败：${err.message}`);
      } finally {
        btnTtsTest.disabled = false;
        btnTtsTest.textContent = label;
      }
    };
  }

  $('#btnSave').onclick = () => action(saveConfig, '已保存');

  $('#btnExport').onclick = exportConfig;

  $('#btnImport').onclick = () => $('#fileImport').click();
  $('#fileImport').onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) importConfig(file);
    e.target.value = '';
  };

  $('#btnReset').onclick = () =>
    action(async () => {
      const data = await api('/api/config/reset', { method: 'POST' });
      state.config = data.config;
      fillControls();
      markSaved();
    }, '已恢复默认');

  $('#btnRawToggle').onclick = toggleRaw;
  $('#btnRawClear').onclick = () =>
    action(async () => {
      await api('/api/raw/clear', { method: 'POST' });
      renderRaw([]);
    });

  $('#btnCopyObs').onclick = async () => {
    const input = $('#obsUrl');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('已复制 OBS 地址');
    } catch {
      input.select();
      document.execCommand('copy');
      toast('已复制 OBS 地址');
    }
  };

  $('#btnPreviewOpen').onclick = () =>
    window.open('/overlay', 'xhs-overlay-preview', 'width=1280,height=720');

  for (const btn of $$('#previewBg button')) {
    btn.onclick = () => {
      for (const b of $$('#previewBg button')) b.classList.toggle('on', b === btn);
      document.querySelector('.preview-wrap').dataset.bg = btn.dataset.bg;
    };
  }

  for (const btn of $$('[data-test]')) {
    btn.onclick = () =>
      action(
        () => api('/api/test', { method: 'POST', body: JSON.stringify({ kind: btn.dataset.test }) }),
        '已发送测试事件',
      );
  }
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  $('#obsUrl').value = `${location.origin}/overlay`;
  initTabs();
  wireActions();
  bindThemeAndPresets();
  bindConsolePreset();
  fitPreview();
  window.addEventListener('resize', fitPreview);

  try {
    const data = await api('/api/config');
    state.config = data.config;
    fillControls();
    bindControls();
    markSaved();
  } catch (err) {
    toast(`读取配置失败：${err.message}`);
  }

  pollStatus();
  state.statusTimer = setInterval(pollStatus, 1000);

  // 配置在别处被改动时（比如另一个标签页恢复默认），同步一次
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    // 自报身份：否则服务端会把控制台这条连接当成「不认识的老页面」
    ws.send(JSON.stringify({ type: 'hello', kind: 'admin', build: 'admin' }));
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'source') {
        // 只覆盖 source 字段，别把 tts 等其他状态清空（否则那行会闪成空白）
        state.lastStatus = { ...(state.lastStatus || {}), source: msg.data };
        renderStatus(state.lastStatus);
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    /* 状态轮询兜底，不用重连 */
  };
}

boot();
