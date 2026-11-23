'use strict';
// The agent mascots: drawn here, shared by the dock window and the phone page. Nothing is copied from another project.
function blob(n, amp, r = 30, cy = 50) {
  let d = '';
  for (let i = 0; i <= 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    const k = r * (1 + amp * Math.cos(n * t));
    d += (i ? 'L' : 'M') + (50 + k * Math.cos(t)).toFixed(1) + ' ' + (cy + k * Math.sin(t)).toFixed(1);
  }
  return d + 'Z';
}
const LIGHT = '#f4f5f8';
const DARK = '#14161b';
const SPEC = {
  claude: { c: ['#ee8b6e', '#d4623f'], body: (f) => `<path d="${blob(10, 0.075)}" fill="${f}"/>` },
  codex: { c: ['#3fcfa3', '#1b9c75'], body: (f) => `<path d="${blob(5, 0.09)}" fill="${f}"/>` },
  opencode: { c: ['#565b68', '#2b2f36'], eye: LIGHT, body: (f) => `<rect x="22" y="32" width="56" height="46" rx="7" fill="${f}"/><g fill="#b9bcc4"><rect x="22" y="20" width="14" height="16" rx="3"/><rect x="43" y="20" width="14" height="16" rx="3"/><rect x="64" y="20" width="14" height="16" rx="3"/></g>`, ey: 56 },
  kilo: { c: ['#ffe066', '#f2b705'], body: (f) => `<rect x="20" y="20" width="60" height="60" rx="20" fill="${f}"/>` },
  mimo: { c: ['#ff8a4c', '#f05a1a'], body: (f) => `<rect x="20" y="22" width="60" height="58" rx="22" fill="${f}"/><circle cx="32" cy="20" r="7" fill="${f}"/><circle cx="68" cy="20" r="7" fill="${f}"/>` },
  cursor: { c: ['#4a4b52', '#1f2024'], eye: LIGHT, body: (f) => `<polygon points="50,18 77,34 77,66 50,82 23,66 23,34" fill="${f}" stroke="${f}" stroke-width="8" stroke-linejoin="round"/>` },
  copilot: { c: ['#ffffff', '#d4d8e2'], goggles: true, body: (f) => `<circle cx="50" cy="52" r="29" fill="${f}"/><rect x="17" y="38" width="66" height="26" rx="13" fill="#1f2126"/><circle cx="37" cy="51" r="9.5" fill="#fff"/><circle cx="63" cy="51" r="9.5" fill="#fff"/><circle cx="38" cy="52" r="4.2" fill="${DARK}" class="eye"/><circle cx="64" cy="52" r="4.2" fill="${DARK}" class="eye"/>` },
  gemini: { c: ['#6aa5ff', '#a07bff'], body: (f) => `<path d="M50 14C54 38 62 46 86 50C62 54 54 62 50 86C46 62 38 54 14 50C38 46 46 38 50 14Z" fill="${f}" stroke="${f}" stroke-width="6" stroke-linejoin="round"/>`, small: true },
  antigravity: { c: ['#4285f4', '#ea4335', '#fbbc05', '#34a853'], body: (f) => `<path d="M20 72Q20 20 50 20Q80 20 80 72Q80 80 70 80L30 80Q20 80 20 72Z" fill="${f}"/>`, ey: 52 },
  grok: { c: ['#34343a', '#0f0f12'], eye: LIGHT, body: (f) => `<ellipse cx="50" cy="52" rx="42" ry="11" transform="rotate(-18 50 50)" fill="none" stroke="#c9ccd6" stroke-width="3.4"/><circle cx="50" cy="50" r="26" fill="${f}"/><path d="M8 52A42 11 0 0 0 92 52" transform="rotate(-18 50 50)" fill="none" stroke="#c9ccd6" stroke-width="3.4"/>` },
  deepseek: { c: ['#6b83ff', '#3d58ee'], smile: true, body: (f) => `<path d="${blob(6, 0.045)}" fill="${f}"/>` },
  kimi: { c: ['#3a3a42', '#16171b'], eye: LIGHT, body: (f) => `<rect x="20" y="26" width="60" height="54" rx="24" fill="${f}"/><circle cx="76" cy="24" r="7" fill="#4c8dff"/>`, ey: 54 },
  pi: { c: ['#3a3c44', '#16171b'], eye: LIGHT, body: (f) => `<rect x="18" y="24" width="64" height="18" rx="6" fill="${f}"/><rect x="28" y="38" width="15" height="40" rx="6" fill="${f}"/><rect x="57" y="38" width="15" height="40" rx="6" fill="${f}"/>`, ey: 33, ed: 12, eh: 10, nocheek: true },
  omp: { c: ['#9b7cf8', '#5a3fd1'], body: (f) => `<rect x="18" y="24" width="64" height="18" rx="6" fill="${f}"/><rect x="28" y="38" width="15" height="40" rx="6" fill="${f}"/><rect x="57" y="38" width="15" height="40" rx="6" fill="${f}"/>`, ey: 33, ed: 12, eh: 10, nocheek: true },
  openclaw: { c: ['#ff6a5f', '#d92b2b'], body: (f) => `<g stroke="${f}" stroke-width="4" stroke-linecap="round"><path d="M38 30L30 12M62 30L70 12"/></g><circle cx="30" cy="11" r="4.5" fill="${f}"/><circle cx="70" cy="11" r="4.5" fill="${f}"/><circle cx="50" cy="54" r="28" fill="${f}"/>`, ey: 54 },
  hermes: { c: ['#3a3d45', '#1c1e23'], eye: LIGHT, body: (f) => `<circle cx="50" cy="52" r="29" fill="${f}"/><path d="M22 46A28 28 0 0 1 78 46Q64 40 50 46Q36 52 22 46Z" fill="#8d929c"/>`, ey: 58 },
  droid: { c: ['#ff9a4d', '#e8611a'], body: (f) => `<polygon points="50,18 77,34 77,66 50,82 23,66 23,34" fill="${f}" stroke="${f}" stroke-width="8" stroke-linejoin="round"/>` },
  trae: { c: ['#4be19b', '#16a870'], body: (f) => `<rect x="20" y="20" width="60" height="60" rx="18" fill="${f}"/>` },
  qoder: { c: ['#2a2d33', '#2fd36f'], eye: LIGHT, body: () => `<path d="M20 52A30 30 0 0 1 80 52Z" fill="#2a2d33"/><path d="M20 52A30 30 0 0 0 80 52Z" fill="#2fd36f"/>`, ey: 44 },
  zcode: { c: ['#44464e', '#1d1e22'], eye: LIGHT, body: (f) => `<polygon points="36,24 84,24 64,76 16,76" fill="${f}" stroke="${f}" stroke-width="8" stroke-linejoin="round"/>`, ex: 50 },
  codebuddy: { c: ['#5b8cff', '#8f6bff'], body: (f) => `<path d="M24 42L28 14L47 32ZM76 42L72 14L53 32Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><rect x="20" y="28" width="60" height="52" rx="24" fill="${f}"/>`, ey: 54 },
  workbuddy: { c: ['#35d98e', '#12a869'], body: (f) => `<path d="M24 42L28 14L47 32ZM76 42L72 14L53 32Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><rect x="20" y="28" width="60" height="52" rx="24" fill="${f}"/>`, ey: 54 },
  qwen: { c: ['#8b7bff', '#5b45e0'], body: (f) => `<path d="${blob(6, 0.07)}" fill="${f}"/>` },
  devin: { c: ['#3ed9c4', '#12a89a'], body: (f) => `<path d="${blob(4, 0.07)}" fill="${f}"/>` },
  cline: { c: ['#a98bff', '#6a47e8'], body: (f) => `<path d="M50 24V12" stroke="${f}" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="11" r="4.5" fill="${f}"/><rect x="20" y="24" width="60" height="56" rx="20" fill="${f}"/>` },
  roo: { c: ['#b890ff', '#7e4fe0'], body: (f) => `<ellipse cx="33" cy="22" rx="7" ry="15" transform="rotate(-12 33 22)" fill="${f}"/><ellipse cx="67" cy="22" rx="7" ry="15" transform="rotate(12 67 22)" fill="${f}"/><circle cx="50" cy="56" r="27" fill="${f}"/>`, ey: 56 },
  goose: { c: ['#ffffff', '#d3d8e2'], body: (f) => `<circle cx="46" cy="54" r="27" fill="${f}"/><polygon points="68,54 90,60 68,66" fill="#ff9f43"/>`, ex: 46 },
};
const FALLBACK = { c: ['#a3a9b5', '#7b818c'], body: (f) => `<circle cx="50" cy="50" r="30" fill="${f}"/>` };

