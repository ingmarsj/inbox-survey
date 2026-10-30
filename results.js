import { allSubmissions } from './db.js';

/** Aggregates all answers per question. */
export function aggregate(db, config) {
  const subs = allSubmissions(db);

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
      const out = { ...base, min: q.min, max: q.max, average, distribution };
      if (q.id === 'nps' && values.length) {
        const promoters = values.filter((v) => v >= 9).length;
        const detractors = values.filter((v) => v <= 6).length;
        out.nps = {
          promoters,
          passives: values.length - promoters - detractors,
          detractors,
          score: Math.round(((promoters - detractors) / values.length) * 100),
        };
      }
      return out;
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

export function toCsv(db, config) {
  const header = ['submission_id', 'created_at', 'completed_at', ...config.questions.map((q) => q.id)];
  const lines = [header.map(csvCell).join(',')];
  for (const s of allSubmissions(db)) {
    lines.push([s.id, s.createdAt, s.completedAt, ...config.questions.map((q) => s.answers[q.id])].map(csvCell).join(','));
  }
  // BOM so Excel reads UTF-8 (Latvian letters) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
