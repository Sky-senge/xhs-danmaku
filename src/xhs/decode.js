import crypto from 'node:crypto';
import { makeEvent } from '../bus.js';

/**
 * 小红书直播 WS 帧解码
 * ---------------------------------------------------------------
 * 抓到的帧是两层套娃 + 一层 base64：
 *
 *   外层 JSON: { v:1, t:4, m:"0ac...", b:{ d:{ a:0, biz:"room", t:169..., b:[
 *                  { d: "<base64>", e:{}, m:"1" },
 *              ]}}}
 *        t = 4 表示这一帧带业务负载；t = 0 是空帧
 *
 *   base64 解码后是 JSON: { command:1, customData:"<json string>", roomId, roomType:"LIVE", ts, ... }
 *        command = 1 才是有用的业务消息（3 一类是控制帧）
 *
 *   customData 再解一次: { type:"text", desc:"弹幕内容",
 *                          profile:{ nickname, avatar, user_id, role },
 *                          commentId, current_time, ... }
 *
 *   type 决定事件类型。实测 type 集合（2025 版）：
 *     text / text_message            评论
 *     audience_join_v2               进场
 *     praise（+ light/combo_praise 等变体）  点赞
 *     follow_emcee（+ follow_v2 等变体）     关注
 *     gift_comment                   礼物
 *     share                          分享
 *     refresh                        房间统计（在线人数）
 *     letter_refresh / goods_rank_entrance_im / live_banner_resource  忽略
 * ---------------------------------------------------------------
 */

