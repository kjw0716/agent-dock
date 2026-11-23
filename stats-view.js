'use strict';
// The statistics view inside the dock window (index.html).
//
// One surface, one grid. Every agent is one row; the columns are shared by everything on the page:
//   agent | tokens | cost | time
// The lanes show the chosen range day by day (bars: tokens, strip below: time working / waiting for you). Clicking a
// day opens the hour-by-hour view of that day directly below, in the same columns and the same row order. The tables
// at the bottom follow the agent you click. Data: `hud.statsGet(range)` (see stats.js). Plain SVG, no dependencies.
(function () {
  const I18N = {
    en: {
      r7: '7 days', r30: '30 days', r90: '90 days', r365: '1 year',
      indexing: 'Indexing…',
      tokens: 'Tokens', cost: 'Estimated cost', sessions: 'Sessions', cache: 'Cache hit',
      input: 'new input', output: 'output', cacheRead: 'cache read', cacheWrite: 'cache write',
      unpriced: (n) => `${n} model${n === 1 ? '' : 's'} without a price`, unpricedTip: 'Add them to prices.json in the data folder',
      working: 'Working', waiting: 'Waiting for you',
      allAgents: 'All agents', agent: 'Agent', costShort: 'Cost', laneHint: 'bars: tokens per day · strip: time working / waiting for you',
      noAgents: 'No usage in this range.',
      day: 'Hour by hour', today: 'Today', prev: 'Previous day', next: 'Next day',
      noDay: 'Nothing recorded on this day. The dock records state changes while it runs.', tooOld: 'The hour-by-hour view keeps the last 14 days.',
      sessionsTab: 'Sessions', modelsTab: 'Models', projectsTab: 'Projects',
      session: 'Session', project: 'Project', model: 'Model', last: 'Last active', tokensCol: 'Tokens', costCol: 'Cost', ctx: 'Context', calls: 'Calls',
      noPrice: 'no price', partial: 'partly unpriced', clear: 'Show all agents',
      now: 'now', agoM: (n) => `${n} min ago`, agoH: (n) => `${n} h ago`, agoD: (n) => `${n} d ago`, sub: 'of which sub-agents',
      callsWord: 'calls',
    },
    zh: {
      r7: '7 天', r30: '30 天', r90: '90 天', r365: '1 年',
      indexing: '正在索引…',
      tokens: 'Token', cost: '估算费用', sessions: '会话', cache: '缓存命中',
      input: '新输入', output: '输出', cacheRead: '缓存读', cacheWrite: '缓存写',
      unpriced: (n) => `${n} 个模型没有价格`, unpricedTip: '到数据目录的 prices.json 里补上',
      working: '工作中', waiting: '等你',
      allAgents: '全部 Agent', agent: 'Agent', costShort: '费用', laneHint: '柱：每日 token · 下方细条：工作 / 等你的时间',
      noAgents: '这个范围内没有用量。',
      day: '逐小时', today: '今天', prev: '前一天', next: '后一天',
      noDay: '这一天没有记录。Dock 运行时才会记录状态变化。', tooOld: '逐小时视图只保留最近 14 天。',
      sessionsTab: '会话', modelsTab: '模型', projectsTab: '项目',
      session: '会话', project: '项目', model: '模型', last: '最近活动', tokensCol: 'Token', costCol: '费用', ctx: '上下文', calls: '调用',
      noPrice: '无价格', partial: '部分无价格', clear: '显示全部 Agent',
      now: '刚刚', agoM: (n) => `${n} 分钟前`, agoH: (n) => `${n} 小时前`, agoD: (n) => `${n} 天前`, sub: '其中子 agent',
      callsWord: '次调用',
    },
  };
  const FALLBACK = ['#b4a0ff', '#6ee7d8', '#f2a65a', '#9bd35a', '#ff8fab', '#8ab4ff'];
  const DAY = 86400000;
  const W = 1000; // plot width in viewBox units

  let root = null;
  let api = null;
  let lang = 'en';
  let timer = null;
  let loading = false;
  let again = false;
  let colorFn = () => null;
  const state = { range: '30d', day: null, tab: 'sessions', agent: null, sort: 'last', data: null, names: {} };

  const t = (k, ...a) => {
    const v = (I18N[lang] || I18N.en)[k];
    return typeof v === 'function' ? v(...a) : v;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => root.querySelector('#st-' + id);

  const fmtTok = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    return String(Math.round(n));
  };
  const fmtCost = (c) => (c >= 1000 ? '$' + Math.round(c).toLocaleString('en-US') : c >= 100 ? '$' + c.toFixed(0) : '$' + c.toFixed(2));
  const fmtDur = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return '0m';
    const h = Math.floor(m / 60);
    return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };
  const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const fmtDayLong = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const base = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '?';
  const dayStr = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayStart = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  // The mascot colour of the agent, unless it is too dark to read on this background (OpenCode, Grok, Cursor...): then
  // a light colour from a fixed list, handed out in the order of the sorted ids of all dark agents, so each one keeps
  // its own colour and no two of the first six share one.
  const lum = (c) => {
    const m = c && /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  const colorOf = (id) => {
    const c = colorFn(id);
    if (lum(c) >= 95) return c;
    const dark = [...new Set([...Object.keys(state.names), id])].filter((x) => lum(colorFn(x)) < 95).sort();
    return FALLBACK[Math.max(0, dark.indexOf(id)) % FALLBACK.length];
  };
  const name = (id) => state.names[id] || id;

  // ------------------------------------------------------------------ tooltip
  let tip = null;
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { if (tip) tip.style.display = 'none'; };
  const trow = (a, b) => `<div class="r"><span>${a}</span><b>${b}</b></div>`;

  // ------------------------------------------------------------------ derived data
  function daysOf(d) {
    const out = [];
    const first = new Date(d.from);
    first.setHours(0, 0, 0, 0);
    const d0 = new Date(first);
    while (d0.getTime() <= d.to) {
      out.push(dayStr(d0.getTime()));
      d0.setDate(d0.getDate() + 1);
    }
    return out;
  }
  function agentsOf(d) {
    const ids = new Set(Object.keys(d.usage.byAgent));
    for (const id of Object.keys(d.states.days)) ids.add(id);
    return [...ids].sort((a, b) => ((d.usage.byAgent[b] || {}).i + (d.usage.byAgent[b] || {}).o + (d.usage.byAgent[b] || {}).cr + (d.usage.byAgent[b] || {}).cw || 0) - ((d.usage.byAgent[a] || {}).i + (d.usage.byAgent[a] || {}).o + (d.usage.byAgent[a] || {}).cr + (d.usage.byAgent[a] || {}).cw || 0));
  }
  const tokOf = (b) => (b ? b.i + b.o + b.cr + b.cw : 0);

  // ------------------------------------------------------------------ summary
  function renderSummary(d) {
    const u = d.usage;
    const tot = u.totals;
    const input = tot.i + tot.cr + tot.cw;
    const hit = input ? tot.cr / input : 0;
    const unp = tot.unpriced.length;
    const item = (v, label, extra) => `<div class="sm"><div class="sv">${v}</div><div class="sl">${label}${extra || ''}</div></div>`;
    $('sum').innerHTML =
      item(fmtTok(tot.tokens), t('tokens'), `<span title="${esc(t('input'))} ${fmtTok(tot.i)} · ${esc(t('output'))} ${fmtTok(tot.o)} · ${esc(t('cacheRead'))} ${fmtTok(tot.cr)} · ${esc(t('cacheWrite'))} ${fmtTok(tot.cw)}"> · ${fmtTok(tot.n)} ${t('callsWord')}</span>`) +
      item(fmtCost(tot.cost), t('cost'), unp ? ` <span class="warn" title="${esc(tot.unpriced.join(', ') + ' — ' + t('unpricedTip'))}">· ${esc(t('unpriced', unp))}</span>` : '') +
      item(String(u.sessionCount), t('sessions')) +
      item((hit * 100).toFixed(1) + '%', t('cache'));
  }

  // ------------------------------------------------------------------ lanes
  function renderLanes(d) {
    const u = d.usage;
    const ids = agentsOf(d);
    const days = daysOf(d);
    if (!ids.length) {
      $('lanes').innerHTML = `<div class="nodata">${t('noAgents')}</div>`;
      return;
    }
    // shared scales: honest comparison between agents
    let maxTok = 1;
    let maxState = 2 * 3600000;
    for (const day of days) {
      const dd = u.byDay[day];
      if (dd) for (const v of Object.values(dd.agents)) maxTok = Math.max(maxTok, v);
      for (const id of ids) {
        const s = (d.states.days[id] || {})[day];
        if (s) maxState = Math.max(maxState, s.w + s.a);
      }
    }
    const colW = W / days.length;
    const BAR_H = 34;
    const GAP = 3;
    const STRIP_H = 9;
    const H = BAR_H + GAP + STRIP_H;
    const barW = Math.max(1, colW * 0.74);
    const sel = days.indexOf(state.day);
    let html = `<div class="lrow lhead"><div>${t('agent')}</div><div class="num">${t('tokens')}</div><div class="num">${t('costShort')}</div><div class="hint">${t('laneHint')}</div></div>`;
    for (const id of ids) {
      const tot = u.byAgent[id];
      const col = colorOf(id);
      let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="plot">`;
      if (sel >= 0) svg += `<rect x="${sel * colW}" y="0" width="${colW}" height="${H}" class="selday"/>`;
      days.forEach((day, i) => {
        const x = i * colW;
        const tok = (u.byDay[day] && u.byDay[day].agents[id]) || 0;
        const gx = x + (colW - barW) / 2;
        if (tok) {
          const h = Math.max(1, (tok / maxTok) * BAR_H);
          svg += `<rect x="${gx}" y="${BAR_H - h}" width="${barW}" height="${h}" fill="${col}"/>`;
        }
        const s = (d.states.days[id] || {})[day];
        if (s) {
          const hw = (s.w / maxState) * STRIP_H;
          const ha = (s.a / maxState) * STRIP_H;
          if (hw) svg += `<rect x="${gx}" y="${H - hw - ha}" width="${barW}" height="${hw}" class="stw"/>`;
          if (ha) svg += `<rect x="${gx}" y="${H - ha}" width="${barW}" height="${ha}" class="sta"/>`;
        }
        svg += `<rect x="${x}" y="0" width="${colW}" height="${H}" fill="transparent" class="hit" data-day="${day}" data-agent="${esc(id)}"/>`;
      });
      svg += '</svg>';
      const cost = tot ? (tot.unp && !tot.cost ? `<span class="mut">${t('noPrice')}</span>` : fmtCost(tot.cost) + (tot.unp ? '*' : '')) : '';
      html += `<div class="lrow${state.agent === id ? ' on' : ''}" data-agent="${esc(id)}">
        <button class="who" data-filter="${esc(id)}" title="${esc(t('clear'))}"><i style="background:${col}"></i>${esc(name(id))}</button>
        <div class="num">${tot ? fmtTok(tokOf(tot)) : '–'}</div><div class="num">${cost}</div><div class="cell">${svg}</div></div>`;
    }
    // the sum of everything: the same columns, its own scale
    {
      let maxAll = 1;
      let maxAllState = 2 * 3600000;
      const sumState = (day) => ids.reduce((a, id) => {
        const s = (d.states.days[id] || {})[day];
        return s ? { w: a.w + s.w, a: a.a + s.a } : a;
      }, { w: 0, a: 0 });
      for (const day of days) {
        maxAll = Math.max(maxAll, (u.byDay[day] && u.byDay[day].total) || 0);
        const ss = sumState(day);
        maxAllState = Math.max(maxAllState, ss.w + ss.a);
      }
      let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="plot">`;
      if (sel >= 0) svg += `<rect x="${sel * colW}" y="0" width="${colW}" height="${H}" class="selday"/>`;
      days.forEach((day, i) => {
        const x = i * colW;
        const gx = x + (colW - barW) / 2;
        const tok = (u.byDay[day] && u.byDay[day].total) || 0;
        if (tok) {
          const h = Math.max(1, (tok / maxAll) * BAR_H);
          svg += `<rect x="${gx}" y="${BAR_H - h}" width="${barW}" height="${h}" class="allbar"/>`;
        }
        const ss = sumState(day);
        const hw = (ss.w / maxAllState) * STRIP_H;
        const ha = (ss.a / maxAllState) * STRIP_H;
        if (hw) svg += `<rect x="${gx}" y="${H - hw - ha}" width="${barW}" height="${hw}" class="stw"/>`;
        if (ha) svg += `<rect x="${gx}" y="${H - ha}" width="${barW}" height="${ha}" class="sta"/>`;
        svg += `<rect x="${x}" y="0" width="${colW}" height="${H}" fill="transparent" class="hit" data-day="${day}" data-agent="__all"/>`;
      });
      svg += '</svg>';
      const tt = u.totals;
      html += `<div class="lrow sumrow"><div class="who static"><i class="allbar"></i>${esc(t('allAgents'))}</div>
        <div class="num">${fmtTok(tt.tokens)}</div><div class="num">${fmtCost(tt.cost)}${tt.unpriced.length ? '*' : ''}</div><div class="cell">${svg}</div></div>`;
    }
    // date axis, in the same column as the plots
    const every = Math.max(1, Math.ceil(days.length / 10));
    const ticks = days.map((day, i) => (i % every === 0 || i === days.length - 1 ? `<span style="left:${((i + 0.5) / days.length) * 100}%">${day.slice(5)}</span>` : '')).join('');
    html += `<div class="lrow laxis"><div></div><div></div><div></div><div class="cell axis">${ticks}</div></div>`;
    $('lanes').innerHTML = html;
  }

  // ------------------------------------------------------------------ one day, hour by hour
  function renderDay(d) {
    const key = state.day;
    const start = dayStart(key);
    const end = start + DAY;
    const todayKey = dayStr(d.now);
    const ids = agentsOf(d);
    const dayData = d.usage.byDay[key];
    const detailFrom = d.states.detailFrom;
    let working = 0;
    let waiting = 0;
    const lanes = [];
    for (const id of ids) {
      const segs = (d.states.detail[id] || []).filter((s) => s.to > start && s.from < end).map((s) => ({ ...s, from: Math.max(s.from, start), to: Math.min(s.to, end) }));
      for (const s of segs) (s.state === 'waiting' ? (waiting += s.to - s.from) : (working += s.to - s.from));
      if (segs.length || (dayData && dayData.agents[id])) lanes.push({ id, segs });
    }
    const idx = daysOf(d).indexOf(key);
    const days = daysOf(d);
    const title = key === todayKey ? `${t('today')} · ${fmtDayLong(start)}` : fmtDayLong(start);
    let html = `<div class="lrow dhead">
      <div class="dtitle">${t('day')}</div>
      <div class="dnav"><button data-nav="-1" title="${esc(t('prev'))}" ${idx <= 0 ? 'disabled' : ''}>‹</button><b>${esc(title)}</b><button data-nav="1" title="${esc(t('next'))}" ${idx >= days.length - 1 ? 'disabled' : ''}>›</button></div>
      <div class="num"></div>
      <div class="dtot"><span class="dot w"></span>${t('working')} <b>${fmtDur(working)}</b> <span class="dot a"></span>${t('waiting')} <b>${fmtDur(waiting)}</b></div></div>`;
    if (start < detailFrom) {
      $('day').innerHTML = html + `<div class="lrow"><div></div><div></div><div></div><div class="note">${t('tooOld')}</div></div>`;
      return;
    }
    if (!lanes.length) {
      $('day').innerHTML = html + `<div class="lrow"><div></div><div></div><div></div><div class="note">${t('noDay')}</div></div>`;
      return;
    }
    const nowMin = key === todayKey ? Math.min(1440, Math.round((d.now - start) / 60000)) : 1440;
    for (const { id, segs } of lanes) {
      const col = colorOf(id);
      let svg = `<svg viewBox="0 0 1440 18" preserveAspectRatio="none" class="plot day">`;
      for (let h = 0; h <= 24; h += 3) svg += `<line x1="${h * 60}" x2="${h * 60}" y1="0" y2="18" class="grid"/>`;
      svg += `<rect x="0" y="4" width="${nowMin}" height="10" class="lane"/>`;
      for (const s of segs) {
        const x = (s.from - start) / 60000;
        const w = Math.max(1.5, (s.to - s.from) / 60000);
        svg += `<rect x="${x}" y="4" width="${w}" height="10" rx="1.5" class="${s.state === 'waiting' ? 'sta' : 'stw'} seg" data-id="${esc(id)}" data-a="${s.from}" data-b="${s.to}" data-s="${s.state}" data-n="${s.count}"/>`;
      }
      svg += '</svg>';
      const tok = dayData && dayData.agents[id];
      const c = dayData && dayData.agentCost && dayData.agentCost[id];
      html += `<div class="lrow"><div class="who static"><i style="background:${col}"></i>${esc(name(id))}</div><div class="num">${tok ? fmtTok(tok) : ''}</div><div class="num">${c ? fmtCost(c) : ''}</div><div class="cell">${svg}</div></div>`;
    }
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
    html += `<div class="lrow laxis"><div></div><div></div><div></div><div class="cell axis hours">${ticks}</div></div>`;
    $('day').innerHTML = html;
  }

  // ------------------------------------------------------------------ tables
  function ago(ms) {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return t('now');
    if (m < 60) return t('agoM', m);
    if (m < 1440) return t('agoH', Math.floor(m / 60));
    return t('agoD', Math.floor(m / 1440));
  }
  const costCell = (cost, unp) => (unp && !cost ? `<span class="mut">${t('noPrice')}</span>` : fmtCost(cost) + (unp ? `<span class="mut" title="${esc(t('partial'))}">*</span>` : ''));
  const who = (id) => `<span class="dotc" style="background:${colorOf(id)}"></span>${esc(name(id))}`;

  function renderTables(d) {
    const u = d.usage;
    const tabs = [['sessions', t('sessionsTab')], ['models', t('modelsTab')], ['projects', t('projectsTab')]];
    const filter = state.agent ? `<button class="pill" data-clear="1" title="${esc(t('clear'))}">${who(state.agent)} ✕</button>` : '';
    let head = `<div class="thead"><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>${filter}</div>`;
    let body = '';
    if (state.tab === 'sessions') {
      const list = u.sessions.filter((s) => !state.agent || s.a === state.agent);
      const by = { last: (a, b) => b.last - a.last, tokens: (a, b) => tokOf(b) - tokOf(a), cost: (a, b) => (b.cost || 0) - (a.cost || 0) }[state.sort];
      list.sort(by);
      const th = (key, label, num) => `<th class="${num ? 'num ' : ''}sort ${state.sort === key ? 'cur' : ''}" data-sort="${key}">${label}${state.sort === key ? ' ↓' : ''}</th>`;
      let rows = '';
      for (const s of list) {
        const model = Object.entries(s.m).sort((a, b) => b[1] - a[1])[0];
        const pct = s.ctx ? Math.min(100, (s.ctx / 1e6) * 100) : 0;
        rows += `<tr><td>${who(s.a)}</td>
          <td title="${esc(s.title || '')}">${esc(s.title || base(s.p))}</td>
          <td class="mut" title="${esc(s.p)}">${esc(base(s.p))}</td>
          <td class="mut" title="${esc(Object.keys(s.m).join(', '))}">${esc(model ? model[0] : '')}</td>
          <td class="mut">${ago(s.last)}</td>
          <td class="num" title="${esc(t('input'))} ${fmtTok(s.i)} · ${esc(t('output'))} ${fmtTok(s.o)} · ${esc(t('cacheRead'))} ${fmtTok(s.cr)} · ${esc(t('cacheWrite'))} ${fmtTok(s.cw)}${s.sub ? ' · ' + esc(t('sub')) + ' ' + fmtTok(s.sub) : ''}">${fmtTok(tokOf(s))}</td>
          <td class="num">${s.cost == null ? `<span class="mut">${t('noPrice')}</span>` : fmtCost(s.cost)}</td>
          <td class="num">${s.ctx ? fmtTok(s.ctx) + `<span class="bar"><i class="${pct > 70 ? 'hi' : ''}" style="width:${pct}%"></i></span>` : ''}</td></tr>`;
      }
      body = list.length
        ? `<div class="tablewrap"><table><thead><tr><th>${t('agent')}</th><th>${t('session')}</th><th>${t('project')}</th><th>${t('model')}</th>${th('last', t('last'))}${th('tokens', t('tokensCol'), true)}${th('cost', t('costCol'), true)}<th class="num">${t('ctx')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="nodata">${t('noAgents')}</div>`;
    } else {
      const src = state.tab === 'models' ? u.byAM : u.byAP;
      const list = Object.entries(src)
        .map(([k, v]) => {
          const i = k.indexOf('|');
          return { agent: k.slice(0, i), key: k.slice(i + 1), v };
        })
        .filter((r) => !state.agent || r.agent === state.agent)
        .sort((a, b) => tokOf(b.v) - tokOf(a.v));
      let rows = '';
      for (const r of list) {
        rows += `<tr><td>${who(r.agent)}</td><td title="${esc(r.key)}">${esc(state.tab === 'models' ? r.key : base(r.key))}</td>${state.tab === 'projects' ? `<td class="mut" title="${esc(r.key)}">${esc(r.key)}</td>` : ''}
          <td class="num">${fmtTok(r.v.n)}</td><td class="num" title="${esc(t('input'))} ${fmtTok(r.v.i)} · ${esc(t('output'))} ${fmtTok(r.v.o)} · ${esc(t('cacheRead'))} ${fmtTok(r.v.cr)} · ${esc(t('cacheWrite'))} ${fmtTok(r.v.cw)}">${fmtTok(tokOf(r.v))}</td>
          <td class="num">${costCell(r.v.cost, r.v.unp)}</td></tr>`;
      }
      body = list.length
        ? `<div class="tablewrap"><table><thead><tr><th>${t('agent')}</th><th>${state.tab === 'models' ? t('model') : t('project')}</th>${state.tab === 'projects' ? '<th></th>' : ''}<th class="num">${t('calls')}</th><th class="num">${t('tokensCol')}</th><th class="num">${t('costCol')}</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="nodata">${t('noAgents')}</div>`;
    }
    $('tables').innerHTML = head + body;
  }

  // ------------------------------------------------------------------ main
  function render() {
    if (!root) return;
    $('ranges').innerHTML = [['7d', t('r7')], ['30d', t('r30')], ['90d', t('r90')], ['365d', t('r365')]].map(([v, l]) => `<button data-range="${v}" class="${v === state.range ? 'on' : ''}">${esc(l)}</button>`).join('');
    const d = state.data;
    if (!d) return;
    const days = daysOf(d);
    if (!state.day || !days.includes(state.day)) state.day = dayStr(d.now);
    $('status').textContent = d.usage.scanning ? t('indexing') : '';
    renderSummary(d);
    renderLanes(d);
    renderDay(d);
    renderTables(d);
  }

  async function load() {
    if (loading) { again = true; return; }
    loading = true;
    try {
      state.data = await api.get(state.range);
      render();
    } catch (e) {
      $('status').textContent = String((e && e.message) || e);
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }

  function mount(el, a) {
    root = el;
    api = a;
    root.innerHTML = `<div class="st-page">
      <header class="st-top"><div class="st-sum" id="st-sum"></div><div class="st-ctl"><span class="st-status" id="st-status"></span><div class="sg" id="st-ranges"></div></div></header>
      <section class="st-sec" id="st-lanes"></section>
      <section class="st-sec" id="st-day"></section>
      <section class="st-sec" id="st-tables"></section>
    </div><div class="tt" id="st-tt"></div>`;
    tip = $('tt');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-range],[data-tab],[data-sort],[data-filter],[data-clear],[data-nav],.hit');
      if (!b) return;
      if (b.dataset.range) { state.range = b.dataset.range; render(); load(); }
      else if (b.dataset.tab) { state.tab = b.dataset.tab; render(); }
      else if (b.dataset.sort) { state.sort = b.dataset.sort; render(); }
      else if (b.dataset.filter) { state.agent = state.agent === b.dataset.filter ? null : b.dataset.filter; render(); }
      else if (b.dataset.clear) { state.agent = null; render(); }
      else if (b.dataset.nav) {
        const days = daysOf(state.data);
        const i = days.indexOf(state.day) + Number(b.dataset.nav);
        if (i >= 0 && i < days.length) { state.day = days[i]; render(); }
      } else if (b.dataset.day) { state.day = b.dataset.day; render(); }
    });
    root.addEventListener('mousemove', (e) => {
      const d = state.data;
      const hit = e.target.closest('.hit');
      if (hit && d) {
        const day = hit.dataset.day;
        const id = hit.dataset.agent;
        const dd = d.usage.byDay[day];
        const all = id === '__all';
        const tok = all ? (dd && dd.total) || 0 : (dd && dd.agents[id]) || 0;
        const c = all ? dd && dd.cost : dd && dd.agentCost && dd.agentCost[id];
        const s = all
          ? Object.values(d.states.days).reduce((a, m) => (m[day] ? { w: a.w + m[day].w, a: a.a + m[day].a } : a), { w: 0, a: 0 })
          : (d.states.days[id] || {})[day];
        showTip(e, `<div class="t">${esc(all ? t('allAgents') : name(id))} · ${esc(fmtDay(dayStart(day)))}</div>${trow(t('tokens'), fmtTok(tok))}${c ? trow(t('costShort'), fmtCost(c)) : ''}${s && (s.w || s.a) ? trow(t('working'), fmtDur(s.w)) + trow(t('waiting'), fmtDur(s.a)) : ''}`);
        return;
      }
      const seg = e.target.closest('.seg');
      if (seg) {
        const x = +seg.dataset.a;
        const y = +seg.dataset.b;
        const n = +seg.dataset.n;
        showTip(e, `<div class="t">${esc(name(seg.dataset.id))} · ${seg.dataset.s === 'waiting' ? t('waiting') : t('working')}</div>${trow(`${fmtClock(x)} – ${fmtClock(y)}`, fmtDur(y - x))}${n > 1 ? trow(t('sessions'), n) : ''}`);
        return;
      }
      hideTip();
    });
    root.addEventListener('mouseleave', hideTip);
  }

  window.StatsView = {
    mount,
    async show(l, names, color) {
      lang = l === 'zh' ? 'zh' : 'en';
      state.names = names || state.names;
      if (color) colorFn = color;
      render();
      await load();
      clearInterval(timer);
      timer = setInterval(render, 60000); // keeps "x min ago" fresh
    },
    hide() {
      clearInterval(timer);
      timer = null;
      hideTip();
    },
    refresh: () => load(),
    setLang(l) {
      lang = l === 'zh' ? 'zh' : 'en';
      render();
    },
  };
})();
