/**
 * Shared DOM pieces of the phone column of steps (02-ui-ux.yaml phone_steps): the row buttons,
 * the fold, Open all and Close all, and the event lines inside an Architecture group.
 * Text is inserted with textContent only.
 */
import { DIRECTION_WORDS, type EventRow, GLYPHS } from './rows.ts';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/** Text only assistive technology reads. */
export function hidden(text: string): HTMLElement {
  return el('span', { class: 'visually-hidden' }, text);
}

/** What a row shows before it opens: a lead (step number or RAG/MCP), glyph, title, subline. */
export interface RowFace {
  lead?: (Node | string)[];
  glyph?: EventRow['direction'];
  title: string;
  sub: string;
}

/**
 * A row: a list item holding one full-width button with aria-expanded and aria-controls, and
 * its body below it, hidden while closed (02 phone_steps.rows.control).
 */
export function rowItem(
  id: string,
  face: RowFace,
  toggle: () => void,
): { item: HTMLLIElement; button: HTMLButtonElement; body: HTMLElement } {
  const glyph = face.glyph
    ? [
        el('span', { class: 'step-glyph', 'aria-hidden': 'true' }, GLYPHS[face.glyph]),
        // The glyph's meaning in words, after the title (below).
      ]
    : [];
  const title = el('span', { class: 'step-title' }, face.title);
  if (face.glyph) title.append(hidden(`(${DIRECTION_WORDS[face.glyph]})`));
  // A row without a lead or glyph (an Architecture group) starts its title at the left edge.
  const plain = !face.lead && !face.glyph;
  const button = el(
    'button',
    {
      type: 'button',
      class: plain ? 'step-row step-row--plain' : 'step-row',
      'aria-expanded': 'false',
      'aria-controls': id,
    },
    ...(plain ? [] : [el('span', { class: 'step-lead small muted' }, ...(face.lead ?? []))]),
    ...glyph,
    title,
    el('span', { class: 'step-sub small muted' }, face.sub),
    el('span', { class: 'step-marker muted', 'aria-hidden': 'true' }, '▸'),
  );
  button.addEventListener('click', toggle);
  const body = el('div', { class: 'step-body', id, hidden: '' });
  const item = el(
    'li',
    { class: plain ? 'step-item step-item--plain' : 'step-item' },
    button,
    body,
  );
  return { item, button, body };
}

/** Shows a row open or closed; the body's content is the caller's. */
export function setOpen(
  row: { button: HTMLButtonElement; body: HTMLElement },
  open: boolean,
): void {
  row.button.setAttribute('aria-expanded', String(open));
  const marker = row.button.querySelector('.step-marker');
  if (marker) marker.textContent = open ? '▾' : '▸';
  row.body.hidden = !open;
}

/** A fold: a button with aria-expanded over a body, closed at start. */
export function fold(
  label: string,
  id: string,
  content: () => Node[],
): { root: HTMLElement; button: HTMLButtonElement } {
  const body = el('div', { id, class: 'fold-body', hidden: '' });
  const button = el(
    'button',
    { type: 'button', class: 'fold', 'aria-expanded': 'false', 'aria-controls': id },
    label,
  );
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    body.replaceChildren(...(open ? content() : []));
  });
  return { root: el('div', { class: 'fold-area' }, button, body), button };
}

/** "Open all" and "Close all" side by side. */
export function allButtons(openAll: () => void, closeAll: () => void): HTMLElement {
  const open = el('button', { type: 'button' }, 'Open all');
  open.addEventListener('click', openAll);
  const close = el('button', { type: 'button' }, 'Close all');
  close.addEventListener('click', closeAll);
  return el('div', { class: 'open-all' }, open, close);
}

/** The step number in small ink-muted text, read as "Step <k>". */
export function stepNumber(step: number): (Node | string)[] {
  return [hidden('Step '), String(step)];
}

/**
 * An event inside an opened Architecture group (02 phone_steps.body.architecture): its step
 * number, glyph and operation label, its participants, then its explanation.
 */
export function groupEvent(
  row: EventRow,
  lead: (Node | string)[] = stepNumber(row.step),
): HTMLElement {
  const title = el('span', { class: 'step-title' }, row.label);
  title.append(hidden(`(${DIRECTION_WORDS[row.direction]})`));
  return el(
    'li',
    { class: 'group-event', 'data-step': String(row.step) },
    el(
      'p',
      { class: 'group-event-head' },
      el('span', { class: 'step-lead small muted' }, ...lead),
      el('span', { class: 'step-glyph', 'aria-hidden': 'true' }, GLYPHS[row.direction]),
      title,
      el('span', { class: 'step-sub small muted' }, row.participants),
    ),
    el('p', { class: 'message' }, row.event.explanation),
  );
}
