// Self-contained HTML reports: one page per meeting with everything in it, plus an index over many meetings.
// The data is embedded as JSON and rendered in the browser, so the file works offline and needs no libraries.

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:light;
  --surface:#fcfcfb;--panel:#ffffff;--line:#e6e5e0;--grid:#efeee9;
  --text:#0b0b0b;--text2:#52514e;--muted:#7a7974;
  --present:#2a78d6;--present-soft:#b7d3f6;--talk:#eb6834;--absent:#f1f0ec;
  --warn:#c98500;--bad:#e34948;--good:#008300}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
  --surface:#1a1a19;--panel:#222221;--line:#34332f;--grid:#2a2a28;
  --text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;
  --present:#3987e5;--present-soft:#184f95;--talk:#d95926;--absent:#262624;
  --warn:#eda100;--bad:#e66767;--good:#1baf7a}}
:root[data-theme="dark"]{color-scheme:dark;
  --surface:#1a1a19;--panel:#222221;--line:#34332f;--grid:#2a2a28;
  --text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;
  --present:#3987e5;--present-soft:#184f95;--talk:#d95926;--absent:#262624;
  --warn:#eda100;--bad:#e66767;--good:#1baf7a}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:40px 0 12px}
.sub{color:var(--text2)}.muted{color:var(--muted)}
nav{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line);padding:8px 0;margin:16px 0 0;display:flex;gap:16px;flex-wrap:wrap;font-size:13px}
nav a{color:var(--text2);text-decoration:none}nav a:hover{color:var(--text)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.tile .l{color:var(--text2);font-size:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
.note{border-left:3px solid var(--present);padding:6px 12px;margin-top:16px;color:var(--text2);background:var(--panel)}
/* gantt */
.g{--name:200px}
.g-row{display:flex;align-items:center;height:24px}
.g-name{width:var(--name);flex:none;padding-right:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.g-name small{color:var(--muted)}
.g-track{position:relative;flex:1;height:100%;border-bottom:1px solid var(--grid)}
.g-track i{position:absolute;display:block}
.g-stay{top:5px;height:14px;background:var(--present-soft);border-radius:4px}
.g-dev{top:19px;height:2px;background:var(--present);opacity:.6}
.g-talk{top:8px;height:8px;background:var(--talk);border-radius:1px;min-width:2px}
.g-axis{position:relative;height:20px;margin-left:var(--name);color:var(--muted);font-size:11px}
.g-axis span{position:absolute;transform:translateX(-50%)}
.g-vline{position:absolute;top:0;bottom:0;border-left:1px dashed var(--line);pointer-events:none}
.g-head{position:relative;height:60px;margin-left:var(--name);border-bottom:1px solid var(--line)}
.g-head svg{position:absolute;inset:0;width:100%;height:100%}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--text2);font-size:12px;margin-top:10px}
.legend b{display:inline-block;width:14px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
/* tables */
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--grid);text-align:left;white-space:nowrap}
th{position:sticky;top:0;background:var(--panel);color:var(--text2);font-weight:600;cursor:pointer;user-select:none}
th[data-dir="asc"]::after{content:" ▲"}th[data-dir="desc"]::after{content:" ▼"}
td.n{text-align:right}tr:hover td{background:var(--grid)}
td.wrapcell{white-space:normal;min-width:240px}
.pct{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.pct span{display:inline-block;width:60px;height:6px;background:var(--grid);border-radius:3px;overflow:hidden}
.pct span i{display:block;height:100%;background:var(--present);border-radius:3px}
.flag{color:var(--bad)}
/* bars */
.bars .row{display:grid;grid-template-columns:200px 1fr 140px;align-items:center;gap:10px;height:24px}
.bars .bar{height:12px;background:var(--talk);border-radius:0 4px 4px 0;min-width:1px}
.bars .val{color:var(--text2);font-size:12px;font-variant-numeric:tabular-nums}
.bars .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
/* heatmap */
.hm{display:grid;gap:1px 0;font-size:12px}
.hm .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px}
.hm .cells{display:grid;gap:0 1px;height:14px}
.hm .cells i{display:block;background:var(--absent)}
.hm .cells i.p{background:var(--present-soft)}.hm .cells i.t{background:var(--talk)}
/* people */
details.person{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
details.person summary{padding:10px 14px;cursor:pointer;display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}
details.person summary b{font-size:14px}
.pbody{padding:0 14px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.pbody h4{margin:8px 0 6px;font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.04em}
.pbody ul{margin:0;padding-left:18px}.pbody li{margin:2px 0}
.utt{max-height:320px;overflow:auto;grid-column:1/-1}
.utt div{padding:3px 0;border-bottom:1px solid var(--grid)}.utt time{color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums}
/* log */
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.filters select,.filters input{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit}
.filters input[type=search]{min-width:220px;flex:1}
.k-join{color:var(--good)}.k-leave{color:var(--bad)}.k-talk{color:var(--talk)}
#tip{position:fixed;z-index:10;pointer-events:none;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font-size:12px;max-width:380px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:none;white-space:pre-line}
@media (max-width:700px){.g{--name:110px}.bars .row{grid-template-columns:110px 1fr 90px}}
@media print{nav,.filters{display:none}details.person{break-inside:avoid}}
`;

const CLIENT = String.raw`
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (s, r = document) => r.querySelector(s);
const fmt = (o) => new Intl.DateTimeFormat('bg-BG', { timeZone: D.tz, ...o });
const fT = (ms) => (ms == null ? '' : fmt({ hour: '2-digit', minute: '2-digit' }).format(ms));
const fS = (ms) => (ms == null ? '' : fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ms));
const fD = (ms) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ms);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const num = (v) => (v == null ? '' : String(v).replace('.', ','));
const dur = (ms) => (ms < 60000 ? Math.round(ms / 1000) + ' сек' : num(Math.round(ms / 6000) / 10) + ' мин');
const span = D.end - D.start || 1;
const X = (t) => Math.max(0, Math.min(100, ((t - D.start) / span) * 100));
const W = (s, e) => Math.max(0, X(e) - X(s));

