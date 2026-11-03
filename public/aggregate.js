/**
 * Turns raw submissions into the numbers shown on the results page, and into CSV.
 *
 * Pure functions with no Node-only imports, so the same code runs in the Node server
 * (SQLite) and in the browser (the Supabase results page).
 *
 * A submission looks like { id, createdAt, completedAt, answers: { [questionId]: value } }.
 * They must be ordered oldest first.
 */

/** Aggregates all answers per question. */
export function aggregateSubmissions(config, subs) {
  const questions = config.questions.map((q) => {
    const values = subs.map((s) => s.answers[q.id]).filter((v) => v !== undefined);
    const base = { id: q.id, title: q.title, type: q.type, section: q.section ?? null, answered: values.length };

    if (q.type === 'single' || q.type === 'multi') {
      const counts = new Map(q.options.map((o) => [o.value, 0]));
      for (const v of values) for (const x of q.type === 'multi' ? v : [v]) counts.set(x, counts.get(x) + 1);
      return {
        ...base,
        options: q.options.map((o) => ({ value: o.value, label: o.label, icon: o.icon ?? null, count: counts.get(o.value) })),
      };
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
  });

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

/** CSV with one row per submission and one column per question. */
export function submissionsToCsv(config, subs) {
  const header = ['submission_id', 'created_at', 'completed_at', ...config.questions.map((q) => q.id)];
  const lines = [header.map(csvCell).join(',')];
  for (const s of subs) {
    lines.push([s.id, s.createdAt, s.completedAt, ...config.questions.map((q) => s.answers[q.id])].map(csvCell).join(','));
  }
  // BOM so Excel reads UTF-8 (Latvian letters) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
