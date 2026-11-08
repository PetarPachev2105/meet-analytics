#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseMeetingCode,
  findConferenceRecords,
  resolveMeetingCode,
  fetchConference,
  saveConference,
  loadConferences,
} from './src/fetch.js';
import { analyzeConference, findAbsent, summarize, parseSlots, DEFAULT_SLOTS, DEFAULT_TZ } from './src/analyze.js';
import { writeConferenceReport, writeSummary, printConference, printSummary } from './src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
Употреба:
  node meet-analytics.js [код или линк ...] [опции]

Примери:
  node meet-analytics.js abc-defg-hij
  node meet-analytics.js https://meet.google.com/abc-defg-hij --roster roster.txt --threshold 75
  node meet-analytics.js --since 2026-10-01            всички твои срещи от тази дата
  node meet-analytics.js abc-defg-hij --offline        само от локалната история, без API

Опции:
  --since YYYY-MM-DD   само срещи, започнали от тази дата
  --until YYYY-MM-DD   само срещи, започнали до тази дата (включително)
  --roster FILE        списък с очаквани участници (по едно име на ред) -> показва отсъстващите
  --threshold N        маркира присъствие под N%
  --slots СЛОТОВЕ      твърди часове на срещите (по подразбиране ${DEFAULT_SLOTS});
                       всяка среща се мери спрямо слота, с който се припокрива; "none" = по записа
  --tz ЗОНА            часова зона на слотовете (по подразбиране ${DEFAULT_TZ})
  --offline            не вика API-то, ползва само записаните данни в ./data
  --out DIR            папка за отчетите (по подразбиране ./reports)
  --data DIR           папка за историята (по подразбиране ./data)
  -h, --help
`;

function parseLocalDate(s, endOfDay = false) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Невалидна дата "${s}", очаквам YYYY-MM-DD`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

async function readRoster(file) {
  if (!file) return [];
  const text = await fs.readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const log = (...a) => console.error(...a);

/**
 * Main flow. `meet` can be injected (tests); otherwise a real client is created lazily.
 */
export async function run(argv, { meet, baseDir = process.cwd(), now = Date.now() } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      roster: { type: 'string' },
      threshold: { type: 'string' },
      slots: { type: 'string' },
      tz: { type: 'string' },
      offline: { type: 'boolean', default: false },
      out: { type: 'string' },
      data: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const codes = positionals.map((p) => {
    const code = parseMeetingCode(p);
    if (!code) throw new Error(`"${p}" не прилича на Meet код (abc-defg-hij) или линк`);
    return code;
  });
  const since = parseLocalDate(values.since);
  const until = parseLocalDate(values.until, true);
  const threshold = values.threshold != null ? Number(values.threshold) : null;
  if (threshold != null && Number.isNaN(threshold)) throw new Error('--threshold трябва да е число');
  const roster = await readRoster(values.roster);
  const slots = parseSlots(values.slots ?? DEFAULT_SLOTS);
  const tz = values.tz ?? DEFAULT_TZ;
  const outDir = path.resolve(baseDir, values.out ?? 'reports');
  const dataDir = path.resolve(baseDir, values.data ?? 'data');

  // 1) Fetch from the API and store locally (Google deletes records 30 days after the meeting).
  if (!values.offline) {
    if (!meet) {
      const { google } = await import('googleapis');
      const { getAuth } = await import('./src/auth.js');
      meet = google.meet({ version: 'v2', auth: await getAuth(baseDir) });
    }
    const queries = codes.length ? codes.map((code) => ({ code })) : [{ code: null }];
    const spaceCodes = new Map();
    for (const q of queries) {
      const found = await findConferenceRecords(meet, { ...q, since, until });
      log(`${q.code ?? 'всички срещи'}: ${found.length} запис(а)`);
      for (const item of found) {
        if (!item.meetingCode && item.record.space) {
          item.meetingCode = await resolveMeetingCode(meet, item.record.space, spaceCodes);
        }
        log(` ↓ ${item.meetingCode ?? item.record.name} от ${item.record.startTime}`);
        const conf = await fetchConference(meet, item, { log });
        await saveConference(dataDir, conf);
      }
    }
  }

  // 2) Build reports from the full local history that matches the query.
  const all = await loadConferences(dataDir);
  const selected = all
    .filter((c) => !codes.length || codes.includes(c.meetingCode))
    .filter((c) => !since || Date.parse(c.record.startTime) >= since.getTime())
    .filter((c) => !until || Date.parse(c.record.startTime) <= until.getTime())
    .sort((a, b) => Date.parse(a.record.startTime) - Date.parse(b.record.startTime));

  if (!selected.length) {
    log('\nНяма намерени срещи. Провери кода, периода и дали акаунтът ти е бил в срещата.');
    return { analyses: [], summary: [] };
  }

  const analyses = [];
  const bases = [];
  for (const conf of selected) {
    const a = analyzeConference(conf, { now, threshold, slots, tz });
    const absent = findAbsent(a, roster);
    printConference(a, { absent });
    bases.push(await writeConferenceReport(outDir, a, { absent, threshold }));
    analyses.push(a);
  }

  let summary = [];
  if (analyses.length > 1) {
    summary = summarize(analyses, { roster, threshold });
    printSummary(summary, analyses.length);
    await writeSummary(outDir, analyses, summary, threshold, bases);
  }

  log(`\nОтчетите са в ${outDir}`);
  return { analyses, summary };
}

// ---------- CLI entry ----------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  run(process.argv.slice(2), { baseDir: HERE }).catch(async (err) => {
    const msg = String(err?.response?.data?.error?.message ?? err?.message ?? err);
    if (/invalid_grant/i.test(msg)) {
      const { forgetToken } = await import('./src/auth.js');
      await forgetToken(HERE);
      log('Токенът е изтекъл или е отменен (в Testing режим живее 7 дни). Изтрих token.json — пусни скрипта пак.');
    } else if (err?.code === 403 || /permission/i.test(msg)) {
      log(`Нямаш достъп: ${msg}\nПровери, че Meet REST API е включено в проекта и че си бил участник в срещата с този акаунт.`);
    } else {
      log(msg);
    }
    process.exitCode = 1;
  });
}
