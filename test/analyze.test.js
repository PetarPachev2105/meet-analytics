import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mergeIntervals, analyzeConference, summarize, findAbsent, parseSlots, zonedTime } from '../src/analyze.js';
import { buildFilter, parseMeetingCode } from '../src/fetch.js';
import { csvCell } from '../src/report.js';
import { run } from '../meet-analytics.js';

const T = (hhmm, day = '2026-10-19') => `${day}T${hhmm}:00.000Z`;
const ms = (hhmm, day) => Date.parse(T(hhmm, day));

// ---------- fixtures shaped like Meet REST API responses ----------

const signed = (id, displayName) => ({ signedinUser: { user: `users/${id}`, displayName } });
const sess = (a, b, day) => ({ startTime: T(a, day), ...(b ? { endTime: T(b, day) } : {}) });

function conf1() {
  const rec = 'conferenceRecords/c1';
  return {
    meetingCode: 'abc-defg-hij',
    record: { name: rec, startTime: T('18:00'), endTime: T('19:30'), space: 'spaces/S1' },
    participants: [
      { name: `${rec}/participants/p1`, ...signed(1, 'Анна'), sessions: [sess('18:00', '19:30')] },
      // laptop + phone overlapping -> must not exceed real presence
      { name: `${rec}/participants/p2`, ...signed(2, 'Иван'), sessions: [sess('18:05', '19:30'), sess('18:30', '18:45')] },
      // dropped once for 10 min, left 10 min early
      { name: `${rec}/participants/p3`, ...signed(3, 'Мария'), sessions: [sess('18:00', '18:40'), sess('18:50', '19:20')] },
      // the same anonymous guest re-joining appears as two participant resources
      { name: `${rec}/participants/p4`, anonymousUser: { displayName: 'Гост' }, sessions: [sess('18:10', '18:20')] },
      { name: `${rec}/participants/p5`, anonymousUser: { displayName: ' гост ' }, sessions: [sess('18:25', '18:35')] },
      { name: `${rec}/participants/p6`, phoneUser: { displayName: '+359 88*** 12' }, sessions: [sess('18:00', '18:30')] },
    ],
    transcriptEntries: [
      { participant: `${rec}/participants/p1`, startTime: T('18:01'), endTime: T('18:07'), text: 'Здравейте на всички днес ще говорим' },
      { participant: `${rec}/participants/p1`, startTime: T('18:20'), endTime: T('18:24'), text: 'Въпроси?' },
      { participant: `${rec}/participants/p2`, startTime: T('18:24'), endTime: T('18:29'), text: 'Да имам един въпрос' },
    ],
  };
}

function conf2() {
  const day = '2026-10-26';
  const rec = 'conferenceRecords/c2';
  return {
    meetingCode: 'abc-defg-hij',
    record: { name: rec, startTime: T('18:00', day), space: 'spaces/S1' }, // still running
    participants: [
      { name: `${rec}/participants/p1`, ...signed(1, 'Анна'), sessions: [sess('18:00', null, day)] },
      { name: `${rec}/participants/p3`, ...signed(3, 'Мария'), sessions: [sess('18:10', null, day)] },
    ],
    transcriptEntries: [],
  };
}

const NOW2 = ms('19:00', '2026-10-26');

// ---------- unit tests ----------

test('mergeIntervals merges overlaps and keeps gaps', () => {
  assert.deepEqual(mergeIntervals([[5, 10], [1, 3], [2, 6], [12, 15]]), [[1, 10], [12, 15]]);
  assert.deepEqual(mergeIntervals([[1, 1], [3, 2]]), []);
});

test('parseMeetingCode accepts codes and links', () => {
  assert.equal(parseMeetingCode('https://meet.google.com/ABC-defg-hij?authuser=1'), 'abc-defg-hij');
  assert.equal(parseMeetingCode('nope'), null);
  assert.equal(
    buildFilter({ code: 'abc-defg-hij', since: new Date('2026-10-01T00:00:00Z') }),
    'space.meeting_code = "abc-defg-hij" AND start_time>="2026-10-01T00:00:00.000Z"',
  );
});

