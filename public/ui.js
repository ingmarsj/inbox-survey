// Small DOM helpers shared by the results and statistics pages.

export function el(tag, props = {}, ...children) {
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

export const pct = (count, total) => (total ? Math.round((count / total) * 100) : 0);

export function barRow(label, count, total) {
  const fill = el('i');
  fill.style.width = `${pct(count, total)}%`;
  return el('div', { class: 'bar-row' }, el('span', {}, label), el('div', { class: 'bar' }, fill), el('span', { class: 'num' }, `${count} · ${pct(count, total)}%`));
}
