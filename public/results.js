import { aggregateSubmissions, submissionsToCsv } from './aggregate.js';
import { forgetToken, getToken, rememberToken } from './token.js';
import { barRow, el } from './ui.js';

const settings = window.SURVEY_CONFIG ?? {};
const REFRESH_MS = 5000;
// The token comes from the link (fragment preferred: it is never sent to any server) or from this browser's memory.
const token = getToken();

const statsEl = document.getElementById('stats');
const questionsEl = document.getElementById('questions');
const updatedEl = document.getElementById('updated');
const csvLink = document.getElementById('csv');
if (settings.backend !== 'supabase') csvLink.href = `/api/export.csv?token=${encodeURIComponent(token)}`;

function renderQuestion(q) {
  const card = el('div', { class: 'card' }, el('h3', {}, q.title), el('p', { class: 'meta' }, `${q.section ? q.section + ' · ' : ''}atbildēja ${q.answered}`));

  if (q.options) {
    for (const o of q.options) card.append(barRow(`${o.icon ? o.icon + ' ' : ''}${o.label}`, o.count, q.answered));
  } else if (q.distribution) {
    if (q.average !== null) {
      card.append(el('p', {}, el('span', { class: 'big-number' }, q.average.toFixed(1)), `vidēji no ${q.max}`));
    }
    for (const d of q.distribution) card.append(barRow(String(d.value), d.count, q.answered));
  } else if (q.texts) {
    card.classList.add('card-wide');
    const list = el('ul', { class: 'texts' });
    for (const t of q.texts) list.append(el('li', {}, t.text));
    card.append(q.texts.length ? list : el('p', { class: 'hint' }, 'Vēl nav atbilžu.'));
  }
  return card;
}

class Unauthorized extends Error {}

let supabaseApi = null;
let csvUrl = null;

/** Results from Supabase: download the export and aggregate it here, with the same code the Node server uses. */
async function loadFromSupabase() {
  if (!supabaseApi) {
    const { createSupabaseApi } = await import('./supabase-api.js');
    supabaseApi = createSupabaseApi({ url: settings.supabaseUrl, key: settings.publishableKey });
  }
  let exported;
  try {
    exported = await supabaseApi.rpc('survey_export', { p_token: token });
  } catch (err) {
    if (err.status === 401) throw new Unauthorized();
    throw err;
  }
  const subs = exported.submissions.map((s) => ({ id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: s.answers }));

  // The CSV is built in the browser from the same export.
  if (csvUrl) URL.revokeObjectURL(csvUrl);
  csvUrl = URL.createObjectURL(new Blob([submissionsToCsv(exported.config, subs)], { type: 'text/csv;charset=utf-8' }));
  csvLink.href = csvUrl;
  csvLink.download = 'aptauja.csv';

  return aggregateSubmissions(exported.config, subs);
}

async function loadFromServer() {
  const res = await fetch(`/api/results?token=${encodeURIComponent(token)}`);
  if (res.status === 401) throw new Unauthorized();
  return res.json();
}

async function load() {
  let data;
  try {
    data = settings.backend === 'supabase' ? await loadFromSupabase() : await loadFromServer();
  } catch (err) {
    if (!(err instanceof Unauthorized)) throw err;
    forgetToken();
    questionsEl.replaceChildren(el('p', { class: 'error' }, 'Nederīga piekļuves atslēga. Izmantojiet saiti, kas paredzēta rezultātu skatīšanai.'));
    return false;
  }

  rememberToken(token);
  statsEl.replaceChildren(
    el('div', { class: 'stat' }, el('b', {}, data.totals.started), el('span', {}, 'sākuši')),
    el('div', { class: 'stat' }, el('b', {}, data.totals.completed), el('span', {}, 'pabeiguši')),
  );
  questionsEl.replaceChildren(...data.questions.map(renderQuestion));
  updatedEl.textContent = `Atjaunots ${new Date().toLocaleTimeString('lv-LV')}`;
  return true;
}

(async function loop() {
  let ok = true;
  try {
    ok = await load();
  } catch {
    updatedEl.textContent = 'Nav savienojuma…';
  }
  if (ok) setTimeout(loop, REFRESH_MS);
})();
