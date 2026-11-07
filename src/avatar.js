/** 本地生成头像（内联 SVG），不依赖外网图片：昵称首字 + 按昵称取色的渐变底 */
export function avatarFor(name = '?') {
  const hue = [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
  const initial = [...name][0] || '?';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},72%,64%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 42) % 360},68%,46%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="80" height="80" fill="url(#g)"/>` +
    `<text x="40" y="55" font-size="34" font-weight="700" font-family="sans-serif" ` +
    `text-anchor="middle" fill="#ffffff">${escapeXml(initial)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}
