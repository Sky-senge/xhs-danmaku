/**
 * 主题 = 装饰性 CSS（见 overlay.css）+ 下面这组默认观感。
 * 点主题卡时把观感一起写进配置，所以之后手动微调（背景、圆角、颜色…）不会被主题 CSS 覆盖。
 * 这里是唯一来源：控制台（web/admin/admin.js）和截图脚本（scripts/shot-themes.mjs）都引用它。
 *
 * 数值按 OBS 浏览器源 800×1000 调过（字号 22 / 头像 26 那一档）。
 */

export const THEME_BUNDLES = {
  bubble: {
    color: '#ffffff',
    nicknameColor: '#ffd166',
    textStroke: true,
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
  },
  minimal: {
    color: '#ffffff',
    nicknameColor: '#7ee0a1',
    textStroke: true,
    shadow: true,
    card: { enabled: false, bg: 'transparent', radius: 0, paddingX: 0, paddingY: 3, blur: 0, border: 'none' },
    avatar: { show: false, size: 24 },
  },
  capsule: {
    color: '#ffffff',
    nicknameColor: '#ffd166',
    card: {
      enabled: true,
      bg: 'rgba(0,0,0,0.62)',
      radius: 999,
      paddingX: 14,
      paddingY: 5,
      blur: 0,
      border: '1px solid rgba(255,255,255,0.12)',
    },
    avatar: { show: true, size: 24 },
  },
  neon: {
    color: '#eafcff',
    nicknameColor: '#59f0ff',
    textStroke: false,
    card: {
      enabled: true,
      bg: 'rgba(6,8,16,0.68)',
      radius: 7,
      paddingX: 11,
      paddingY: 6,
      blur: 6,
      border: '1px solid rgba(89,240,255,0.55)',
    },
    avatar: { show: true, size: 24 },
  },
  glass: {
    color: '#ffffff',
    nicknameColor: '#ffd166',
    card: {
      enabled: true,
      bg: 'rgba(255,255,255,0.14)',
      radius: 9,
      paddingX: 11,
      paddingY: 6,
      blur: 16,
      border: '1px solid rgba(255,255,255,0.30)',
    },
    avatar: { show: true, size: 24 },
  },
};
