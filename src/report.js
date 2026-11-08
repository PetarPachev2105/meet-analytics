import fs from 'node:fs/promises';
import path from 'node:path';

import { renderMeetingHtml, renderSummaryHtml } from './html.js';

const dt = new Intl.DateTimeFormat('bg-BG', { dateStyle: 'short', timeStyle: 'short' });
const tm = new Intl.DateTimeFormat('bg-BG', { timeStyle: 'short' });
const tms = new Intl.DateTimeFormat('bg-BG', { timeStyle: 'medium' });

export const fmtDateTime = (ms) => (ms == null ? '' : dt.format(new Date(ms)));
export const fmtTime = (ms) => (ms == null ? '' : tm.format(new Date(ms)));
export const fmtClock = (ms) => (ms == null ? '' : tms.format(new Date(ms)));
const fmtSpans = (spans) => spans.map(([s, e]) => `${fmtTime(s)}–${fmtTime(e)}`).join('; ');
const minOf = ([s, e]) => Math.round((e - s) / 6000) / 10;
/** Gaps are often a few seconds (reconnect), so show them with seconds and their length. */
const fmtGaps = (gaps) =>
  gaps
    .map(([s, e]) => `${fmtClock(s)}–${fmtClock(e)} (${e - s < 60_000 ? `${Math.round((e - s) / 1000)} сек` : `${minOf([s, e])} мин`})`)
    .join('; ');

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export const csvCell = (v) => {
  if (v == null) return '';
  let s = typeof v === 'boolean' ? (v ? 'да' : 'не') : String(v);
  // Display names are typed by participants: stop "=…", "+…", "-…", "@…" from running as spreadsheet formulas.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** columns: [[header, row => value], ...]. Written with a BOM so Excel reads Cyrillic correctly. */
export async function writeCsv(file, rows, columns) {
  const lines = [columns.map(([h]) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(columns.map(([, get]) => csvCell(get(r))).join(','));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '﻿' + lines.join('\n') + '\n');
}

function attendanceColumns(a, threshold) {
  const cols = [
    ['Име', (r) => r.name],
    ['Тип', (r) => r.type],
    ['Минути', (r) => r.minutes],
    ['% присъствие', (r) => r.pct],
    ['Влязъл след старта (мин)', (r) => r.joinedAfterMin],
    ['Излязъл преди края (мин)', (r) => r.leftBeforeEndMin],
    ['Сесии', (r) => r.sessions],
    ['Прекъсвания', (r) => r.dropouts],
    ['Най-дълъг непрекъснат престой (мин)', (r) => r.longestStretchMin],
    ['% от целия запис', (r) => r.pctRecord],
    ['Минути в целия запис', (r) => r.minutesRecord],
    ['% от първото до последното влизане', (r) => r.pctOfLive],
    ['Първо влизане', (r) => fmtClock(r.firstJoin)],
    ['Последно излизане', (r) => fmtClock(r.lastLeave)],
    ['Престои', (r) => fmtSpans(r.stays ?? [])],
    ['Отсъствал', (r) => fmtGaps(r.gaps ?? [])],
  ];
  if (a.hasTranscript) {
    cols.push(
      ['Говорил (мин)', (r) => r.speakingMin],
      ['Дял от говоренето %', (r) => r.speakingSharePct],
      ['Реплики', (r) => r.utterances],
      ['Думи', (r) => r.words],
      ['Първа реплика', (r) => fmtClock(r.firstSpokeAt)],
      ['Последна реплика', (r) => fmtClock(r.lastSpokeAt)],
      ['Най-дълга реплика (сек)', (r) => r.longestUtteranceSec],
      ['Ср. думи на реплика', (r) => r.avgWordsPerUtterance],
      ['Думи в минута говорене', (r) => r.wordsPerMinute],
    );
  }
  if (threshold != null) cols.push([`Под ${threshold}%`, (r) => r.belowThreshold]);
  return cols;
}

const absentRow = (name, threshold) => ({
  name,
  type: 'отсъства',
  minutes: 0,
  pct: 0,
  sessions: 0,
  dropouts: 0,
  longestStretchMin: 0,
  stays: [],
  gaps: [],
  belowThreshold: threshold == null ? null : true,
});

export async function writeConferenceReport(outDir, a, { absent = [], threshold = null } = {}) {
  const base = path.join(outDir, `${stamp(a.start)}_${a.meetingCode ?? 'meet'}`);
  const rows = [...a.rows, ...absent.map((n) => absentRow(n, threshold))];
  await writeCsv(`${base}_attendance.csv`, rows, attendanceColumns(a, threshold));
  await writeCsv(`${base}_timeline.csv`, a.timeline, [
    ['Час', (r) => fmtTime(r.t)],
    ['Участници', (r) => r.count],
    ...(a.hasTranscript ? [['Говорят', (r) => (r.speakers ?? []).join(', ')]] : []),
  ]);
  await writeDetail(base, a, { absent, threshold });
  return base;
}

/** Per-session, per-utterance, chronological and minute-by-minute files plus an HTML timeline. */
async function writeDetail(base, a, opts) {
  const sessions = a.rows.flatMap((r) =>
    r.deviceSessions.map((iv, i) => ({ name: r.name, n: i + 1, iv })),
  );
  await writeCsv(`${base}_sessions.csv`, sessions, [
    ['Име', (x) => x.name],
    ['№', (x) => x.n],
    ['Влязъл', (x) => fmtClock(x.iv[0])],
    ['Излязъл', (x) => fmtClock(x.iv[1])],
    ['Минути', (x) => minOf(x.iv)],
  ]);

  await writeCsv(`${base}_events.csv`, a.events, [
    ['Час', (e) => fmtClock(e.t)],
    ['Име', (e) => e.name],
    ['Събитие', (e) => e.kind],
    ['Престой (мин)', (e) => e.durMin],
    ['Говорил (сек)', (e) => e.durSec],
    ['Думи', (e) => e.words],
    ['Текст', (e) => e.text],
  ]);

  // One row per minute, one column per person: "" = not there, "•" = present, "говори" = spoke that minute.
  await writeCsv(
    `${base}_matrix.csv`,
    a.timeline,
    [
      ['Час', (p) => fmtTime(p.t)],
      ...a.rows.map((r) => [
        r.name,
        (p) => {
          const here = r.stays.some(([s, e]) => p.t < e && p.t + 60_000 > s);
          if ((p.speakers ?? []).includes(r.name)) return 'говори';
          return here ? '•' : '';
        },
      ]),
    ],
  );

  await fs.writeFile(`${base}_report.html`, renderMeetingHtml(a, opts));
}

export async function writeSummary(outDir, analyses, summary, threshold, bases = []) {
  await writeCsv(path.join(outDir, 'meetings.csv'), analyses, [
    ['Начало', (a) => fmtDateTime(a.start)],
    ['Твърди часове', (a) => a.fixedSlot],
    ['Запис', (a) => `${fmtTime(a.recordStart)}–${fmtTime(a.recordEnd)}`],
    ['Код', (a) => a.meetingCode],
    ['Продължителност (мин)', (a) => a.durationMin],
    ['Участници', (a) => a.participantCount],
    ['Пик едновременно', (a) => a.peak],
    ['Средно едновременно', (a) => a.avgConcurrent],
    ['Транскрипт', (a) => a.hasTranscript],
    ['В ход', (a) => a.active],
  ]);
  const cols = [
    ['Име', (r) => r.name],
    ['Тип', (r) => r.type],
    ['Присъствал (срещи)', (r) => r.attended],
    ['Пропуснал (срещи)', (r) => r.missed],
    ['Ср. % когато е бил', (r) => r.avgPctWhenPresent],
    ['Ср. % от всички срещи', (r) => r.avgPctOverall],
    ['Общо минути', (r) => r.totalMinutes],
    ['Ср. влизане след старта (мин)', (r) => r.avgJoinedAfterMin],
    ['Прекъсвания общо', (r) => r.totalDropouts],
    ['Говорил общо (мин)', (r) => r.speakingMin],
  ];
  if (threshold != null) cols.push([`Срещи под ${threshold}%`, (r) => r.belowThreshold]);
  await writeCsv(path.join(outDir, 'summary.csv'), summary, cols);
  const items = analyses.map((a, i) => ({ a, file: bases[i] ? `${path.basename(bases[i])}_report.html` : '' }));
  await fs.writeFile(path.join(outDir, 'summary.html'), renderSummaryHtml(items, summary, { tz: analyses[0]?.tz, threshold }));
}

// ---------- console ----------

export function printConference(a, { absent = [] } = {}) {
  console.log(
    `\n■ ${a.meetingCode ?? a.id}  ${fmtDateTime(a.start)} – ${fmtTime(a.end)}${a.active ? ' (в ход)' : ''}`,
  );
  console.log(
    `  ${a.durationMin} мин · ${a.participantCount} души · пик ${a.peak} в ${fmtTime(a.peakAt)} · средно ${a.avgConcurrent} едновременно` +
      (a.hasTranscript ? ' · с транскрипт' : ''),
  );
  console.table(
    a.rows.map((r) => ({
      Име: r.name,
      '%': r.pct,
      Мин: r.minutes,
      'Влязъл +мин': r.joinedAfterMin,
      'Излязъл −мин': r.leftBeforeEndMin,
      Прекъсв: r.dropouts,
      ...(a.hasTranscript ? { 'Говорил мин': r.speakingMin, 'Дял %': r.speakingSharePct } : {}),
    })),
  );
  if (absent.length) console.log(`  Отсъстват: ${absent.join(', ')}`);
  if (a.fixedSlot) {
    console.log(`  Мерено по твърди часове ${fmtTime(a.start)}–${fmtTime(a.end)} (записът е ${fmtTime(a.recordStart)}–${fmtTime(a.recordEnd)}).`);
  } else if (a.firstJoinAny && a.firstJoinAny - a.start > 60_000) {
    console.log(
      `  Записът е започнал в ${fmtTime(a.start)}, но първият влиза в ${fmtTime(a.firstJoinAny)} — реалната среща е ${a.liveMin} мин.`,
    );
  }
  console.log('\n  Кой кога:');
  for (const r of a.rows) {
    const talk = r.utterances ? ` · говори ${r.speakingMin} мин (${r.utterances} реплики, първа ${fmtTime(r.firstSpokeAt)})` : '';
    const gaps = r.gaps.length ? ` · извън: ${fmtGaps(r.gaps)}` : '';
    console.log(`  ${r.name.padEnd(28)} ${fmtSpans(r.stays)}${gaps}${talk}`);
  }
}

export function printSummary(summary, n) {
  console.log(`\n■ Обобщение за ${n} срещи`);
  console.table(
    summary.map((r) => ({
      Име: r.name,
      Присъствал: `${r.attended}/${r.meetings}`,
      'Ср. % (всички)': r.avgPctOverall,
      'Ср. % (когато е бил)': r.avgPctWhenPresent,
      'Ср. влизане +мин': r.avgJoinedAfterMin,
      ...(r.belowThreshold != null ? { 'Под прага': r.belowThreshold } : {}),
    })),
  );
}
