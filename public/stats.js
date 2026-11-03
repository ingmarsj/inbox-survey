import { aggregateSubmissions } from './aggregate.js';
import { dropOff, filterSubmissions, formatAgo, formatDuration, overview, timeline } from './stats-data.js';
import { forgetToken, getToken, rememberToken } from './token.js';
import { barRow, el, pct } from './ui.js';

const settings = window.SURVEY_CONFIG ?? {};
const REFRESH_MS = 15000;

const $ = (id) => document.getElementById(id);
const content = $('content');
const errorEl = $('error');
const updatedEl = $('updated');

class Unauthorized extends Error {}

let token = getToken();
let supabaseApi = null;
let data = null; // { config, subs } from the last successful load
let filtersBuilt = false;

/** Normalises the Supabase export (snake_case) and the Node server's export to the same shape. */
async function load() {
  if (settings.backend === 'supabase') {
    if (!supabaseApi) {
      const { createSupabaseApi } = await import('./supabase-api.js');
      supabaseApi = createSupabaseApi({ url: settings.supabaseUrl, key: settings.publishableKey });
    }
    try {
      const exported = await supabaseApi.rpc('survey_export', { p_token: token });
      return { config: exported.config, subs: exported.submissions.map((s) => ({ id: s.id, createdAt: s.created_at, completedAt: s.completed_at, answers: s.answers })) };
    } catch (err) {
      throw err.status === 401 ? new Unauthorized() : err;
    }
  }
  const res = await fetch(`/api/export.json?token=${encodeURIComponent(token)}`);
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- rendering ----------

const kpi = (value, label, extra = '') => el('div', { class: `kpi ${extra}`.trim() }, el('b', {}, value), el('span', {}, label));

function renderKpis(o, now) {
  $('kpis').replaceChildren(
    kpi(o.completed, 'iesūtījuši (pabeiguši)', 'kpi-main'),
    kpi(o.started, 'sākuši'),
    kpi(o.unfinished, 'nepabeigti'),
    kpi(o.completionRate === null ? '—' : `${Math.round(o.completionRate * 100)}%`, 'pabeidz līdz galam'),
    kpi(o.completedToday, 'šodien iesūtīti'),
    kpi(o.completedLastHour, 'pēdējā stundā'),
    kpi(formatDuration(o.medianDurationMs), 'tipisks aizpildes laiks'),
    kpi(formatAgo(o.lastFinishedAt, now), 'pēdējais iesūtījums'),
  );
}

const hourLabel = (d) => `${String(d.getHours()).padStart(2, '0')}:00`;
const dayLabel = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;

function renderTimeline(subs, now) {
  const { unit, buckets } = timeline(subs, now);
  $('timeline-title').textContent = unit === 'hour' ? 'Iesūtījumi pa stundām' : 'Iesūtījumi pa dienām';
  $('timeline-meta').textContent = 'Sarkanā josla — pabeigti, pelēkā — sākti.';
  const target = $('timeline');
  if (!buckets.length) {
    target.replaceChildren(el('p', { class: 'hint' }, 'Vēl nav neviena ieraksta.'));
    return;
  }
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.started, b.completed)));
  const label = unit === 'hour' ? hourLabel : dayLabel;
  const every = Math.ceil(buckets.length / 8); // about eight labels along the bottom
  const cols = buckets.map((b, i) => {
    const started = el('i', { class: 'b-started' });
    const completed = el('i', { class: 'b-done' });
    started.style.height = `${(b.started / max) * 100}%`;
    completed.style.height = `${(b.completed / max) * 100}%`;
    return el(
      'div',
      { class: 'col', title: `${label(b.start)} · sākti ${b.started}, pabeigti ${b.completed}` },
      el('div', { class: 'bars' }, started, completed),
      el('span', {}, (buckets.length - 1 - i) % every === 0 ? label(b.start) : ''),
    );
  });
  const total = buckets.reduce((n, b) => n + b.completed, 0);
  const chart = el('div', { class: 'chart', role: 'img', 'aria-label': `${unit === 'hour' ? 'Pa stundām' : 'Pa dienām'}: kopā ${total} pabeigti` }, ...cols);
  target.replaceChildren(chart);
}

function renderDropOff(config, subs) {
  const d = dropOff(config, subs);
  $('dropoff-meta').textContent = d.total ? `Nepabeigti: ${d.total}. Rāda pēdējo jautājumu, uz kuru cilvēks atbildēja.` : '';
  const target = $('dropoff');
  if (!d.total) {
    target.replaceChildren(el('p', { class: 'hint' }, 'Nepabeigtu ierakstu nav.'));
    return;
  }
  const rows = [];
  if (d.none) rows.push(barRow('Atvēra, bet neatbildēja', d.none, d.total));
  for (const r of d.rows) rows.push(barRow(r.title, r.count, d.total));
  target.replaceChildren(...rows);
}

