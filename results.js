import { allSubmissions } from './db.js';
import { aggregateSubmissions, submissionsToCsv } from './public/aggregate.js';

/** Aggregates all answers stored in SQLite. */
export function aggregate(db, config) {
  return aggregateSubmissions(config, allSubmissions(db));
}

export function toCsv(db, config) {
  return submissionsToCsv(config, allSubmissions(db));
}
