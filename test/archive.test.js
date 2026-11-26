import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../questions.js';
import { aggregateSubmissions, submissionsToCsv } from '../public/aggregate.js';
import { filterSubmissions } from '../public/stats-data.js';
import { config } from './helpers.js';

// A tiny survey: one live single choice that lost an option, one live text, one removed text and one removed single choice.
const small = {
  questions: [
    { id: 'plan', type: 'single', title: 'Plan', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], archivedOptions: [{ value: 'old', label: 'Old' }, { value: 'older', label: 'Older' }] },
    { id: 'note', type: 'text', title: 'Note' },
  ],
  archived: [
    { id: 'word', type: 'text', title: 'One word', section: 'Asociācijas' },
    { id: 'freq', type: 'single', title: 'How often', options: [{ value: 'm', label: 'Monthly' }, { value: 'q', label: 'Quarterly' }] },
  ],
};
const sub = (id, answers, completed = true) => ({ id, createdAt: `2026-11-0${id}T10:00:00.000Z`, completedAt: completed ? `2026-11-0${id}T10:05:00.000Z` : null, answers });
const subs = [sub(1, { plan: 'old', word: 'ātrs', freq: 'm' }), sub(2, { plan: 'a', note: 'labi', word: 'ērts' }), sub(3, { plan: 'martian' }, false)];

test('removed questions with answers are listed after the live ones, flagged and with their answers', () => {
  const r = aggregateSubmissions(small, subs);
  assert.deepEqual(r.questions.map((q) => [q.id, q.archived === true]), [['plan', false], ['note', false], ['word', true], ['freq', true]]);
  const word = r.questions.find((q) => q.id === 'word');
  assert.equal(word.answered, 2);
  assert.equal(word.section, 'Asociācijas');
  assert.deepEqual(word.texts.map((t) => t.text), ['ērts', 'ātrs'], 'newest first');
  const freq = r.questions.find((q) => q.id === 'freq');
  assert.deepEqual(freq.options.map((o) => [o.value, o.count]), [['m', 1], ['q', 0]]);
});

test('a removed question nobody answered is not listed', () => {
  const r = aggregateSubmissions(small, [sub(2, { plan: 'a', note: 'labi' })]);
  assert.deepEqual(r.questions.map((q) => q.id), ['plan', 'note']);
  assert.equal(aggregateSubmissions(small, []).questions.length, 2);
});

test('removed options are counted and flagged, but only when somebody picked them', () => {
  const plan = aggregateSubmissions(small, subs).questions.find((q) => q.id === 'plan');
  assert.deepEqual(plan.options.map((o) => [o.value, o.count, o.archived === true]), [['a', 1, false], ['b', 0, false], ['old', 1, true]]);
  assert.equal(plan.answered, 3, 'answered counts every given answer');
  // nobody picked an archived option: no archived rows at all
  const none = aggregateSubmissions(small, [sub(2, { plan: 'a' })]).questions.find((q) => q.id === 'plan');
  assert.deepEqual(none.options.map((o) => o.value), ['a', 'b']);
});

test('an answer that matches neither a live nor an archived option is still skipped, not miscounted', () => {
  const plan = aggregateSubmissions(small, [sub(3, { plan: 'martian' })]).questions.find((q) => q.id === 'plan');
  assert.deepEqual(plan.options.map((o) => o.count), [0, 0]);
});

test('multiple-choice questions count archived options inside lists', () => {
  const multi = {
    questions: [{ id: 'p', type: 'multi', title: 'P', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }], archivedOptions: [{ value: 'z', label: 'Z' }] }],
  };
  const r = aggregateSubmissions(multi, [sub(1, { p: ['x', 'z'] }), sub(2, { p: ['z'] })]).questions[0];
  assert.deepEqual(r.options.map((o) => [o.value, o.count, o.archived === true]), [['x', 1, false], ['y', 0, false], ['z', 2, true]]);
});

test('the shape of live questions did not change (no archived keys unless needed)', () => {
  const r = aggregateSubmissions(small, [sub(2, { plan: 'a' })]);
  const plan = r.questions[0];
  assert.equal('archived' in plan, false);
  assert.equal(plan.options.some((o) => 'archived' in o), false);
});

test('CSV: live columns first, then the removed questions, with their answers', () => {
  const csv = submissionsToCsv(small, subs).replace(/^﻿/, '').split('\r\n');
  assert.equal(csv[0], 'submission_id,created_at,completed_at,plan,note,word,freq');
  assert.equal(csv[1], '1,2026-11-01T10:00:00.000Z,2026-11-01T10:05:00.000Z,old,,ātrs,m');
  assert.equal(csv[2], '2,2026-11-02T10:00:00.000Z,2026-11-02T10:05:00.000Z,a,labi,ērts,');
  // a config without an archive works as before
  assert.equal(submissionsToCsv({ questions: small.questions }, subs).replace(/^﻿/, '').split('\r\n')[0], 'submission_id,created_at,completed_at,plan,note');
});