// ---- tooltip
const tip = $('#tip');
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return (tip.style.display = 'none');
  tip.textContent = el.dataset.tip;
  tip.style.display = 'block';
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
});

// ---- header
$('#title').textContent = (D.meetingCode || 'Среща') + ' · ' + fD(D.start);
$('#sub').textContent =
  (D.fixedSlot ? 'Твърди часове ' + fT(D.start) + '–' + fT(D.end) + ' · запис ' : 'Запис ') +
  fT(D.recordStart) + '–' + fT(D.recordEnd) +
  ' · първо влизане ' + fT(D.firstJoinAny) + ', последно излизане ' + fT(D.lastLeaveAny) +
  (D.active ? ' · срещата е в ход' : '');
const R = D.rows.filter((r) => !r.absent);
const avg = (k) => (R.length ? Math.round((R.reduce((a, r) => a + (r[k] || 0), 0) / R.length) * 10) / 10 : 0);
const tiles = [
  [num(D.durationMin) + ' мин', D.fixedSlot ? 'Продължителност (слот)' : 'Продължителност'],
  [R.length, 'Участници'],
  [D.peak, 'Пик едновременно · ' + fT(D.peakAt)],
  [num(D.avgConcurrent), 'Средно едновременно'],
  [num(avg('pct')) + '%', 'Средно присъствие'],
  [R.filter((r) => r.joinedAfterMin > 5).length, 'Закъснели > 5 мин'],
  [R.filter((r) => r.dropouts > 0).length, 'С прекъсвания'],
];
if (D.hasTranscript) {
  const talkMin = D.rows.reduce((a, r) => a + (r.speakingMin || 0), 0);
  tiles.push([num(Math.round(talkMin * 10) / 10) + ' мин', 'Говорене общо'], [D.speech.length, 'Реплики'],
    [R.filter((r) => !r.utterances).length, 'Не са говорили']);
}
if (D.absent.length) tiles.push([D.absent.length, 'Отсъстват']);
$('#tiles').innerHTML = tiles.map(([v, l]) => '<div class="tile"><div class="v">' + v + '</div><div class="l">' + esc(l) + '</div></div>').join('');
if (D.fixedSlot && (D.recordStart < D.start - 60000 || D.recordEnd > D.end + 60000)) {
  $('#note').innerHTML = '<div class="note">Процентите и закъсненията са спрямо твърдите часове ' + fT(D.start) + '–' + fT(D.end) +
    '. Времето преди и след тях не се брои. В таблицата има и „% запис“ (целия запис ' + fT(D.recordStart) + '–' + fT(D.recordEnd) +
    ') и „% реално“ (от първото до последното влизане).</div>';
}

