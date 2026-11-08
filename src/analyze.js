const MIN = 60_000;

// ---------- participants ----------

/** Stable identity across conferences: Google user id for signed-in users, display name otherwise. */
export function participantKey(p) {
  if (p.signedinUser?.user) return p.signedinUser.user;
  if (p.anonymousUser) return `anon:${normalizeName(p.anonymousUser.displayName)}`;
  if (p.phoneUser) return `phone:${normalizeName(p.phoneUser.displayName)}`;
  return p.name;
}

export function participantName(p) {
  return (
    p.signedinUser?.displayName ??
    p.anonymousUser?.displayName ??
    p.phoneUser?.displayName ??
    'Неизвестен'
  );
}

export function participantType(p) {
  if (p.signedinUser) return 'акаунт';
  if (p.anonymousUser) return 'анонимен';
  if (p.phoneUser) return 'телефон';
  return '?';
}

export const normalizeName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// ---------- interval helpers ----------

/** Merges overlapping/touching [start, end] intervals (e.g. laptop + phone at the same time). */
export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const clip = ([s, e], ws, we) => [Math.max(s, ws), Math.min(e, we)];
const sumLen = (intervals) => intervals.reduce((acc, [s, e]) => acc + (e - s), 0);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Peak number of people present at once (sweep line over merged per-person intervals). */
export function peakConcurrency(perPersonIntervals) {
  const events = [];
  for (const intervals of perPersonIntervals) {
    for (const [s, e] of intervals) events.push([s, 1], [e, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // leaves before joins at the same instant
  let cur = 0;
  let peak = 0;
  let peakAt = null;
  for (const [t, d] of events) {
    cur += d;
    if (cur > peak) {
      peak = cur;
      peakAt = t;
    }
  }
  return { peak, peakAt };
}

/** Head count sampled every `stepMin` minutes. */
export function headcountTimeline(perPersonIntervals, start, end, stepMin = 1) {
  const out = [];
  for (let t = start; t <= end; t += stepMin * MIN) {
    let count = 0;
    for (const intervals of perPersonIntervals) {
      if (intervals.some(([s, e]) => t >= s && t < e)) count++;
    }
    out.push({ t, count });
  }
  return out;
}

// ---------- fixed time slots ----------

export const DEFAULT_TZ = 'Europe/Sofia';
export const DEFAULT_SLOTS = '11:00-14:00,18:00-21:00';

/** "11:00-14:00,18:00-21:00" -> [{from:[11,0], to:[14,0]}, ...]; "none" or "" -> [] */
export function parseSlots(str) {
  if (!str || str === 'none') return [];
  return str.split(',').map((part) => {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error(`Невалиден слот "${part}", очаквам ЧЧ:ММ-ЧЧ:ММ`);
    return { from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] };
  });
}

const tzOffset = (ms, tz) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/** UTC ms of a wall-clock time in `tz` on the same local day as `refMs` (DST-safe). */
export function zonedTime(refMs, [h, m], tz = DEFAULT_TZ) {
  const local = new Date(refMs + tzOffset(refMs, tz));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** The slot on the meeting's day that overlaps the record most; null if none overlaps. */
export function pickSlot(recStart, recEnd, slots, tz = DEFAULT_TZ) {
  let best = null;
  for (const slot of slots) {
    const s = zonedTime(recStart, slot.from, tz);
    const e = zonedTime(recStart, slot.to, tz);
    const overlap = Math.min(e, recEnd) - Math.max(s, recStart);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { start: s, end: e, overlap };
  }
  return best;
}

// ---------- per-conference analysis ----------

/**
 * conf = { meetingCode, record, participants: [{...participant, sessions: [...]}], transcriptEntries }
 */
export function analyzeConference(conf, { now = Date.now(), threshold = null, slots = [], tz = DEFAULT_TZ } = {}) {
  const { record } = conf;
  const recordStart = Date.parse(record.startTime);
  const active = !record.endTime;
  const recordEnd = active ? now : Date.parse(record.endTime);
  // With fixed slots the window is the scheduled time, not when the record happened to start/end.
  const slot = pickSlot(recordStart, recordEnd, slots, tz);
  const start = slot ? slot.start : recordStart;
  const end = slot ? (active ? Math.min(now, slot.end) : slot.end) : recordEnd;
  const durationMs = Math.max(end - start, 1);

  // Group participant resources by person (anonymous joins with the same name are merged).
  const people = new Map();
  const resourceToKey = new Map();
  for (const p of conf.participants ?? []) {
    const key = participantKey(p);
    resourceToKey.set(p.name, key);
    if (!people.has(key)) {
      people.set(key, { key, name: participantName(p), type: participantType(p), raw: [] });
    }
    const person = people.get(key);
    const sessions = p.sessions ?? [];
    for (const s of sessions) {
      person.raw.push([Date.parse(s.startTime), s.endTime ? Date.parse(s.endTime) : recordEnd]);
    }
    if (!sessions.length && p.earliestStartTime) {
      person.raw.push([
        Date.parse(p.earliestStartTime),
        p.latestEndTime ? Date.parse(p.latestEndTime) : recordEnd,
      ]);
    }
  }

  // Speaking time from transcript entries.
  const speaking = new Map();
  const speech = [];
  for (const e of conf.transcriptEntries ?? []) {
    const key = resourceToKey.get(e.participant);
    if (!key || !e.startTime || !e.endTime) continue;
    if (Date.parse(e.endTime) <= start || Date.parse(e.startTime) >= end) continue; // outside the window
    const s = speaking.get(key) ?? { ms: 0, utterances: 0, words: 0, list: [] };
    const u = {
      key,
      name: people.get(key).name,
      start: Date.parse(e.startTime),
      end: Date.parse(e.endTime),
      words: String(e.text ?? '').trim().split(/\s+/).filter(Boolean).length,
      text: String(e.text ?? ''),
    };
    s.ms += Math.max(0, u.end - u.start);
    s.utterances += 1;
    s.words += u.words;
    s.list.push(u);
    speech.push(u);
    speaking.set(key, s);
  }
  speech.sort((a, b) => a.start - b.start);
  const totalSpeakingMs = [...speaking.values()].reduce((a, s) => a + s.ms, 0);
  const hasTranscript = speaking.size > 0;

  const perPerson = [];
  const rows = [...people.values()].map((person) => {
    const merged = mergeIntervals(person.raw.map((i) => clip(i, start, end)));
    perPerson.push(merged);
    const presenceMs = sumLen(merged);
    const pct = (presenceMs / durationMs) * 100;
    const sp = speaking.get(person.key);
    const utt = sp?.list ?? [];
    const longestUtt = utt.reduce((m, u) => (u.end - u.start > (m ? m.end - m.start : -1) ? u : m), null);
    return {
      key: person.key,
      name: person.name,
      type: person.type,
      minutes: round1(presenceMs / MIN),
      pct: round1(pct),
      joinedAfterMin: merged.length ? round1((merged[0][0] - start) / MIN) : null,
      leftBeforeEndMin: merged.length ? round1((end - merged.at(-1)[1]) / MIN) : null,
      sessions: person.raw.length,
      dropouts: Math.max(0, merged.length - 1),
      longestStretchMin: round1(Math.max(0, ...merged.map(([s, e]) => e - s)) / MIN),
      speakingMin: hasTranscript ? round1((sp?.ms ?? 0) / MIN) : null,
      speakingSharePct: hasTranscript && totalSpeakingMs ? round1(((sp?.ms ?? 0) / totalSpeakingMs) * 100) : null,
      utterances: hasTranscript ? (sp?.utterances ?? 0) : null,
      words: hasTranscript ? (sp?.words ?? 0) : null,
      belowThreshold: threshold == null ? null : pct < threshold,
      // detail: absolute times
      firstJoin: merged[0]?.[0] ?? null,
      lastLeave: merged.at(-1)?.[1] ?? null,
      stays: merged,
      gaps: merged.slice(1).map(([s], i) => [merged[i][1], s]),
      deviceSessions: person.raw
        .map((i) => clip(i, start, end))
        .filter(([s, e]) => e > s)
        .sort((a, b) => a[0] - b[0]),
      firstSpokeAt: utt.length ? Math.min(...utt.map((u) => u.start)) : null,
      lastSpokeAt: utt.length ? Math.max(...utt.map((u) => u.end)) : null,
      longestUtteranceSec: longestUtt ? round1((longestUtt.end - longestUtt.start) / 1000) : null,
      avgWordsPerUtterance: utt.length ? round1(sp.words / utt.length) : null,
      wordsPerMinute: sp?.ms ? round1(sp.words / (sp.ms / MIN)) : null,
    };
  });
  rows.sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));

  // The record often starts before anyone joins (e.g. the host opened the link early).
  // Also measure against the span between the first join and the last leave.
  const firstJoinAny = rows.length ? Math.min(...rows.filter((r) => r.firstJoin != null).map((r) => r.firstJoin)) : null;
  const lastLeaveAny = rows.length ? Math.max(...rows.filter((r) => r.lastLeave != null).map((r) => r.lastLeave)) : null;
  const liveMs = Number.isFinite(firstJoinAny) && lastLeaveAny > firstJoinAny ? lastLeaveAny - firstJoinAny : durationMs;
  for (const r of rows) r.pctOfLive = round1((sumLen(r.stays) / liveMs) * 100);

  // Keep the percentages over the whole record too, next to the fixed-slot ones.
  const byRecord = slot ? new Map(analyzeConference(conf, { now, threshold }).rows.map((r) => [r.key, r])) : null;
  for (const r of rows) {
    const rr = byRecord?.get(r.key) ?? r;
    r.pctRecord = rr.pct;
    r.minutesRecord = rr.minutes;
  }

  // Chronological log: joins, leaves (merged stays, so a second device does not show as a re-join) and utterances.
  const events = [];
  for (const r of rows) {
    r.stays.forEach(([s, e], i) => {
      events.push({ t: s, name: r.name, kind: i ? 'върна се' : 'влезе' });
      if (e < end || !active) events.push({ t: e, name: r.name, kind: i < r.stays.length - 1 ? 'прекъсна' : 'излезе', durMin: round1((e - s) / MIN) });
    });
  }
  for (const u of speech) events.push({ t: u.start, name: u.name, kind: 'говори', durSec: round1((u.end - u.start) / 1000), words: u.words, text: u.text });
  events.sort((a, b) => a.t - b.t);

  const { peak, peakAt } = peakConcurrency(perPerson);
  const totalPresence = perPerson.reduce((a, iv) => a + sumLen(iv), 0);

  return {
    id: record.name,
    meetingCode: conf.meetingCode ?? null,
    start,
    end,
    tz,
    fixedSlot: !!slot,
    recordStart,
    recordEnd,
    active,
    durationMin: round1(durationMs / MIN),
    participantCount: rows.length,
    peak,
    peakAt,
    avgConcurrent: round1(totalPresence / durationMs),
    hasTranscript,
    firstJoinAny: Number.isFinite(firstJoinAny) ? firstJoinAny : null,
    lastLeaveAny: Number.isFinite(lastLeaveAny) ? lastLeaveAny : null,
    liveMin: round1(liveMs / MIN),
    rows,
    speech,
    events,
    timeline: headcountTimeline(perPerson, start, end).map((p) => ({
      ...p,
      speakers: [...new Set(speech.filter((u) => u.start < p.t + MIN && u.end > p.t).map((u) => u.name))],
    })),
  };
}

// ---------- roster ----------

/** Roster names that do not match any participant's display name. */
export function findAbsent(analysis, rosterNames) {
  const present = new Set(analysis.rows.map((r) => normalizeName(r.name)));
  return rosterNames.filter((n) => !present.has(normalizeName(n)));
}

// ---------- across meetings ----------

export function summarize(analyses, { roster = [], threshold = null } = {}) {
  const n = analyses.length;
  const people = new Map();

  for (const a of analyses) {
    for (const r of a.rows) {
      const p = people.get(r.key) ?? {
        name: r.name,
        type: r.type,
        attended: 0,
        pctSum: 0,
        minutes: 0,
        joinedAfterSum: 0,
        dropouts: 0,
        speakingMin: 0,
        belowThreshold: 0,
      };
      p.attended += 1;
      p.pctSum += r.pct;
      p.minutes += r.minutes;
      p.joinedAfterSum += r.joinedAfterMin ?? 0;
      p.dropouts += r.dropouts;
      p.speakingMin += r.speakingMin ?? 0;
      if (threshold != null && r.pct < threshold) p.belowThreshold += 1;
      people.set(r.key, p);
    }
  }

  // Roster members who never showed up.
  const seenNames = new Set([...people.values()].map((p) => normalizeName(p.name)));
  for (const name of roster) {
    if (!seenNames.has(normalizeName(name))) {
      people.set(`roster:${normalizeName(name)}`, {
        name,
        type: '—',
        attended: 0,
        pctSum: 0,
        minutes: 0,
        joinedAfterSum: 0,
        dropouts: 0,
        speakingMin: 0,
        belowThreshold: 0,
      });
    }
  }

  return [...people.values()]
    .map((p) => ({
      name: p.name,
      type: p.type,
      attended: p.attended,
      missed: n - p.attended,
      meetings: n,
      avgPctWhenPresent: p.attended ? round1(p.pctSum / p.attended) : 0,
      avgPctOverall: round1(p.pctSum / n),
      totalMinutes: round1(p.minutes),
      avgJoinedAfterMin: p.attended ? round1(p.joinedAfterSum / p.attended) : null,
      totalDropouts: p.dropouts,
      speakingMin: round1(p.speakingMin),
      // absences count as below threshold too
      belowThreshold: threshold == null ? null : p.belowThreshold + (n - p.attended),
    }))
    .sort((a, b) => b.avgPctOverall - a.avgPctOverall || a.name.localeCompare(b.name));
}