test('analyzeConference: attendance, overlaps, dropouts, speaking', () => {
  const a = analyzeConference(conf1(), { threshold: 80 });
  const by = Object.fromEntries(a.rows.map((r) => [r.name, r]));

  assert.equal(a.durationMin, 90);
  assert.equal(a.participantCount, 5); // two anonymous resources merged into one person

  assert.equal(by['Анна'].pct, 100);
  assert.equal(by['Иван'].minutes, 85);
  assert.equal(by['Иван'].pct, 94.4); // overlap did not push it above real time
  assert.equal(by['Иван'].sessions, 2);
  assert.equal(by['Иван'].dropouts, 0);
  assert.equal(by['Иван'].joinedAfterMin, 5);

  assert.equal(by['Мария'].minutes, 70);
  assert.equal(by['Мария'].dropouts, 1);
  assert.equal(by['Мария'].leftBeforeEndMin, 10);
  assert.equal(by['Мария'].longestStretchMin, 40);
  assert.equal(by['Мария'].belowThreshold, true);

  assert.equal(by['Гост'].minutes, 20);
  assert.equal(by['Гост'].type, 'анонимен');

  assert.equal(a.hasTranscript, true);
  assert.equal(by['Анна'].speakingMin, 10);
  assert.equal(by['Анна'].speakingSharePct, 66.7);
  assert.equal(by['Иван'].speakingSharePct, 33.3);
  assert.equal(by['Анна'].utterances, 2);
  assert.equal(by['Иван'].words, 4);
  assert.equal(by['Мария'].speakingMin, 0);

  // 18:10–18:20: Анна, Иван (counted once despite 2 devices later), Мария, Гост, phone -> 5
  assert.equal(a.peak, 5);
  assert.equal(a.timeline[0].count, 3); // 18:00: Анна, Мария, phone
  assert.equal(a.timeline.length, 91);
});

test('analyzeConference: active meeting uses "now" as the end', () => {
  const a = analyzeConference(conf2(), { now: NOW2 });
  assert.equal(a.active, true);
  assert.equal(a.durationMin, 60);
  const maria = a.rows.find((r) => r.name === 'Мария');
  assert.equal(maria.pct, 83.3);
  assert.equal(a.hasTranscript, false);
  assert.equal(maria.speakingMin, null);
});

test('summarize across meetings with roster', () => {
  const analyses = [analyzeConference(conf1()), analyzeConference(conf2(), { now: NOW2 })];
  const roster = ['Анна', 'иван', 'Мария', 'Георги'];
  assert.deepEqual(findAbsent(analyses[1], roster), ['иван', 'Георги']);

  const s = summarize(analyses, { roster, threshold: 80 });
  const by = Object.fromEntries(s.map((r) => [r.name, r]));
  assert.equal(by['Анна'].attended, 2);
  assert.equal(by['Анна'].avgPctOverall, 100);
  assert.equal(by['Иван'].attended, 1);
  assert.equal(by['Иван'].avgPctOverall, 47.2);
  assert.equal(by['Иван'].belowThreshold, 1); // the missed meeting
  assert.equal(by['Мария'].avgPctOverall, 80.6);
  assert.equal(by['Мария'].belowThreshold, 1); // 77.8% in the first one
  assert.equal(by['Георги'].attended, 0);
  assert.equal(by['Георги'].missed, 2);
  assert.equal(by['Георги'].belowThreshold, 2);
});

test('csvCell escapes quotes/commas and neutralises formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('Петров, Иван'), '"Петров, Иван"');
  assert.equal(csvCell(-0), '0');
  assert.equal(csvCell(true), 'да');
  assert.equal(csvCell(null), '');
});

// ---------- end-to-end with a fake API client (incl. pagination) ----------

