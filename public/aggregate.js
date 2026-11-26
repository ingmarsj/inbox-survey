/**
 * Turns raw submissions into the numbers shown on the results page, and into CSV.
 *
 * Pure functions with no Node-only imports, so the same code runs in the Node server
 * (SQLite) and in the browser (the Supabase results page).
 *
 * A submission looks like { id, createdAt, completedAt, answers: { [questionId]: value } }.
 * They must be ordered oldest first.
 *
 * Questions and answer options that were taken out of the survey stay readable here:
 * `config.archived` lists removed questions and a question's `archivedOptions` lists removed
 * options. They are counted like any other, flagged `archived: true`, and shown only when
 * somebody actually answered them, so the results never lose what people said earlier.
 */

/** Aggregates all answers per question. */
export function aggregateSubmissions(config, subs) {
  const all = [
    ...config.questions.map((q) => ({ q, archived: false })),
    ...(config.archived ?? []).map((q) => ({ q, archived: true })),
  ];
  const questions = all
    .map(({ q, archived }) => {
      const values = subs.map((s) => s.answers[q.id]).filter((v) => v !== undefined);
      const base = { id: q.id, title: q.title, type: q.type, section: q.section ?? null, answered: values.length, ...(archived ? { archived: true } : {}) };

      if (q.type === 'single' || q.type === 'multi') {
        const current = q.options.map((o) => ({ ...o, archived: false }));
        const removed = (q.archivedOptions ?? []).map((o) => ({ ...o, archived: true }));
        const counts = new Map([...current, ...removed].map((o) => [o.value, 0]));
        for (const v of values) {
          // Answers saved before a question changed type or lost an option are skipped, not miscounted.
          for (const x of q.type === 'multi' && Array.isArray(v) ? v : [v]) if (counts.has(x)) counts.set(x, counts.get(x) + 1);
        }
        const rows = [...current, ...removed]
          .map((o) => ({ value: o.value, label: o.label, icon: o.icon ?? null, count: counts.get(o.value), ...(o.archived ? { archived: true } : {}) }))
          .filter((o) => !o.archived || o.count > 0);
        return { ...base, options: rows };
      }

      if (q.type === 'scale') {
        const distribution = [];
        for (let i = q.min; i <= q.max; i++) distribution.push({ value: i, count: values.filter((v) => v === i).length });
        const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return { ...base, min: q.min, max: q.max, average, distribution };
      }

      // text: newest first
      const texts = subs
        .filter((s) => s.answers[q.id] !== undefined)
        .reverse()
        .map((s) => ({ text: s.answers[q.id] }));
      return { ...base, texts };
    })
    // a removed question is listed only when it has answers
    .filter((q) => !q.archived || q.answered > 0);

  return {
    totals: {
      started: subs.length,
      completed: subs.filter((s) => s.completedAt).length,
    },
    questions,
  };
}

const csvCell = (value) => {
  let s = Array.isArray(value) ? value.join('|') : value === undefined || value === null ? '' : String(value);
  // Stop spreadsheet formula injection from free text.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** CSV with one row per submission and one column per question (removed questions come last). */
export function submissionsToCsv(config, subs) {
  const ids = [...config.questions.map((q) => q.id), ...(config.archived ?? []).map((q) => q.id)];
  const header = ['submission_id', 'created_at', 'completed_at', ...ids];
  const lines = [header.map(csvCell).join(',')];
  for (const s of subs) {
    lines.push([s.id, s.createdAt, s.completedAt, ...ids.map((id) => s.answers[id])].map(csvCell).join(','));
  }
  // BOM so Excel reads UTF-8 (Latvian letters) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
