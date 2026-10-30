const token = new URLSearchParams(location.search).get('token') ?? '';
const REFRESH_MS = 5000;

const statsEl = document.getElementById('stats');
const questionsEl = document.getElementById('questions');
const updatedEl = document.getElementById('updated');
document.getElementById('csv').href = `/api/export.csv?token=${encodeURIComponent(token)}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const pct = (count, total) => (total ? Math.round((count / total) * 100) : 0);

function barRow(label, count, total) {
  const fill = el('i');
  fill.style.width = `${pct(count, total)}%`;
  return el('div', { class: 'bar-row' }, el('span', {}, label), el('div', { class: 'bar' }, fill), el('span', { class: 'num' }, `${count} · ${pct(count, total)}%`));
}

function renderQuestion(q) {
  const card = el('div', { class: 'card' }, el('h3', {}, q.title), el('p', { class: 'meta' }, `${q.section ? q.section + ' · ' : ''}atbildēja ${q.answered}`));

  if (q.options) {
    for (const o of q.options) card.append(barRow(`${o.icon ? o.icon + ' ' : ''}${o.label}`, o.count, q.answered));
  } else if (q.distribution) {
    if (q.average !== null) {
      card.append(el('p', {}, el('span', { class: 'big-number' }, q.average.toFixed(1)), `vidēji no ${q.max}`));
    }
    if (q.nps) {
      card.append(el('p', { class: 'hint' }, `NPS ${q.nps.score} · atbalstītāji ${q.nps.promoters}, neitrāli ${q.nps.passives}, kritiķi ${q.nps.detractors}`));
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

async function load() {
  const res = await fetch(`/api/results?token=${encodeURIComponent(token)}`);
  if (res.status === 401) {
    questionsEl.replaceChildren(el('p', { class: 'error' }, 'Nederīga piekļuves atslēga. Izmantojiet saiti, ko izdrukāja serveris.'));
    return false;
  }
  const data = await res.json();

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
