const app = document.getElementById('app');
const progressBar = document.getElementById('progress');
const statusEl = document.getElementById('status');
const STORE_KEY = 'inbox-survey-v1';
const settings = window.SURVEY_CONFIG ?? {};
let demoApi = null; // set in boot() when running as the static GitHub Pages demo
const RETRY_MS = 3000;

const state = { config: null, id: null, answers: {}, index: 0, completed: false };

/* ---------- small helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function store(value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (value === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    /* private mode etc. — the survey still works, it just can't resume */
  }
  return null;
}

async function api(method, url, body) {
  if (demoApi) return demoApi(method, url, body);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('network'), { network: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

/** Makes it obvious that the GitHub Pages version does not store anything. */
function showDemoBadge() {
  document.querySelector('.site-header')?.append(el('p', { class: 'demo-badge' }, 'Demo versija · atbildes netiek saglabātas'));
}

function showStatus(text) {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
}

function setProgress(fraction) {
  progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

/** One screen = a "head" (title, hint) and a "body" (answers, buttons). Stacked on phones, side by side on desktop. */
function render(head, body = [], layout = '') {
  const screen = el('div', { class: `screen ${layout}`.trim() }, el('div', { class: 'col-head' }, head), el('div', { class: 'col-body' }, body));
  app.replaceChildren(screen);
  const heading = screen.querySelector('h1, h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

/* ---------- saving answers (works through flaky wifi) ---------- */

const pending = new Map(); // question id -> { value, version }
let version = 0;
let inFlight = null;
let retryTimer = null;

function queueSave(questionId, value) {
  pending.set(questionId, { value, version: ++version });
  flush();
}

/** Sends everything pending. Concurrent callers share one run, so awaiting it really waits. */
function flush() {
  if (!inFlight) {
    inFlight = sendPending().then((failed) => {
      inFlight = null;
      if (failed) {
        showStatus('Nav savienojuma. Atbildes saglabāsim, tiklīdz tas atjaunosies.');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, RETRY_MS);
      } else {
        showStatus('');
        if (pending.size) flush(); // something was queued while we were finishing
      }
    });
  }
  return inFlight;
}

/** Resolves true if the network/server failed and a retry is needed. */
async function sendPending() {
  while (pending.size) {
    for (const [questionId, item] of [...pending]) {
      try {
        await api('PUT', `api/submissions/${state.id}/answers/${questionId}`, { value: item.value });
        if (pending.get(questionId)?.version === item.version) pending.delete(questionId);
      } catch (err) {
        if (err.network || err.status >= 500) return true;
        if (err.status === 404) {
          resetAndRestart(); // the submission vanished server-side
          return false;
        }
        console.error('Answer rejected', questionId, err.message);
        pending.delete(questionId); // a 4xx will never succeed on retry
      }
    }
  }
  return false;
}

/* ---------- screens ---------- */

function questions() {
  return state.config.questions;
}

/** Where to resume: the first unanswered question, or the last one if everything is answered. */
function firstUnansweredIndex() {
  const i = questions().findIndex((q) => state.answers[q.id] === undefined);
  return i === -1 ? questions().length - 1 : i;
}

function renderWelcome() {
  const { intro } = state.config;
  const resuming = Object.keys(state.answers).length > 0;
  setProgress(0);
  render(
    [el('h1', {}, intro.title)],
    [
      el('p', { class: 'lede' }, intro.subtitle),
      el('button', { class: 'btn btn-primary btn-big', id: 'start', onclick: start }, resuming ? 'Turpināt' : intro.button),
    ],
    'screen-single',
  );
}

function renderThanks() {
  const { thanks } = state.config;
  setProgress(1);
  showStatus('');
  render(
    [el('div', { class: 'check', 'aria-hidden': 'true' }, '✓'), el('h1', {}, thanks.title)],
    [
      el('p', { class: 'lede' }, thanks.subtitle),
      el('div', { class: 'actions' }, el('button', { class: 'btn btn-primary', type: 'button', onclick: resetAndRestart }, 'Iesniegt vēl vienu atbildi')),
    ],
  );
}

async function start(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    if (!state.id) {
      const { id } = await api('POST', 'api/submissions');
      state.id = id;
      store({ id });
    }
  } catch {
    button.disabled = false;
    app.querySelector('.error')?.remove();
    app.querySelector('.col-body').append(el('p', { class: 'error' }, 'Nevar izveidot savienojumu. Pārbaudiet internetu un mēģiniet vēlreiz.'));
    return;
  }
  state.index = firstUnansweredIndex();
  renderQuestion();
}

function renderQuestion() {
  const q = questions()[state.index];
  const isLast = state.index === questions().length - 1;
  setProgress(state.index / questions().length);

  let busy = false;
  const advance = () => {
    if (busy) return;
    busy = true;
    isLast ? submit().finally(() => (busy = false)) : go(state.index + 1);
  };

  const back = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go(state.index - 1), disabled: state.index === 0 }, '← Atpakaļ');
  const next = el('button', { class: 'btn btn-primary', type: 'button', id: 'next', onclick: advance }, isLast ? 'Iesniegt' : 'Tālāk');
  const autoAdvance = (q.type === 'single' && q.display !== 'dropdown') || q.type === 'scale';
  const actions = el('div', { class: 'actions' }, back, el('span', { class: 'spacer' }), autoAdvance ? null : next);

  let body;
  if (q.type === 'single' && q.display === 'dropdown') {
    body = dropdownSingle(q, next);
  } else if (q.type === 'single' || q.type === 'scale') {
    // One tap answers and moves on — no extra button needed.
    const choose = (value) => {
      state.answers[q.id] = value;
      queueSave(q.id, value);
      for (const b of body.querySelectorAll('.option')) b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
      setTimeout(advance, 260);
    };
    body = q.type === 'single' ? singleOptions(q, choose) : scaleOptions(q, choose);
  } else if (q.type === 'multi') {
    body = multiOptions(q, next);
  } else {
    body = textInput(q, next, isLast);
  }

  const counter = `${state.index + 1} / ${questions().length}`;
  const usesKeys = q.type === 'multi' || q.type === 'scale' || (q.type === 'single' && q.display !== 'dropdown');
  render(
    [
      el('p', { class: 'eyebrow' }, q.section ? `${q.section} · ${counter}` : counter),
      el('h2', {}, q.title),
      q.hint ? el('p', { class: 'hint' }, q.hint) : null,
    ],
    [
      body,
      usesKeys ? el('p', { class: 'kbd-hint' }, 'Padoms: ciparu taustiņi izvēlas atbildi, Enter ved tālāk.') : null,
      el('p', { class: 'error', id: 'error', hidden: true }),
      actions,
    ],
  );
}

function optionButton(role, value, label, { icon, key } = {}) {
  return el(
    'button',
    { class: 'option', type: 'button', role, 'data-value': value, 'data-key': key, 'aria-checked': 'false' },
    icon ? el('span', { class: 'icon', 'aria-hidden': 'true' }, icon) : null,
    el('span', { class: 'label' }, label),
    el('span', { class: 'mark', 'aria-hidden': 'true' }, '✓'),
  );
}

function singleOptions(q, choose) {
  const current = state.answers[q.id];
  const list = el('div', { class: 'options', role: 'radiogroup', 'aria-label': q.title });
  q.options.forEach((o, i) => {
    const b = optionButton('radio', o.value, o.label, { icon: o.icon, key: i + 1 });
    b.setAttribute('aria-checked', String(current === o.value));
    b.addEventListener('click', () => choose(o.value));
    list.append(b);
  });
  return list;
}

function scaleOptions(q, choose) {
  const current = state.answers[q.id];
  const count = q.max - q.min + 1;
  const row = el('div', { class: count > 6 ? 'scale many' : 'scale', role: 'radiogroup', 'aria-label': q.title });
  row.style.setProperty('--n', count);
  for (let v = q.min; v <= q.max; v++) {
    const b = el('button', { class: 'option', type: 'button', role: 'radio', 'data-value': v, 'data-key': v <= 9 ? v : null, 'aria-checked': String(current === v) }, String(v));
    b.addEventListener('click', () => choose(v));
    row.append(b);
  }
  return el('div', {}, row, el('div', { class: 'scale-labels' }, el('span', {}, q.minLabel ?? ''), el('span', {}, q.maxLabel ?? '')));
}

function dropdownSingle(q, next) {
  const select = el('select', { class: 'field', 'aria-label': q.title });
  select.append(el('option', { value: '', disabled: true }, q.placeholder ?? 'Izvēlieties'));
  for (const o of q.options) select.append(el('option', { value: o.value }, o.label));
  select.value = state.answers[q.id] ?? '';

  const sync = () => {
    next.disabled = q.required && select.value === '';
  };
  select.addEventListener('change', () => {
    state.answers[q.id] = select.value;
    queueSave(q.id, select.value);
    sync();
  });
  queueMicrotask(sync);
  return select;
}

function multiOptions(q, next) {
  const selected = new Set(state.answers[q.id] ?? []);
  const list = el('div', { class: 'options', role: 'group', 'aria-label': q.title });
  const sync = () => {
    next.disabled = q.required && selected.size === 0;
    for (const b of list.querySelectorAll('.option')) b.setAttribute('aria-checked', String(selected.has(b.dataset.value)));
  };
  q.options.forEach((o, i) => {
    const b = optionButton('checkbox', o.value, o.label, { icon: o.icon, key: i + 1 });
    b.addEventListener('click', () => {
      selected.has(o.value) ? selected.delete(o.value) : selected.add(o.value);
      const value = q.options.map((x) => x.value).filter((v) => selected.has(v)); // keep a stable order
      if (value.length) state.answers[q.id] = value;
      else delete state.answers[q.id];
      queueSave(q.id, value.length ? value : null);
      sync();
    });
    list.append(b);
  });
  queueMicrotask(sync);
  return list;
}

function textInput(q, next, isLast) {
  const field = el(q.multiline ? 'textarea' : 'input', {
    class: 'field',
    type: q.multiline ? null : 'text',
    maxlength: q.maxLength,
    placeholder: q.placeholder ?? '',
    'aria-label': q.title,
    autocomplete: 'off',
  });
  field.value = state.answers[q.id] ?? '';
  const counter = el('p', { class: 'counter' });

  const sync = () => {
    const text = field.value.trim();
    if (text) state.answers[q.id] = text;
    else delete state.answers[q.id];
    counter.textContent = `${[...field.value].length} / ${q.maxLength}`;
    next.textContent = isLast ? 'Iesniegt' : text || q.required ? 'Tālāk' : 'Izlaist';
    next.disabled = q.required && !text;
  };
  field.addEventListener('input', sync);
  field.addEventListener('blur', () => queueSave(q.id, field.value.trim() || null));
  // Save on the way out even if blur never fires.
  next.addEventListener('click', () => queueSave(q.id, field.value.trim() || null), { capture: true });
  queueMicrotask(sync);
  return el('div', {}, field, counter);
}

/* ---------- navigation ---------- */

function go(index) {
  state.index = Math.max(0, Math.min(questions().length - 1, index));
  renderQuestion();
}

async function submit() {
  const error = document.getElementById('error');
  const fail = (text) => {
    if (error) {
      error.textContent = text;
      error.hidden = false;
    }
  };
  const nextBtn = document.getElementById('next');
  if (nextBtn) nextBtn.disabled = true;

  // Wait for any answers still on their way to the server.
  clearTimeout(retryTimer);
  await flush();
  if (pending.size) {
    fail('Nav savienojuma, atbildes vēl nav saglabātas. Mēģiniet vēlreiz pēc brīža.');
    if (nextBtn) nextBtn.disabled = false;
    return;
  }
  try {
    await api('POST', `api/submissions/${state.id}/complete`);
  } catch (err) {
    if (err.status === 422 && err.data?.missing?.length) {
      const i = questions().findIndex((q) => q.id === err.data.missing[0]);
      go(i === -1 ? 0 : i);
      return;
    }
    fail('Neizdevās iesniegt. Mēģiniet vēlreiz.');
    if (nextBtn) nextBtn.disabled = false;
    return;
  }
  state.completed = true;
  store({ id: state.id, completed: true });
  renderThanks();
}

function resetAndRestart() {
  store(null);
  pending.clear();
  Object.assign(state, { id: null, answers: {}, index: 0, completed: false });
  showStatus('');
  renderWelcome();
}

// The logo always leads back to the very first screen. Answers given so far are kept
// (the start button then says "Turpināt"); after a finished survey it starts a new one.
document.querySelector('.logo-link')?.addEventListener('click', (event) => {
  if (!state.config) return; // still loading: let the browser simply reload the page
  event.preventDefault();
  state.completed ? resetAndRestart() : renderWelcome();
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
  const inSingleLine = event.target instanceof HTMLInputElement; // Enter submits one-line answers; textareas keep new lines
  if (event.key === 'Enter' && (!typing || inSingleLine)) {
    const btn = document.getElementById('next') ?? document.getElementById('start');
    if (btn && !btn.disabled && document.activeElement?.tagName !== 'BUTTON') btn.click();
    return;
  }
  if (typing || !/^\d$/.test(event.key)) return;
  document.querySelector(`.option[data-key="${event.key}"]`)?.click();
});

/* ---------- boot ---------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) {
    store(null);
    history.replaceState(null, '', location.pathname);
  }

  if (settings.demo) {
    const { createDemoApi } = await import('./demo-api.js');
    const questionsUrl = settings.questionsUrl ?? 'questions.json';
    demoApi = createDemoApi({ loadQuestions: () => fetch(questionsUrl).then((res) => res.json()) });
    showDemoBadge();
  }

  try {
    state.config = await api('GET', 'api/questions');
  } catch {
    render(
      [el('h2', {}, 'Nevar ielādēt aptauju')],
      [
        el('p', { class: 'lede' }, 'Pārbaudiet savienojumu un mēģiniet vēlreiz.'),
        el('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Mēģināt vēlreiz'),
      ],
    );
    return;
  }

  const saved = store();
  if (saved?.id) {
    try {
      const sub = await api('GET', `api/submissions/${saved.id}`);
      state.id = sub.id;
      state.answers = sub.answers;
      state.completed = sub.completed;
    } catch (err) {
      if (err.status === 404) store(null); // old link / wiped database: start fresh
    }
  }
  state.completed ? renderThanks() : renderWelcome();
}

boot();
