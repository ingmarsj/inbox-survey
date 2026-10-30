import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id           TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS answers (
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    question_id   TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (submission_id, question_id)
  );
  CREATE INDEX IF NOT EXISTS answers_by_question ON answers(question_id);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function createSubmission(db, id) {
  db.prepare('INSERT INTO submissions (id, created_at) VALUES (?, ?)').run(id, now());
}

export function getSubmission(db, id) {
  const sub = db.prepare('SELECT id, created_at, completed_at FROM submissions WHERE id = ?').get(id);
  if (!sub) return null;
  const rows = db.prepare('SELECT question_id, value FROM answers WHERE submission_id = ?').all(id);
  const answers = {};
  for (const r of rows) answers[r.question_id] = JSON.parse(r.value);
  return { id: sub.id, createdAt: sub.created_at, completedAt: sub.completed_at, answers };
}

/** value === null clears the answer. */
export function saveAnswer(db, submissionId, questionId, value) {
  if (value === null) {
    db.prepare('DELETE FROM answers WHERE submission_id = ? AND question_id = ?').run(submissionId, questionId);
    return;
  }
  db.prepare(
    `INSERT INTO answers (submission_id, question_id, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (submission_id, question_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(submissionId, questionId, JSON.stringify(value), now());
}

export function completeSubmission(db, id) {
  db.prepare('UPDATE submissions SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(now(), id);
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Every submission with its answers, oldest first. */
export function allSubmissions(db) {
  const subs = db.prepare('SELECT id, created_at, completed_at FROM submissions ORDER BY created_at, rowid').all();
  const byId = new Map();
  for (const s of subs) byId.set(s.id, { id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: {} });
  for (const r of db.prepare('SELECT submission_id, question_id, value FROM answers').all()) {
    byId.get(r.submission_id).answers[r.question_id] = JSON.parse(r.value);
  }
  return [...byId.values()];
}
