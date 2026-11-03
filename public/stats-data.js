/**
 * The numbers behind the statistics page. Pure functions on submissions
 * ({ id, createdAt, completedAt, answers }, oldest first), so they are easy to test.
 * Day and hour boundaries are in the viewer's local time.
 */

const HOUR = 3600 * 1000;
const MAX_DAYS = 60;
const time = (value) => new Date(value).getTime();

/** Narrows the submissions to what the filters on the page select. */
export function filterSubmissions(subs, { completedOnly = false, age = '', gender = '' } = {}) {
  return subs.filter(
    (s) => (!completedOnly || s.completedAt) && (!age || s.answers.age_group === age) && (!gender || s.answers.gender === gender),
  );
}

export function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** How many came in, how many finished, and how recently. */
export function overview(subs, now = new Date()) {
  const finished = subs.filter((s) => s.completedAt);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const durations = finished.map((s) => time(s.completedAt) - time(s.createdAt)).filter((ms) => ms >= 0);
  const lastFinished = finished.length ? Math.max(...finished.map((s) => time(s.completedAt))) : null;
  return {
    started: subs.length,
    completed: finished.length,
    unfinished: subs.length - finished.length,
    completionRate: subs.length ? finished.length / subs.length : null,
    completedToday: finished.filter((s) => time(s.completedAt) >= startOfToday.getTime()).length,
    completedLastHour: finished.filter((s) => time(s.completedAt) > now.getTime() - HOUR).length,
    medianDurationMs: median(durations),
    lastFinishedAt: lastFinished === null ? null : new Date(lastFinished),
  };
}

/**
 * Started and finished submissions per hour (when everything is within the last two days)
 * or per day. Always at least 12 hours or 7 days, so a quiet start does not look empty.
 */
export function timeline(subs, now = new Date()) {
  if (!subs.length) return { unit: 'hour', buckets: [] };
  const first = Math.min(...subs.map((s) => time(s.createdAt)));
  const unit = now.getTime() - first > 48 * HOUR ? 'day' : 'hour';

  const floor = (ms) => {
    const d = new Date(ms);
    if (unit === 'hour') d.setMinutes(0, 0, 0);
    else d.setHours(0, 0, 0, 0);
    return d;
  };
  const next = (d) => {
    if (unit === 'hour') return new Date(d.getTime() + HOUR);
    const n = new Date(d);
    n.setDate(n.getDate() + 1);
    return n;
  };

  const last = floor(now.getTime());
  const minBuckets = unit === 'hour' ? 12 : 7;
  let start = floor(first);
  const buckets = [];
  for (let d = start; d <= last; d = next(d)) buckets.push({ start: d, started: 0, completed: 0 });
  while (buckets.length < minBuckets) {
    const earlier = new Date(buckets[0].start);
    if (unit === 'hour') earlier.setTime(earlier.getTime() - HOUR);
    else earlier.setDate(earlier.getDate() - 1);
    buckets.unshift({ start: earlier, started: 0, completed: 0 });
  }
  if (unit === 'day' && buckets.length > MAX_DAYS) buckets.splice(0, buckets.length - MAX_DAYS);

  const place = (ms, field) => {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (ms >= buckets[i].start.getTime()) {
        buckets[i][field]++;
        return;
      }
    }
  };
  for (const s of subs) {
    place(time(s.createdAt), 'started');
    if (s.completedAt) place(time(s.completedAt), 'completed');
  }
  return { unit, buckets };
}

/** For the unfinished submissions: the last question each one answered, i.e. where people stop. */
export function dropOff(config, subs) {
  const questions = config.questions.filter((q) => !q.inline); // a write-in box belongs to its question
  const unfinished = subs.filter((s) => !s.completedAt);
  const counts = new Map(questions.map((q) => [q.id, 0]));
  let none = 0;
  for (const s of unfinished) {
    const lastAnswered = questions.filter((q) => s.answers[q.id] !== undefined).at(-1);
    if (lastAnswered) counts.set(lastAnswered.id, counts.get(lastAnswered.id) + 1);
    else none++;
  }
  return {
    total: unfinished.length,
    none,
    rows: questions.filter((q) => counts.get(q.id) > 0).map((q) => ({ id: q.id, title: q.title, count: counts.get(q.id) })),
  };
}

/** "45 s", "2 min 05 s", "1 h 05 min" */
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "tikko", "pirms 5 min", "pirms 3 h", "pirms 2 d" */
export function formatAgo(date, now = new Date()) {
  if (!date) return '—';
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'tikko';
  if (minutes < 60) return `pirms ${minutes} min`;
  if (minutes < 60 * 24) return `pirms ${Math.floor(minutes / 60)} h`;
  return `pirms ${Math.floor(minutes / (60 * 24))} d`;
}