// ---- gantt
(function gantt() {
  const step = span > 4 * 3600e3 ? 30 : 15;
  const ticks = [];
  for (let t = Math.ceil(D.start / (step * 60e3)) * step * 60e3; t <= D.end; t += step * 60e3) ticks.push(t);
  $('#axis').innerHTML = ticks.map((t) => '<span style="left:' + X(t) + '%">' + fT(t) + '</span>').join('');
  const maxC = Math.max(1, ...D.timeline.map((p) => p.count));
  const pts = D.timeline.map((p) => X(p.t).toFixed(2) + ',' + (60 - (p.count / maxC) * 56).toFixed(1));
  $('#head').innerHTML =
    '<svg viewBox="0 0 100 60" preserveAspectRatio="none"><polygon points="0,60 ' + pts.join(' ') + ' 100,60" fill="var(--present-soft)"/>' +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--present)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>' +
    D.timeline.map((p) => '<i style="position:absolute;top:0;bottom:0;left:' + X(p.t) + '%;width:' + (100 / D.timeline.length) + '%" data-tip="' +
      esc(fT(p.t) + ' — ' + p.count + ' души' + (p.speakers && p.speakers.length ? '\nговорят: ' + p.speakers.join(', ') : '')) + '"></i>').join('') +
    '<span style="position:absolute;left:4px;top:2px;font-size:11px;color:var(--muted)">брой хора · макс ' + maxC + '</span>';
  const grid = ticks.map((t) => '<div class="g-vline" style="left:' + X(t) + '%"></div>').join('');
  $('#lanes').innerHTML = D.rows.filter((r) => !r.absent).map((r) => {
    const stays = r.stays.map(([s, e]) => '<i class="g-stay" style="left:' + X(s) + '%;width:' + W(s, e) + '%" data-tip="' +
      esc(r.name + '\nв срещата ' + fS(s) + '–' + fS(e) + ' (' + dur(e - s) + ')') + '"></i>').join('');
    const devs = r.deviceSessions.length > r.stays.length ? r.deviceSessions.map(([s, e], i) => '<i class="g-dev" style="left:' + X(s) + '%;width:' + W(s, e) + '%;top:' + (19 + (i % 2) * 2) + 'px" data-tip="' +
      esc(r.name + '\nсесия ' + (i + 1) + ': ' + fS(s) + '–' + fS(e)) + '"></i>').join('') : '';
    const talk = D.speech.filter((u) => u.key === r.key).map((u) => '<i class="g-talk" style="left:' + X(u.start) + '%;width:' + W(u.start, u.end) + '%" data-tip="' +
      esc(r.name + ' · ' + fS(u.start) + ' · ' + dur(u.end - u.start) + '\n' + u.text) + '"></i>').join('');
    return '<div class="g-row"><div class="g-name" title="' + esc(r.name) + '">' + esc(r.name) + ' <small>' + num(r.pct) + '%</small></div><div class="g-track">' + grid + stays + devs + talk + '</div></div>';
  }).join('');
})();