/** type -> 事件类型。null 表示已知但不需要展示。 */
export const TYPE_MAP = {
  // ---- 弹幕 ----
  text: 'comment',
  text_message: 'comment',
  comment: 'comment',
  live_comment: 'comment',
  chat: 'comment',

  // ---- 进场 ----
  audience_join_v2: 'enter',
  audience_join: 'enter',
  enter: 'enter',
  enter_room: 'enter',
  live_room_enter: 'enter',
  room_enter: 'enter',
  member_enter: 'enter',
  audience_enter: 'enter',

  // ---- 关注 ----
  follow_emcee: 'follow',
  follow: 'follow',
  follow_v2: 'follow',
  follow_comment: 'follow',
  live_follow: 'follow',
  room_follow: 'follow',
  user_follow: 'follow',
  subscribe: 'follow',
  subscribe_v2: 'follow',
  attention: 'follow',

  // ---- 点赞（小红书有很多变体名，先都收进来） ----
  praise: 'like',
  light: 'like',
  combo_praise: 'like',
  like: 'like',
  live_like: 'like',
  like_comment: 'like',
  live_common_msg_action: 'like',
  like_v2: 'like',
  thumb_up: 'like',
  thumb_up_v2: 'like',
  room_like: 'like',
  thumbnail_like: 'like',
  like_count: 'like',

  // ---- 礼物 ----
  gift_comment: 'gift',
  gift: 'gift',
  live_gift: 'gift',
  send_gift: 'gift',
  gift_send: 'gift',

  // ---- 已知但忽略 ----
  share: null,
  refresh: null,
  letter_refresh: null,
  live_banner_resource: null,
  goods_rank_entrance_im: null,
  fansgroup_join_room_effect: null,
  room_stat: null,
  ping: null,
  pong: null,
  ack: null,
};

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeJson(s) {
  const t = String(s).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/** 一层编码 -> 对象。依次尝试：本来就是对象 / 明文 JSON / base64 / URI encode */
function decodeLayer(d) {
  if (typeof d === 'object' && d !== null) return d;
  if (typeof d !== 'string') return undefined;
  if (looksLikeJson(d)) {
    const v = safeJson(d);
    if (v) return v;
  }
  // base64
  try {
    const text = Buffer.from(d, 'base64').toString('utf8');
    if (looksLikeJson(text)) {
      const v = safeJson(text);
      if (v) return v;
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const v = safeJson(m[0]);
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  // URI encode
  try {
    const text = decodeURIComponent(d);
    if (looksLikeJson(text)) return safeJson(text);
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * 从消息里抽用户信息。
 * 不同事件的用户对象挂在不同字段：点赞在 like_user_info，关注在 follow_user_info，
 * 礼物/评论在 send_user_info 或 profile。
 */
function extractUser(msg) {
  const p =
    msg.like_user_info ||
    msg.follow_user_info ||
    msg.send_user_info ||
    msg.gift_user_info ||
    msg.profile ||
    msg.user ||
    msg.sender ||
    msg.userInfo ||
    msg.user_info ||
    {};

  let nickname = pick(p, ['nickname', 'nick_name', 'nickName', 'name', 'user_name', 'userName']);
  const avatar = pick(p, ['avatar', 'avatar_url', 'avatarUrl', 'image', 'head_img', 'headImg']);
  const id = pick(p, ['user_id', 'userId', 'uid', 'id', 'userid']);
  const role = Number(pick(p, ['role', 'user_role', 'userRole']) ?? 0) || 0;

  // 点赞等事件的昵称有时只在 desc 里，例如「张三 点赞了」
  if (!nickname && typeof msg.desc === 'string') {
    const m = msg.desc.match(/^\s*([^\s:：,，]{1,24})\s*(?:为|给)?\s*(?:主播)?\s*(?:点赞|点了赞|来了|关注)/);
    if (m) nickname = m[1];
  }

  return {
    id: id == null ? '' : String(id),
    name: nickname == null ? '' : String(nickname),
    avatar: avatar == null ? '' : String(avatar),
    role,
  };
}

function extractText(msg) {
  const v = pick(msg, ['desc', 'content', 'text', 'comment', 'message', 'msg_content', 'msgContent']);
  return v == null ? '' : String(v);
}

function extractGift(msg) {
  const base = msg.base_gift_info || msg.gift_info || msg.giftInfo || msg.gift || {};
  const action = msg.gift_action_info || msg.giftActionInfo || {};
  const name =
    pick(base, ['name', 'gift_name', 'giftName', 'title']) ||
    pick(msg, ['gift_name', 'giftName', 'gift_title']) ||
    '礼物';
  const rawCount =
    pick(action, ['count', 'num', 'gift_count']) ||
    pick(msg, ['gift_count', 'giftCount', 'count', 'num']) ||
    1;
  const count = Number(rawCount);
  return {
    name: String(name),
    count: Number.isFinite(count) && count > 0 ? count : 1,
    coins: Number(pick(base, ['coins', 'price', 'coin']) ?? 0) || 0,
  };
}

/**
 * 单条业务消息 -> LiveEvent
 * @returns {{event: LiveEvent|null, unknownType?: string}}
 */
export function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return { event: null };

  const type = String(pick(msg, ['type', 'msg_type', 'msgType', 'event']) ?? '');
  if (!(type in TYPE_MAP)) {
    return { event: null, unknownType: type || '(empty)' };
  }
  const kind = TYPE_MAP[type];
  if (!kind) return { event: null };

  const user = extractUser(msg);
  if (!user.name) user.name = '匿名用户';

  const base = {
    id: pick(msg, ['commentId', 'comment_id', 'msgId', 'msg_id', 'id']) || crypto.randomUUID(),
    kind,
    ts: Number(pick(msg, ['current_time', 'currentTime', 'time', 'ts', 'timestamp']) || Date.now()) || Date.now(),
    user,
    raw: msg,
  };

  if (kind === 'comment') {
    const text = extractText(msg);
    if (!text.trim()) return { event: null };
    return { event: makeEvent({ ...base, text }) };
  }

  if (kind === 'gift') {
    return { event: makeEvent({ ...base, gift: extractGift(msg) }) };
  }

  if (kind === 'like') {
    // praise 系列的数量字段有好几个名字
    const raw = pick(msg, ['like_count', 'likeCount', 'like_num', 'likeNum', 'count', 'num', 'total']);
    const count = Number(raw);
    return {
      event: makeEvent({
        ...base,
        count: Number.isFinite(count) && count > 0 ? count : 1,
      }),
    };
  }

  // enter / follow
  return {
    event: makeEvent({
      ...base,
      text: '',
    }),
  };
}

/**
 * 解析一个 WS 帧载荷
 * @param {string|Buffer} payload
 * @returns {{events: LiveEvent[], unknownTypes: string[], frame: object|null, notes: string[]}}
 */
export function decodeFrame(payload) {
  const result = { events: [], unknownTypes: [], frame: null, notes: [] };

  let rawText;
  if (typeof payload === 'string') rawText = payload;
  else if (Buffer.isBuffer(payload)) rawText = payload.toString('utf8');
  else if (payload instanceof Uint8Array) rawText = Buffer.from(payload).toString('utf8');
  else return result;

  if (!rawText) return result;

  let outer = safeJson(rawText);
  if (!outer) {
    const maybe = decodeLayer(rawText);
    if (maybe) {
      outer = maybe;
      result.notes.push('外层帧不是明文 JSON，已按编码格式处理');
    } else {
      result.notes.push('无法解析外层帧');
      return result;
    }
  }
  result.frame = outer;

  // 心跳/空帧：t 不是 4 就没有业务负载
  const t = Number(outer.t);
  if (Number.isFinite(t) && t !== 4) {
    result.notes.push(`t=${t}（非业务帧）`);
    return result;
  }

  const items = outer?.b?.d?.b;
  if (!Array.isArray(items)) {
    result.notes.push('外层帧缺少 b.d.b 数组');
    return result;
  }

  for (const item of items) {
    const inner = decodeLayer(item?.d);
    if (!inner) {
      result.notes.push('内层 base64 解码失败');
      continue;
    }
    // command === 1 才是业务消息
    if (Number(inner.command) !== 1) {
      result.notes.push(`command=${inner.command}（忽略）`);
      continue;
    }
    let custom = inner.customData;
    if (typeof custom === 'string') custom = decodeLayer(custom);
    if (!custom) {
      result.notes.push('customData 解析失败');
      continue;
    }
    const { event, unknownType } = normalizeMessage(custom);
    if (event) result.events.push(event);
    if (unknownType) result.unknownTypes.push(unknownType);
  }

  return result;
}

/** 判断一个 WS url 是不是弹幕通道，避免把广告/埋点连接也解析 */
export function isDanmakuSocket(url) {
  if (!url) return false;
  // 实测端点：wss://apppush-rws.xiaohongshu.com/rwp
  return /xiaohongshu\.com/i.test(url) || /apppush|rwp|\/ws|websocket|socket/i.test(url);
}