const HAND = '<svg viewBox="0 0 24 24"><rect x="6" y="11" width="12" height="9" rx="4"/><rect x="6" y="5" width="2.7" height="10" rx="1.35"/><rect x="9.4" y="2.5" width="2.7" height="12" rx="1.35"/><rect x="12.9" y="3" width="2.7" height="11.5" rx="1.35"/><rect x="16.3" y="5" width="2.7" height="10" rx="1.35"/><rect x="2.6" y="11.5" width="2.7" height="6.5" rx="1.35" transform="rotate(-32 4 14)"/></svg>';

/** The drawing of one agent's bot: gradient + body + eyes (no ring, no state badge). Shared by the dock and the phone page. */
function mascotArt(id) {
  id = /^[a-z0-9_-]{1,24}$/.test(String(id)) ? String(id) : 'x'; // ids end up in markup
  const sp = (Object.hasOwn(SPEC, id) && SPEC[id]) || FALLBACK;
  const gid = 'g' + id + Math.random().toString(36).slice(2, 6);
  const stops = sp.c.map((c, i) => `<stop offset="${(i / (sp.c.length - 1 || 1)).toFixed(2)}" stop-color="${c}"/>`).join('');
  const dir = sp.c.length > 2 ? 'x1="0" y1="0" x2="1" y2="0"' : 'x1="0.2" y1="0" x2="0.8" y2="1"';
  const ey = sp.ey || 50, ex = sp.ex || 50, ed = sp.ed || 9.5, eh = sp.eh || (sp.small ? 10 : 16), ew = sp.small ? 6 : 8;
  const col = sp.eye || DARK;
  let face = '';
  if (!sp.goggles) {
    const eye = (cx) => sp.smile
      ? `<path class="eye" d="M${cx - 5} ${ey + 3}Q${cx} ${ey - 5} ${cx + 5} ${ey + 3}" fill="none" stroke="${col}" stroke-width="3.4" stroke-linecap="round"/>`
      : `<rect class="eye" x="${cx - ew / 2}" y="${ey - eh / 2}" width="${ew}" height="${eh}" rx="${ew / 2}" fill="${col}"/><circle cx="${cx + 1.4}" cy="${ey - eh / 2 + 3}" r="1.7" fill="#fff" opacity=".9"/>`;
    face = eye(ex - ed) + eye(ex + ed);
    if (!sp.nocheek) face += `<ellipse cx="${ex - ed - 8}" cy="${ey + eh / 2 + 2}" rx="4.6" ry="3" fill="#ff7a9a" opacity=".4"/><ellipse cx="${ex + ed + 8}" cy="${ey + eh / 2 + 2}" rx="4.6" ry="3" fill="#ff7a9a" opacity=".4"/>`;
  }
  return { defs: `<defs><linearGradient id="${gid}" ${dir}>${stops}</linearGradient></defs>`, body: `<g class="body-g">${sp.body('url(#' + gid + ')')}${face}</g>` };
}

/** A small standalone logo (an <svg> string) for lists. */
function logoSvg(id, px = 24) {
  const m = mascotArt(id);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}" aria-hidden="true">${m.defs}${m.body}</svg>`;
}