// ---- people table
const COLS = [
  ['Име', (r) => r.name, 's'],
  ['Тип', (r) => r.type, 's'],
  [D.fixedSlot ? '% слот' : '%', (r) => r.pct, 'p'],
  ['% запис', (r) => r.pctRecord, 'p'],
  ['% реално', (r) => r.pctOfLive, 'p'],
  ['Мин', (r) => r.minutes, 'n'],
  ['Влязъл', (r) => r.firstJoin, 't'],
  ['Излязъл', (r) => r.lastLeave, 't'],
  ['Закъснял мин', (r) => r.joinedAfterMin, 'n'],
  ['Излязъл рано мин', (r) => r.leftBeforeEndMin, 'n'],
  ['Сесии', (r) => r.sessions, 'n'],
  ['Прекъсв.', (r) => r.dropouts, 'n'],
  ['Извън срещата', (r) => r.gaps && r.gaps.length ? r.gaps.map(([s, e]) => fT(s) + ' (' + dur(e - s) + ')').join(', ') : '', 's'],
  ['Най-дълъг престой мин', (r) => r.longestStretchMin, 'n'],
];
if (D.hasTranscript) COLS.push(
  ['Говорил мин', (r) => r.speakingMin, 'n'],
  ['Дял говорене %', (r) => r.speakingSharePct, 'n'],
  ['Реплики', (r) => r.utterances, 'n'],
  ['Думи', (r) => r.words, 'n'],
  ['Първа реплика', (r) => r.firstSpokeAt, 't'],
  ['Последна реплика', (r) => r.lastSpokeAt, 't'],
  ['Най-дълга реплика сек', (r) => r.longestUtteranceSec, 'n'],
  ['Ср. думи/реплика', (r) => r.avgWordsPerUtterance, 'n'],
  ['Думи/мин', (r) => r.wordsPerMinute, 'n'],
);
if (D.threshold != null) COLS.push(['Под ' + D.threshold + '%', (r) => (r.belowThreshold ? 'да' : ''), 's']);
function cell([, get, kind], r) {
  const v = get(r);
  if (kind === 'p') return '<td class="n"><div class="pct">' + (v == null ? '' : num(v)) + '<span><i style="width:' + (v || 0) + '%"></i></span></div></td>';
  if (kind === 't') return '<td class="n">' + fS(v) + '</td>';
  if (kind === 'n') return '<td class="n">' + num(v) + '</td>';
  return '<td' + (r.absent && get === COLS[1][1] ? ' class="flag"' : '') + '>' + esc(v) + '</td>';
}
let sortBy = 2, sortDir = 'desc';
function drawTable() {
  const get = COLS[sortBy][1];
  const rows = [...D.rows].sort((a, b) => {
    const x = get(a), y = get(b);
    const c = x == null ? 1 : y == null ? -1 : typeof x === 'string' ? x.localeCompare(y, 'bg') : x - y;
    return sortDir === 'asc' ? c : -c;
  });
  $('#people thead').innerHTML = '<tr>' + COLS.map(([h], i) => '<th data-i="' + i + '"' + (i === sortBy ? ' data-dir="' + sortDir + '"' : '') + '>' + esc(h) + '</th>').join('') + '</tr>';
  $('#people tbody').innerHTML = rows.map((r) => '<tr>' + COLS.map((c) => cell(c, r)).join('') + '</tr>').join('');
}
$('#people thead').addEventListener('click', (e) => {
  const i = Number(e.target.closest('th')?.dataset.i);
  if (Number.isNaN(i)) return;
  sortDir = i === sortBy && sortDir === 'desc' ? 'asc' : 'desc';
  sortBy = i;
  drawTable();
});
drawTable();