test('the statistics filter can start at the date the current survey went live', () => {
  const list = [sub(1, {}), sub(2, {}), sub(3, {}, false)]; // the third one did not finish
  assert.deepEqual(filterSubmissions(list, { since: '2026-11-02T00:00:00Z' }).map((s) => s.id), [2, 3]);
  assert.deepEqual(filterSubmissions(list, { since: '2026-11-02T10:00:00.000Z' }).map((s) => s.id), [2, 3], 'the start itself is included');
  assert.deepEqual(filterSubmissions(list, { since: '2026-12-01T00:00:00Z' }), []);
  assert.equal(filterSubmissions(list, { since: '' }).length, 3);
  assert.deepEqual(filterSubmissions(list, { since: '2026-11-02T00:00:00Z', completedOnly: true }).map((s) => s.id), [2], 'combines with the other filters');
});

test('loadConfig checks archived questions, archived options and currentSince', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const live = { id: 'q', type: 'single', title: 'Q', options: opts };
  const load = (extra, liveQuestion = live) => {
    const file = path.join(dir, 'q.json');
    writeFileSync(file, JSON.stringify({ questions: [liveQuestion], ...extra }));
    return loadConfig(file);
  };
  const gone = { id: 'gone', type: 'text', title: 'Gone' };
  try {
    assert.doesNotThrow(() => load({ archived: [gone] }));
    assert.doesNotThrow(() => load({ archived: [{ id: 'g', type: 'single', title: 'G', options: opts }] }));
    assert.throws(() => load({ archived: 'x' }), /must be a list/);
    assert.throws(() => load({ archived: [{ ...gone, id: 'q' }] }), /used by a live question/);
    assert.throws(() => load({ archived: [gone, gone] }), /duplicate id/);
    assert.throws(() => load({ archived: [{ ...gone, id: 'Bad Id' }] }), /id must match/);
    assert.throws(() => load({ archived: [{ ...gone, type: 'nope' }] }), /unknown type/);
    assert.throws(() => load({ archived: [{ id: 'g', type: 'text' }] }), /missing title/);
    assert.throws(() => load({ archived: [{ id: 'g', type: 'single', title: 'G' }] }), /needs options/);
    assert.throws(() => load({ archived: [{ id: 'g', type: 'scale', title: 'G', min: 5, max: 1 }] }), /min < max/);

    assert.doesNotThrow(() => load({}, { ...live, archivedOptions: [{ value: 'old', label: 'Old' }] }));
    assert.throws(() => load({}, { ...live, archivedOptions: [{ value: 'a', label: 'Again' }] }), /also a live option/);
    assert.throws(() => load({}, { ...live, archivedOptions: [{ value: 'o', label: 'O' }, { value: 'o', label: 'O2' }] }), /also a live option/);
    assert.throws(() => load({}, { ...live, archivedOptions: [{ value: 'o' }] }), /needs value and label/);
    assert.throws(() => load({}, { ...live, archivedOptions: 'x' }), /must be a list/);
    assert.throws(() => load({}, { id: 't', type: 'text', title: 'T', archivedOptions: [{ value: 'o', label: 'O' }] }), /single and multiple choice only/);

    assert.doesNotThrow(() => load({ currentSince: '2026-11-26T00:00:00Z' }));
    assert.throws(() => load({ currentSince: 'yesterday' }), /currentSince/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped survey keeps the removed questions and options in its archive', () => {
  assert.deepEqual(config.archived.map((q) => q.id), ['not_using_reason', 'one_word', 'news_frequency', 'region', 'support_comment']);
  const live = new Set(config.questions.map((q) => q.id));
  for (const q of config.archived) assert.equal(live.has(q.id), false, `${q.id} is not also live`);
  const archivedOptions = Object.fromEntries(config.questions.filter((q) => q.archivedOptions).map((q) => [q.id, q.archivedOptions.map((o) => o.value)]));
  assert.deepEqual(archivedOptions, {
    age_group: ['under_18'],
    years_using: ['not_using', 'under_1', '1', '2', '3', '4'],
    email_purpose: ['bills'],
    inbox_products: ['dating', 'pp', 'xtv'],
  });
  assert.match(config.currentSince, /^\d{4}-\d{2}-\d{2}T/);
  // archived questions are never asked: they are not on the respondent's path
  assert.equal(config.questions.some((q) => config.archived.some((a) => a.id === q.id)), false);
});

test('the pages show the archive: a "vecā aptauja" label and a period filter on the statistics page', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const stats = read('../public/stats.js');
  const results = read('../public/results.js');
  for (const [name, text] of [['stats.js', stats], ['results.js', results]]) {
    assert.match(text, /vecā aptauja/, name);
    assert.match(text, /q\.archived/, `${name} reads the archived flag of a question`);
    assert.match(text, /o\.archived/, `${name} reads the archived flag of an option`);
  }
  assert.match(stats, /config\.questions\.find\(\(c\) => c\.id === q\.id\)\?\.inline/, 'an archived question has no live definition, so the lookup must not throw');
  assert.match(stats, /currentSince/);
  assert.match(read('../public/stats/index.html'), /id="f-period"/);
  assert.match(read('../public/stats/index.html'), /Tikai pēc aptaujas atjaunināšanas/);
});
