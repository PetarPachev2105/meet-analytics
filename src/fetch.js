import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_SIZE = 100;

/** Follows nextPageToken until the list is exhausted. */
export async function listAll(call, params, field) {
  const items = [];
  let pageToken;
  do {
    const { data } = await call({ ...params, pageSize: PAGE_SIZE, pageToken });
    items.push(...(data[field] ?? []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return items;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** "https://meet.google.com/abc-defg-hij?authuser=0" -> "abc-defg-hij" */
export function parseMeetingCode(input) {
  const m = String(input).match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
  return m ? m[0].toLowerCase() : null;
}

export function buildFilter({ code, since, until }) {
  const parts = [];
  if (code) parts.push(`space.meeting_code = "${code}"`);
  if (since) parts.push(`start_time>="${since.toISOString()}"`);
  if (until) parts.push(`start_time<="${until.toISOString()}"`);
  return parts.join(' AND ');
}

export async function findConferenceRecords(meet, { code, since, until }) {
  const filter = buildFilter({ code, since, until });
  const records = await listAll(
    (p) => meet.conferenceRecords.list(p),
    filter ? { filter } : {},
    'conferenceRecords',
  );
  return records.map((record) => ({ record, meetingCode: code ?? null }));
}

/** Resolves the meeting code of a space when the record was found without one. */
export async function resolveMeetingCode(meet, spaceName, cache) {
  if (cache.has(spaceName)) return cache.get(spaceName);
  let code = null;
  try {
    const { data } = await meet.spaces.get({ name: spaceName });
    code = data.meetingCode ?? null;
  } catch {
    // not allowed to read the space (e.g. not the owner) - keep null
  }
  cache.set(spaceName, code);
  return code;
}

/**
 * Pulls everything needed for analytics for one conference record:
 * participants, their sessions, and transcript entries (if a transcript exists).
 */
export async function fetchConference(meet, { record, meetingCode }, { log = () => {} } = {}) {
  const participants = await listAll(
    (p) => meet.conferenceRecords.participants.list(p),
    { parent: record.name },
    'participants',
  );

  await mapLimit(participants, 5, async (p) => {
    p.sessions = await listAll(
      (q) => meet.conferenceRecords.participants.participantSessions.list(q),
      { parent: p.name },
      'participantSessions',
    );
  });

  const transcriptEntries = [];
  try {
    const transcripts = await listAll(
      (p) => meet.conferenceRecords.transcripts.list(p),
      { parent: record.name },
      'transcripts',
    );
    for (const t of transcripts) {
      const entries = await listAll(
        (p) => meet.conferenceRecords.transcripts.entries.list(p),
        { parent: t.name },
        'transcriptEntries',
      );
      transcriptEntries.push(...entries);
    }
  } catch (err) {
    log(`   транскрипт: недостъпен (${err.message})`);
  }

  return {
    meetingCode,
    record,
    participants,
    transcriptEntries,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- local history (records are deleted by Google 30 days after the meeting) ----------

const fileNameFor = (recordName) => recordName.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.json';

export async function saveConference(dataDir, conf) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, fileNameFor(conf.record.name)), JSON.stringify(conf, null, 2));
}

export async function loadConferences(dataDir) {
  let files;
  try {
    files = await fs.readdir(dataDir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dataDir, f), 'utf8')));
    } catch {
      // skip unreadable file
    }
  }
  return out;
}