// ---- speaking bars
if (D.hasTranscript) {
  const sp = [...R].sort((a, b) => (b.speakingMin || 0) - (a.speakingMin || 0));
  const max = Math.max(1, ...sp.map((r) => r.speakingMin || 0));
  $('#talkbars').innerHTML = sp.map((r) => '<div class="row" data-tip="' + esc(r.name + '\n' + num(r.speakingMin) + ' мин · ' + r.utterances + ' реплики · ' + r.words + ' думи') + '"><div class="nm">' + esc(r.name) +
    '</div><div><div class="bar" style="width:' + ((r.speakingMin || 0) / max) * 100 + '%"></div></div><div class="val">' + num(r.speakingMin) + ' мин · ' + num(r.speakingSharePct) + '%</div></div>').join('');
} else {
  $('#talk').remove();
  document.querySelector('a[href="#talk"]').remove();
}

// ---- heatmap
(function heatmap() {
  const n = D.timeline.length;
  const cols = 'grid-template-columns:repeat(' + n + ',1fr)';
  let html = '';
  for (const r of R) {
    html += '<div class="nm" title="' + esc(r.name) + '">' + esc(r.name) + '</div><div class="cells" style="' + cols + '">';
    for (const p of D.timeline) {
      const here = r.stays.some(([s, e]) => p.t < e && p.t + 60000 > s);
      const talks = (p.speakers || []).includes(r.name);
      html += '<i class="' + (talks ? 't' : here ? 'p' : '') + '" data-tip="' + esc(r.name + ' · ' + fT(p.t) + '\n' + (talks ? 'говори' : here ? 'в срещата' : 'не е в срещата')) + '"></i>';
    }
    html += '</div>';
  }
  const hm = $('#hm');
  hm.style.gridTemplateColumns = 'var(--hmname,200px) 1fr';
  hm.innerHTML = html;
})();

// ---- per person
$('#persons').innerHTML = R.map((r) => {
  const utt = D.speech.filter((u) => u.key === r.key);
  const li = (a) => (a.length ? '<ul>' + a.join('') + '</ul>' : '<div class="muted">—</div>');
  return '<details class="person"><summary><b>' + esc(r.name) + '</b><span>' + num(r.pct) + '%</span><span class="muted">' +
    fT(r.firstJoin) + '–' + fT(r.lastLeave) + (r.dropouts ? ' · ' + r.dropouts + ' прекъсв.' : '') +
    (D.hasTranscript ? ' · говорил ' + num(r.speakingMin) + ' мин' : '') + '</span></summary><div class="pbody">' +
    '<div><h4>Престои</h4>' + li(r.stays.map(([s, e]) => '<li>' + fS(s) + ' – ' + fS(e) + ' <span class="muted">' + dur(e - s) + '</span></li>')) + '</div>' +
    '<div><h4>Извън срещата</h4>' + li(r.gaps.map(([s, e]) => '<li>' + fS(s) + ' – ' + fS(e) + ' <span class="muted">' + dur(e - s) + '</span></li>')) + '</div>' +
    '<div><h4>Сесии (устройства / връзки)</h4>' + li(r.deviceSessions.map(([s, e], i) => '<li>' + (i + 1) + '. ' + fS(s) + ' – ' + fS(e) + ' <span class="muted">' + dur(e - s) + '</span></li>')) + '</div>' +
    (D.hasTranscript ? '<div><h4>Говорене</h4><ul><li>' + num(r.speakingMin) + ' мин, ' + num(r.speakingSharePct) + '% от говоренето</li><li>' + r.utterances + ' реплики, ' + r.words + ' думи</li>' +
      (utt.length ? '<li>първа ' + fS(r.firstSpokeAt) + ', последна ' + fS(r.lastSpokeAt) + '</li><li>най-дълга ' + num(r.longestUtteranceSec) + ' сек, ср. ' + num(r.avgWordsPerUtterance) + ' думи, ' + num(r.wordsPerMinute) + ' думи/мин</li>' : '') + '</ul></div>' +
      (utt.length ? '<div class="utt"><h4>Реплики</h4>' + utt.map((u) => '<div><time>' + fS(u.start) + '</time>' + esc(u.text) + '</div>').join('') + '</div>' : '') : '') +
    '</div></details>';
}).join('') + (D.absent.length ? '<p class="flag">Отсъстват: ' + D.absent.map(esc).join(', ') + '</p>' : '');

