import { decodeFrame } from '../xhs/decode.js';

/**
 * 把一帧原始文本喂给解码器，并把结果写进 bus 和 status。
 * 浏览器链路（src/sources/xhs.js）和直播助手链路（src/sources/zhushou.js）共用这一份，
 * 保证两条路解析出来的事件完全一致。
 *
 * @param {{bus: object, status: object, setStatus: (patch: object) => void}} ctx
 * @param {string} text 原始帧
 * @param {string} url  帧所属的 WebSocket 地址（只用于日志）
 * @param {boolean} relevant 这条 WS 是否疑似弹幕通道（不疑似时只处理明显带弹幕字段的帧）
 */
export function consumeFrame(ctx, text, url, relevant = true) {
  const { bus, status, setStatus } = ctx;
  if (!text) return;

  // 先记账再过滤：帧数统计的是「真的收到了多少帧」，方便判断连接是否活着
  setStatus({ frames: status.frames + 1, lastFrameAt: Date.now() });

  if (!relevant && !text.includes('customData') && !text.includes('"command"')) return;

  const out = decodeFrame(text);
  if (out.events.length === 0 && out.unknownTypes.length === 0) {
    // 只把异常/未知帧记账，避免日志被心跳刷满
    if (out.notes.length) bus.logRaw({ dir: 'ws-frame-note', url, notes: out.notes });
    return;
  }

  for (const unknownType of out.unknownTypes) {
    status.unknownTypes[unknownType] = (status.unknownTypes[unknownType] || 0) + 1;
  }

  for (const event of out.events) {
    const ok = bus.push(event);
    if (ok) setStatus({ events: status.events + 1 });
  }

  if (status.state !== 'capturing' && out.events.length > 0) {
    setStatus({ state: 'capturing', message: '已连上弹幕通道，正在接收' });
  }

  bus.logRaw({
    dir: 'ws-frame',
    url,
    parsed: out.events.length,
    unknown: out.unknownTypes,
    sample: JSON.stringify(out.events[0]?.raw || {}).slice(0, 1200),
  });
}
