// Dashboard: renders /api/stream (Server-Sent Events) or polls /api/state.
// Plain DOM, no framework. All text is set with textContent.

const $ = (id) => document.getElementById(id);

function usd(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
  return '$' + n.toFixed(a < 1 && a > 0 ? 4 : 0);
}
const int = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(0) + '%');
const ms = (x) => (x === null || x === undefined ? '—' : x < 1000 ? Math.round(x) + ' ms' : (x / 1000).toFixed(1) + ' s');
const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '—');
const clock = (t) => new Date(t).toISOString().slice(11, 19) + 'Z';

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function row(cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = el('td', typeof c === 'object' && c !== null ? c.text : c);
    if (typeof c === 'object' && c !== null && c.cls) td.className = c.cls;
    if (typeof c === 'object' && c !== null && c.title) td.title = c.title;
    tr.appendChild(td);
  }
  return tr;
}

function card(k, v, s, bar) {
  const d = el('div', undefined, 'card');
  d.append(el('div', k, 'k'), el('div', v, 'v'));
  if (s) d.append(el('div', s, 's'));
  if (bar !== undefined && bar !== null) {
    const b = el('div', undefined, 'bar');
    const i = el('i');
    i.style.width = (bar * 100).toFixed(1) + '%';
    b.append(i);
    d.append(b);
  }
  return d;
}

function render(s) {
  const mode = $('mode');
  if (s.mode.kind === 'replay') {
    mode.textContent = 'replay · recorded ' + s.mode.recordedAt;
    mode.className = 'badge';
  } else {
    mode.textContent = s.mode.kind + ' · RPC_PROVIDER=' + s.mode.rpcProvider;
    mode.className = 'badge on';
  }

  const m = s.market;
  const held = m.firstEventAt ? s.at - m.firstEventAt : 0;
  $('history').textContent = held && held < 86400000
    ? 'the 24 h window holds ' + (held / 3600000).toFixed(1) + ' h of data so far'
    : '';
  const cards = $('cards');
  cards.replaceChildren(
    card('24 h volume', usd(m.h24.volumeUsd), '1 h ' + usd(m.h1.volumeUsd) + ' · 5 m ' + usd(m.m5.volumeUsd)),
    card('24 h trades', int(m.h24.trades), '1 h ' + int(m.h1.trades) + ' · 5 m ' + int(m.m5.trades)),
    card('24 h unique wallets', '≈ ' + int(m.h24.uniqueWallets), '1 h ' + int(m.h1.uniqueWallets) + ' · 5 m ' + int(m.m5.uniqueWallets) + ' (exact)'),
    card('Buy share of volume, 1 h', pct(m.h1.buyPressure), 'buys ' + usd(m.h1.buyUsd) + ' · sells ' + usd(m.h1.sellUsd), m.h1.buyPressure),
    card('New pools, 24 h', int(m.h24.launches), '1 h ' + int(m.h1.launches) + ' · 5 m ' + int(m.m5.launches)),
    card('Liquidity, 1 h', '+' + usd(m.h1.liqAddUsd), '− ' + usd(m.h1.liqRemoveUsd) + ' removed'),
  );

  const hb = $('health').tBodies[0];
  hb.replaceChildren(...s.health.map((h) => row([
    h.name,
    h.host,
    { text: h.connected ? 'up' : 'down', cls: h.connected ? 'ok' : 'down' },
    h.msgPerSec.toFixed(1),
    ms(h.lastMsgAgeMs),
    int(h.slot),
    h.slotLag === null ? '—' : String(h.slotLag),
    ms(h.behindLeaderP50Ms) + ' / ' + ms(h.behindLeaderP95Ms),
    h.kind === 'rpc' ? ms(h.rpcP50Ms) + ' / ' + ms(h.rpcP95Ms) : '—',
    String(h.reconnects),
    h.kind === 'rpc' ? h.verified + ' · ' + h.verifyMissing + ' · ' + h.verifySlotMismatch : '—',
    { text: h.lastError || '', cls: 'err', title: h.lastError || '' },
  ])));

  const pb = $('pools').tBodies[0];
  pb.replaceChildren(...m.pools.map((p) => row([
    { text: p.symbol || short(p.mint || p.pool), title: p.pool },
    p.dex || '—',
    usd(p.m5.volumeUsd),
    usd(p.h1.volumeUsd),
    usd(p.h24.volumeUsd),
    int(p.h1.trades),
    pct(p.h1.buyPressure),
    int(p.h1.uniqueWallets),
    usd(p.h1.liqAddUsd) + ' / ' + usd(p.h1.liqRemoveUsd),
    usd(p.priceUsd),
  ])));

  const lf = $('launches');
  lf.replaceChildren(...(m.launches.length ? m.launches.map((l) => {
    const li = el('li');
    li.append(el('span', clock(l.blockTime ? l.blockTime * 1000 : l.seenAt), 't'), el('span', (l.symbol || short(l.mint || l.pool)) + ' · ' + (l.dex || '?') + (l.liquidityUsd !== null ? ' · ' + usd(l.liquidityUsd) : '')));
    li.title = l.pool;
    return li;
  }) : [el('li', 'none yet', 'empty')]));

  $('rules').textContent = s.rules.length + ' rules';
  const af = $('alerts');
  af.replaceChildren(...(s.alerts.length ? s.alerts.map((a) => {
    const li = el('li');
    li.append(el('span', clock(a.at), 't'), el('span', a.rule + ' · ' + a.label + ' · ' + a.metric + ' = ' + (Math.round(a.value * 100) / 100) + ' (' + a.threshold + ')'));
    return li;
  }) : [el('li', 'none yet', 'empty')]));

  const f = s.frames;
  const types = Object.entries(f.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(' · ');
  const drift = Object.entries(f.drift).map(([k, v]) => k + ' ' + v).join(' · ');
  $('frames').textContent = 'total ' + f.total + ' · duplicates dropped ' + f.duplicates + '\nby type: ' + (types || '—') + '\nmissing fields: ' + (drift || 'none');
}

function connect() {
  if ('EventSource' in window) {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => render(JSON.parse(ev.data));
    es.onerror = () => { $('mode').textContent = 'reconnecting…'; };
  } else {
    const poll = () => fetch('/api/state').then((r) => r.json()).then(render).finally(() => setTimeout(poll, 1000));
    poll();
  }
}
connect();
