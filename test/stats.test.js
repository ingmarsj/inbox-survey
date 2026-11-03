import test from 'node:test';
import assert from 'node:assert/strict';
import { dropOff, filterSubmissions, formatAgo, formatDuration, median, overview, timeline } from '../public/stats-data.js';
import { config } from './helpers.js';

// Local-time dates, so the tests do not depend on the machine's time zone.
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const sub = (id, created, completed, answers = {}) => ({ id, createdAt: created, completedAt: completed ?? null, answers });
const NOW = new Date(2026, 10, 3, 15, 30);

const subs = [
  sub('a', at(3, 9, 0), at(3, 9, 4), { age_group: '25_34', gender: 'female' }),
  sub('b', at(3, 10, 0), at(3, 10, 2), { age_group: '35_44', gender: 'male' }),
  sub('c', at(3, 14, 55), null, { age_group: '25_34', gender: 'male', years_using: '2' }),
  sub('d', at(3, 15, 10), at(3, 15, 20), { age_group: '25_34', gender: 'female' }),
  sub('e', at(3, 15, 25), null, {}),
  sub('f', at(2, 23, 30), at(2, 23, 40), { gender: 'female' }),
];

test('filters narrow by completion, age and gender, and combine', () => {
  assert.equal(filterSubmissions(subs).length, 6);
  assert.deepEqual(filterSubmissions(subs, { completedOnly: true }).map((s) => s.id), ['a', 'b', 'd', 'f']);
  assert.deepEqual(filterSubmissions(subs, { age: '25_34' }).map((s) => s.id), ['a', 'c', 'd']);
  assert.deepEqual(filterSubmissions(subs, { gender: 'male' }).map((s) => s.id), ['b', 'c']);
  assert.deepEqual(filterSubmissions(subs, { completedOnly: true, age: '25_34', gender: 'female' }).map((s) => s.id), ['a', 'd']);
  assert.deepEqual(filterSubmissions([], { age: '25_34' }), []);
});

test('median handles empty, odd and even lists', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('overview counts what came in, what finished and how recently', () => {
  const o = overview(subs, NOW);
  assert.equal(o.started, 6);
  assert.equal(o.completed, 4);
  assert.equal(o.unfinished, 2);
  assert.equal(o.completionRate, 4 / 6);
  assert.equal(o.completedToday, 3, 'f was finished yesterday');
  assert.equal(o.completedLastHour, 1, 'only d finished in the last hour');
  assert.equal(o.medianDurationMs, 7 * 60 * 1000, 'durations are 4, 2, 10 and 10 minutes');
  assert.equal(o.lastFinishedAt.toISOString(), at(3, 15, 20));
});

test('overview of nothing has no rate, time or last submission', () => {
  const o = overview([], NOW);
  assert.deepEqual([o.started, o.completed, o.completionRate, o.medianDurationMs, o.lastFinishedAt], [0, 0, null, null, null]);
});

test('timeline is hourly for recent data, covers at least 12 hours and counts both series', () => {
  const { unit, buckets } = timeline(subs, NOW);
  assert.equal(unit, 'hour');
  assert.equal(buckets.length, 17, 'from 23:00 yesterday to 15:00 today');
  assert.equal(buckets.at(-1).start.getHours(), 15);
  assert.equal(buckets.reduce((n, b) => n + b.started, 0), 6);
  assert.equal(buckets.reduce((n, b) => n + b.completed, 0), 4);
  const fifteen = buckets.at(-1);
  assert.deepEqual([fifteen.started, fifteen.completed], [2, 1]);
});

test('timeline pads a quiet start to 12 hours', () => {
  const { buckets } = timeline([sub('x', at(3, 15, 5), null)], NOW);
  assert.equal(buckets.length, 12);
  assert.equal(buckets.at(-1).started, 1);
});

test('timeline switches to days after two days and caps at 60 days', () => {
  const old = [sub('x', new Date(2026, 10, 1, 8).toISOString(), new Date(2026, 10, 1, 8, 5).toISOString()), ...subs];
  const { unit, buckets } = timeline(old, new Date(2026, 10, 4, 12));
  assert.equal(unit, 'day');
  assert.equal(buckets.length, 7, 'padded to a week');
  assert.equal(buckets.reduce((n, b) => n + b.started, 0), 7);

  const ancient = [sub('y', new Date(2026, 0, 1).toISOString(), null)];
  assert.equal(timeline(ancient, NOW).buckets.length, 60);
  assert.deepEqual(timeline([], NOW), { unit: 'hour', buckets: [] });
});

test('drop-off shows the last answered question of each unfinished submission', () => {
  const d = dropOff(config, subs);
  assert.equal(d.total, 2);
  assert.equal(d.none, 1, 'e answered nothing');
  assert.deepEqual(d.rows, [{ id: 'years_using', title: config.questions.find((q) => q.id === 'years_using').title, count: 1 }]);
});

test('a write-in box counts as its question when finding where someone stopped', () => {
  const stopped = [sub('w', at(3, 9), null, { age_group: '25_34', gender: 'male', years_using: '2', news_channel: ['other'], news_channel_other: 'Radio' })];
  assert.deepEqual(dropOff(config, stopped).rows.map((r) => r.id), ['news_channel']);
});

test('durations and ages are written in Latvian', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(125_000), '2 min 05 s');
  assert.equal(formatDuration(3_900_000), '1 h 05 min');

  const base = new Date(2026, 10, 3, 12, 0);
  assert.equal(formatAgo(null, base), '—');
  assert.equal(formatAgo(new Date(2026, 10, 3, 11, 59, 40), base), 'tikko');
  assert.equal(formatAgo(new Date(2026, 10, 3, 11, 55), base), 'pirms 5 min');
  assert.equal(formatAgo(new Date(2026, 10, 3, 9, 0), base), 'pirms 3 h');
  assert.equal(formatAgo(new Date(2026, 10, 1, 12, 0), base), 'pirms 2 d');
});