function fakeMeet(confs) {
  const page = (items, field, pageToken) => {
    const i = Number(pageToken ?? 0);
    const size = 2; // force pagination
    const data = { [field]: items.slice(i, i + size) };
    if (i + size < items.length) data.nextPageToken = String(i + size);
    return { data };
  };
  const byRec = new Map(confs.map((c) => [c.record.name, c]));
  const allParts = confs.flatMap((c) => c.participants);
  const calls = { filters: [] };
  const meet = {
    conferenceRecords: {
      list: async ({ filter, pageToken }) => {
        calls.filters.push(filter);
        const code = filter?.match(/meeting_code = "([^"]+)"/)?.[1];
        const recs = confs.filter((c) => !code || c.meetingCode === code).map((c) => c.record);
        return page(recs, 'conferenceRecords', pageToken);
      },
      participants: {
        list: async ({ parent, pageToken }) =>
          page(
            byRec.get(parent).participants.map(({ sessions, ...p }) => p),
            'participants',
            pageToken,
          ),
        participantSessions: {
          list: async ({ parent, pageToken }) =>
            page(allParts.find((p) => p.name === parent).sessions, 'participantSessions', pageToken),
        },
      },
      transcripts: {
        list: async ({ parent, pageToken }) => {
          const c = byRec.get(parent);
          if (c.record.name === 'conferenceRecords/c2') throw Object.assign(new Error('Permission denied'), { code: 403 });
          return page(c.transcriptEntries.length ? [{ name: `${parent}/transcripts/t1` }] : [], 'transcripts', pageToken);
        },
        entries: {
          list: async ({ parent, pageToken }) =>
            page(byRec.get(parent.split('/transcripts/')[0]).transcriptEntries, 'transcriptEntries', pageToken),
        },
      },
    },
    spaces: { get: async () => ({ data: { meetingCode: 'abc-defg-hij' } }) },
  };
  return { meet, calls };
}

test('run(): fetch -> store -> reports, then offline rebuild', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meet-analytics-'));
  const rosterFile = path.join(dir, 'roster.txt');
  await fs.writeFile(rosterFile, '# списък\nАнна\nИван\nМария\nГеорги\n');
  const { meet, calls } = fakeMeet([conf1(), conf2()]);

  const quiet = { log: console.log, error: console.error, table: console.table };
  console.log = console.error = console.table = () => {};
  let res;
  let offline;
  try {
    res = await run(['https://meet.google.com/abc-defg-hij', '--roster', rosterFile, '--threshold', '80'], {
      meet,
      baseDir: dir,
      now: NOW2,
    });
    offline = await run(['abc-defg-hij', '--offline', '--out', 'reports-offline'], { baseDir: dir, now: NOW2 });
  } finally {
    Object.assign(console, quiet);
  }

  assert.equal(calls.filters[0], 'space.meeting_code = "abc-defg-hij"');
  assert.equal(res.analyses.length, 2);
  assert.equal(res.analyses[0].participantCount, 5); // pagination + session fetch worked
  assert.equal(res.analyses[0].hasTranscript, true);
  assert.equal(res.analyses[1].hasTranscript, false); // 403 on transcripts handled

  assert.equal(offline.analyses.length, 2); // history read back without the API

  // file names carry the local start time, so match by pattern
  const files = (await fs.readdir(path.join(dir, 'reports'))).sort();
  assert.equal(files.length, 15); // 6 per meeting + meetings.csv + summary.csv + summary.html
  assert.ok(files.includes('meetings.csv') && files.includes('summary.csv'));
  const attFiles = files.filter((f) => /^2026-10-\d\d_\d{4}_abc-defg-hij_attendance\.csv$/.test(f));
  assert.equal(attFiles.length, 2);
  const att = await fs.readFile(path.join(dir, 'reports', attFiles[0]), 'utf8');
  assert.ok(att.startsWith('﻿'));
  assert.match(att, /Георги,отсъства,0,0/);
  assert.match(att, /\n'\+359 88\*\*\* 12,телефон,/); // formula-safe
  assert.match(att, /Мария,акаунт,70,77\.8,0,10,2,1,40,77\.8,/);
  for (const kind of ['sessions', 'events', 'matrix']) {
    assert.equal(files.filter((f) => f.endsWith(`_${kind}.csv`)).length, 2);
  }
  assert.equal(files.filter((f) => f.endsWith('_report.html')).length, 2);
});