// ---- event log + transcript
(function log() {
  const sel = $('#f-person');
  sel.innerHTML = '<option value="">Всички</option>' + R.map((r) => '<option>' + esc(r.name) + '</option>').join('');
  const cls = { 'влезе': 'k-join', 'върна се': 'k-join', 'излезе': 'k-leave', 'прекъсна': 'k-leave', 'говори': 'k-talk' };
  function draw() {
    const who = sel.value, kind = $('#f-kind').value, q = $('#f-q').value.trim().toLowerCase();
    const list = D.events.filter((e) => (!who || e.name === who) &&
      (!kind || (kind === 'move' ? e.kind !== 'говори' : e.kind === 'говори')) &&
      (!q || (e.text || '').toLowerCase().includes(q) || e.name.toLowerCase().includes(q)));
    $('#f-count').textContent = list.length + ' събития';
    $('#log tbody').innerHTML = list.map((e) => '<tr><td class="n">' + fS(e.t) + '</td><td>' + esc(e.name) + '</td><td class="' + (cls[e.kind] || '') + '">' + e.kind +
      '</td><td class="n">' + (e.durMin != null ? num(e.durMin) + ' мин' : e.durSec != null ? num(e.durSec) + ' сек' : '') + '</td><td class="wrapcell">' + esc(e.text || '') + '</td></tr>').join('');
  }
  for (const id of ['#f-person', '#f-kind']) $(id).addEventListener('change', draw);
  $('#f-q').addEventListener('input', draw);
  if (!D.hasTranscript) $('#f-kind').value = 'move';
  draw();
})();
`;

/** One page with everything about one meeting. */
export function renderMeetingHtml(a, { absent = [], threshold = null, tz } = {}) {
  const data = {
    ...a,
    tz: tz ?? a.tz,
    threshold,
    absent,
    rows: [
      ...a.rows,
      ...absent.map((name) => ({ name, type: 'отсъства', absent: true, pct: 0, pctRecord: 0, pctOfLive: 0, minutes: 0, stays: [], gaps: [], deviceSessions: [] })),
    ],
  };
  return `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meet ${esc(a.meetingCode ?? '')} отчет</title>
<style>${STYLE}</style></head><body>
<main>
<h1 id="title"></h1><div class="sub" id="sub"></div>
<nav><a href="#summary">Обобщение</a><a href="#timeline">Времева линия</a><a href="#table">Таблица</a><a href="#talk">Говорене</a><a href="#minutes">Минута по минута</a><a href="#people-detail">По човек</a><a href="#events">Хронология и транскрипт</a></nav>
<section id="summary"><div class="tiles" id="tiles"></div><div id="note"></div></section>

<section id="timeline"><h2>Времева линия</h2>
<div class="card g"><div class="g-head" id="head"></div><div class="g-axis" id="axis"></div><div id="lanes"></div>
<div class="legend"><span><b style="background:var(--present-soft)"></b>в срещата</span><span><b style="background:var(--talk)"></b>говори</span><span><b style="background:var(--present);height:3px"></b>отделни сесии, когато са повече от една</span><span class="muted">задръж мишката за подробности</span></div></div></section>

<section id="table"><h2>Всички показатели</h2><p class="muted">Кликни заглавие на колона, за да сортираш.</p>
<div class="wrap"><table id="people"><thead></thead><tbody></tbody></table></div></section>

<section id="talk"><h2>Кой колко е говорил</h2><div class="card bars" id="talkbars"></div></section>