function buildFilters(config) {
  const fill = (selectId, wrapId, questionId, allLabel) => {
    const question = config.questions.find((q) => q.id === questionId);
    if (!question?.options) {
      $(wrapId).hidden = true;
      return;
    }
    $(selectId).replaceChildren(el('option', { value: '' }, allLabel), ...question.options.map((o) => el('option', { value: o.value }, o.label)));
  };
  fill('f-age', 'f-age-wrap', 'age_group', 'Visi vecumi');
  fill('f-gender', 'f-gender-wrap', 'gender', 'Visi dzimumi');
  filtersBuilt = true;
}

const currentFilters = () => ({ completedOnly: $('f-mode').value === 'done', age: $('f-age').value, gender: $('f-gender').value });

function renderQuestion(q, fullLink) {
  const card = el('div', { class: 'card' }, el('h3', {}, q.title), el('p', { class: 'meta' }, `${q.section ? q.section + ' · ' : ''}atbildēja ${q.answered}`));
  if (q.options) {
    for (const o of q.options) card.append(barRow(`${o.icon ? o.icon + ' ' : ''}${o.label}`, o.count, q.answered));
  } else if (q.distribution) {
    if (q.average !== null) card.append(el('p', {}, el('span', { class: 'big-number' }, q.average.toFixed(1)), `vidēji no ${q.max}`));
    for (const d of q.distribution) card.append(barRow(String(d.value), d.count, q.answered));
  } else {
    card.append(el('p', { class: 'hint' }, q.answered ? el('span', {}, 'Teksta atbildes: ', el('a', { href: fullLink }, 'skatīt rezultātu lapā')) : 'Vēl nav atbilžu.'));
  }
  return card;
}

function renderAnswers() {
  const { config, subs } = data;
  const view = filterSubmissions(subs, currentFilters());
  const result = aggregateSubmissions(config, view);
  const average = (id) => result.questions.find((q) => q.id === id)?.average ?? null;
  const fmt = (v) => (v === null ? '—' : v.toFixed(1));

  $('view-kpis').replaceChildren(
    kpi(view.length, `ieraksti atlasītajā skatā (${pct(view.length, subs.length)}% no visiem)`),
    kpi(fmt(average('satisfaction')), 'apmierinātība, vidēji no 5'),
    kpi(fmt(average('recommend')), 'ieteiks Inbox.lv, vidēji no 5'),
  );
  // A write-in box ("Cits: …") is free text, so it is read on the results page next to the other texts.
  $('questions').replaceChildren(...result.questions.filter((q) => !config.questions.find((c) => c.id === q.id).inline).map((q) => renderQuestion(q, $('full').href)));
}

function render() {
  const now = new Date();
  const { config, subs } = data;
  if (!filtersBuilt) buildFilters(config);
  renderKpis(overview(subs, now), now);
  renderTimeline(subs, now);
  renderDropOff(config, subs);
  renderAnswers();
  updatedEl.textContent = `Atjaunots ${now.toLocaleTimeString('lv-LV')} · atjaunojas pats`;
}

// ---------- loading ----------

let timer = null;

async function refresh() {
  clearTimeout(timer);
  try {
    if (!token) throw new Unauthorized();
    data = await load();
    errorEl.hidden = true;
    content.hidden = false;
    $('full').href = `../results.html#token=${encodeURIComponent(token)}`;
    rememberToken(token);
    render();
  } catch (err) {
    if (err instanceof Unauthorized) {
      forgetToken();
      content.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = 'Nepieciešama piekļuves atslēga. Vienreiz atveriet statistikas saiti ar atslēgu (…/stats/#token=…); pēc tam šajā pārlūkā pietiks ar /stats/.';
      updatedEl.textContent = '';
      return; // nothing to refresh until a valid link is opened
    }
    updatedEl.textContent = 'Nav savienojuma, mēģinām vēlreiz…';
  }
  timer = setTimeout(refresh, REFRESH_MS);
}

for (const id of ['f-mode', 'f-age', 'f-gender']) $(id).addEventListener('change', () => data && renderAnswers());
$('reset').addEventListener('click', () => {
  $('f-mode').value = 'all';
  $('f-age').value = '';
  $('f-gender').value = '';
  if (data) renderAnswers();
});
$('refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) refresh();
});

refresh();