test('analyzeConference: per-person detail and event log', () => {
  const a = analyzeConference(conf1());
  const by = Object.fromEntries(a.rows.map((r) => [r.name, r]));

  assert.deepEqual(by['Мария'].stays, [[ms('18:00'), ms('18:40')], [ms('18:50'), ms('19:20')]]);
  assert.deepEqual(by['Мария'].gaps, [[ms('18:40'), ms('18:50')]]);
  assert.equal(by['Иван'].deviceSessions.length, 2); // both devices listed...
  assert.equal(by['Иван'].stays.length, 1); // ...but one continuous stay
  assert.equal(by['Анна'].firstSpokeAt, ms('18:01'));
  assert.equal(by['Анна'].lastSpokeAt, ms('18:24'));
  assert.equal(by['Анна'].longestUtteranceSec, 360);

  const maria = a.events.filter((e) => e.name === 'Мария').map((e) => e.kind);
  assert.deepEqual(maria, ['влезе', 'прекъсна', 'върна се', 'излезе']);
  assert.equal(a.events.filter((e) => e.kind === 'говори').length, 3);
  assert.deepEqual(a.timeline.find((p) => p.t === ms('18:24')).speakers, ['Иван']);
  assert.ok(a.events.every((e, i) => !i || a.events[i - 1].t <= e.t));
});

test('zonedTime: Sofia wall clock across the DST switch', () => {
  // 25.10.2026 is the switch day: from 04:00 local Sofia is UTC+2
  assert.equal(zonedTime(Date.parse('2026-10-25T08:45:00Z'), [11, 0]), Date.parse('2026-10-25T09:00:00Z'));
  assert.equal(zonedTime(Date.parse('2026-07-01T10:00:00Z'), [18, 0]), Date.parse('2026-07-01T15:00:00Z'));
  assert.throws(() => parseSlots('11-14'));
});

test('analyzeConference: fixed slot replaces the record window', () => {
  const day = '2026-11-03'; // UTC+2, so 11:00-14:00 Sofia = 09:00-12:00Z
  const rec = 'conferenceRecords/s1';
  const conf = {
    meetingCode: 'abc-defg-hij',
    record: { name: rec, startTime: T('08:45', day), endTime: T('12:15', day) },
    participants: [
      { name: `${rec}/participants/p1`, ...signed(1, 'Анна'), sessions: [sess('08:50', '12:10', day)] },
      { name: `${rec}/participants/p2`, ...signed(2, 'Иван'), sessions: [sess('09:30', '11:00', day)] },
    ],
    transcriptEntries: [
      { participant: `${rec}/participants/p1`, startTime: T('08:55', day), endTime: T('08:58', day), text: 'преди старта' },
      { participant: `${rec}/participants/p1`, startTime: T('09:10', day), endTime: T('09:12', day), text: 'начало' },
    ],
  };
  const a = analyzeConference(conf, { slots: parseSlots('11:00-14:00,18:00-21:00') });
  const by = Object.fromEntries(a.rows.map((r) => [r.name, r]));

  assert.equal(a.fixedSlot, true);
  assert.equal(a.start, ms('09:00', day));
  assert.equal(a.end, ms('12:00', day));
  assert.equal(a.durationMin, 180);
  assert.equal(by['Анна'].pct, 100); // time outside the slot is not counted
  assert.equal(by['Иван'].pct, 50);
  assert.equal(by['Иван'].joinedAfterMin, 30);
  assert.equal(by['Иван'].leftBeforeEndMin, 60);
  assert.equal(by['Анна'].utterances, 1); // talk before the slot is ignored

  // no slot overlaps -> falls back to the record
  const b = analyzeConference(conf, { slots: parseSlots('18:00-21:00') });
  assert.equal(b.fixedSlot, false);
  assert.equal(b.start, ms('08:45', day));
});