<section id="minutes"><h2>Минута по минута</h2>
<div class="card" style="overflow-x:auto"><div class="hm" id="hm" style="min-width:700px"></div>
<div class="legend"><span><b style="background:var(--present-soft)"></b>в срещата</span><span><b style="background:var(--talk)"></b>говори в тази минута</span><span><b style="background:var(--absent);outline:1px solid var(--line)"></b>не е в срещата</span></div></div></section>

<section id="people-detail"><h2>По човек</h2><div id="persons"></div></section>

<section id="events"><h2>Хронология и транскрипт</h2>
<div class="filters"><select id="f-person" aria-label="Човек"></select>
<select id="f-kind" aria-label="Вид"><option value="">Всичко</option><option value="move">Влизания и излизания</option><option value="talk">Само реплики</option></select>
<input type="search" id="f-q" placeholder="Търси в текста…"><span class="muted" id="f-count"></span></div>
<div class="wrap" style="max-height:640px;overflow:auto"><table id="log"><thead><tr><th>Час</th><th>Име</th><th>Събитие</th><th>Продълж.</th><th>Текст</th></tr></thead><tbody></tbody></table></div></section>
</main>
<div id="tip"></div>
<script type="application/json" id="data">${json(data)}</script>
<script>${CLIENT}</script>
</body></html>`;
}

/** Index over several meetings: per-meeting list with links and the cross-meeting summary. */
export function renderSummaryHtml(items, summary, { tz, threshold = null } = {}) {
  const fmt = (o) => new Intl.DateTimeFormat('bg-BG', { timeZone: tz, ...o });
  const fD = (ms) => fmt({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
  const fT = (ms) => fmt({ hour: '2-digit', minute: '2-digit' }).format(ms);
  const n = (v) => (v == null ? '' : String(v).replace('.', ','));
  const meetings = items
    .map(({ a, file }) => `<tr><td><a href="${esc(file)}">${esc(fD(a.start))}</a></td><td>${esc(a.meetingCode ?? '')}</td><td>${a.fixedSlot ? `${fT(a.start)}–${fT(a.end)}` : ''}</td><td>${fT(a.recordStart)}–${fT(a.recordEnd)}</td><td class="n">${n(a.durationMin)}</td><td class="n">${a.participantCount}</td><td class="n">${a.peak}</td><td class="n">${n(a.avgConcurrent)}</td><td>${a.hasTranscript ? 'да' : ''}</td></tr>`)
    .join('');
  const people = summary
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td class="n">${r.attended}/${r.meetings}</td><td class="n">${n(r.avgPctOverall)}</td><td class="n">${n(r.avgPctWhenPresent)}</td><td class="n">${n(r.totalMinutes)}</td><td class="n">${n(r.avgJoinedAfterMin)}</td><td class="n">${r.totalDropouts}</td><td class="n">${n(r.speakingMin)}</td>${threshold != null ? `<td class="n">${r.belowThreshold}</td>` : ''}</tr>`)
    .join('');
  return `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meet обобщение</title><style>${STYLE}</style></head><body><main>
<h1>Обобщение за ${items.length} срещи</h1>
<h2>Срещи</h2><div class="wrap"><table><thead><tr><th>Начало</th><th>Код</th><th>Твърди часове</th><th>Запис</th><th>Мин</th><th>Хора</th><th>Пик</th><th>Средно</th><th>Транскрипт</th></tr></thead><tbody>${meetings}</tbody></table></div>
<h2>Хора</h2><div class="wrap"><table><thead><tr><th>Име</th><th>Тип</th><th>Присъствал</th><th>Ср. % (всички)</th><th>Ср. % (когато е бил)</th><th>Общо мин</th><th>Ср. закъснение мин</th><th>Прекъсвания</th><th>Говорил мин</th>${threshold != null ? `<th>Под ${threshold}%</th>` : ''}</tr></thead><tbody>${people}</tbody></table></div>
</main></body></html>`;
}
