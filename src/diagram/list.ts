/**
 * The diagram as a one-dimensional step list for phones (02-ui-ux.yaml diagram.phone_list):
 * the same layout model as the SVG, rendered as HTML rows that name their sender and
 * receiver, joined by a short arrow in the event's line encoding. Every text is escaped;
 * colours come from classes in src/styles/diagram.css only.
 */
import type { Arrow, DiagramLayout, Group, StageBlock } from './model.ts';

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Requests and actions get a filled head; responses and results an open one. */
function isResponse(a: Arrow): boolean {
  return a.event.message_type === 'RESPONSE' || a.event.message_type === 'RESULT';
}

/** The short arrow between sender and receiver: 32 px, or a loop for a self-call. */
function arrowMark(a: Arrow): string {
  const cls = ['row-arrow', `row-arrow--${a.line}`];
  if (a.emphasized) cls.push('row-arrow--current');
  const head = isResponse(a) ? 'row-head row-head--response' : 'row-head row-head--request';
  if (a.self) {
    // Out to the right, down and back, the head pointing left at the start.
    return `<svg class="${cls.join(' ')}" width="24" height="14" viewBox="0 0 24 14" aria-hidden="true"><path class="row-line" d="M 1 3 H 20 V 10.5 H 8" /><path class="${head}" d="M 8 7 L 1 10.5 L 8 14${isResponse(a) ? '' : ' z'}" /></svg>`;
  }
  return `<svg class="${cls.join(' ')}" width="32" height="10" viewBox="0 0 32 10" aria-hidden="true"><path class="row-line" d="M 0 5 H 25" /><path class="${head}" d="M 24 1 L 31 5 L 24 9${isResponse(a) ? '' : ' z'}" /></svg>`;
}

/** Text whose last word does not break from `mark` after it; both already escaped. */
function glueLast(text: string, mark: string): string {
  const at = text.lastIndexOf(' ');
  return `${text.slice(0, at + 1)}<span class="nowrap">${text.slice(at + 1)} ${mark}</span>`;
}

/** Text whose first word does not break from `mark` before it; both already escaped. */
function glueFirst(mark: string, text: string): string {
  const at = text.indexOf(' ');
  const first = at < 0 ? text : text.slice(0, at);
  return `<span class="nowrap">${mark} ${first}</span>${at < 0 ? '' : text.slice(at)}`;
}

function renderRow(a: Arrow, names: Readonly<Record<string, string>>): string {
  const cls = ['row'];
  if (a.emphasized) cls.push('row--emphasized');
  if (a.visibility === 'past' && !a.emphasized) cls.push('row--past');
  const e = a.event;
  const from = esc(names[e.sender] ?? e.sender);
  const to = esc(names[e.receiver] ?? e.receiver);
  const current = a.visibility === 'current' ? ' data-current=""' : '';
  const label = a.selected ? 'row-label row-label--selected' : 'row-label';
  const selected = a.selected
    ? '<span class="visually-hidden">, carries the selected value</span>'
    : '';
  // The arrow never stands alone on a line: it keeps the word next to it.
  const route = a.self
    ? `${glueLast(from, `${arrowMark(a)}<span class="visually-hidden">to itself</span>`)}`
    : `${from} ${glueFirst(`${arrowMark(a)}<span class="visually-hidden">to</span>`, to)}`;
  return `<li class="${cls.join(' ')}" data-index="${a.index}"${current}><span class="row-number"><span class="visually-hidden">Step </span>${a.index + 1}</span><span class="${label}">${esc(a.label)}${selected}</span><span class="row-route">${route}</span></li>`;
}

function renderRows(arrows: readonly Arrow[], names: Readonly<Record<string, string>>): string {
  return arrows.length
    ? `<ol class="rows">${arrows.map((a) => renderRow(a, names)).join('')}</ol>`
    : '';
}

function renderSection(g: Group, names: Readonly<Record<string, string>>): string {
  const cls = ['phase'];
  if (g.current) cls.push('phase--current');
  const current = g.current ? ' data-current=""' : '';
  const takeaway = g.continued
    ? ''
    : `<span class="phase-takeaway">${esc(g.phase.takeaway)}</span>`;
  const caption = g.selected
    ? `<span class="row-label--selected">${esc(g.caption)}</span><span class="visually-hidden">, carries the selected value</span>`
    : esc(g.caption);
  return `<section class="${cls.join(' ')}" data-phase="${esc(g.phase.id)}"${current}><button type="button" class="phase-toggle" data-group="${esc(g.key)}" aria-expanded="${g.expanded}">${takeaway}<span class="phase-caption">${caption}</span></button>${g.expanded ? renderRows(g.arrows, names) : ''}</section>`;
}

/** A stage of the Overview: its sentence, then the parties its events involve. */
function renderStage(s: StageBlock, count: number): string {
  const cls = ['phase', 'stage-item'];
  if (s.current) cls.push('phase--current');
  const current = s.current ? ' data-current="" aria-current="step"' : '';
  return `<li class="${cls.join(' ')}" data-stage="${esc(s.stage.id)}"${current}><span class="visually-hidden">Stage ${s.number} of ${count}: </span><span class="stage-text">${esc(s.stage.sentence)}</span><span class="stage-parties small muted">${esc(s.parties.join(' · '))}</span></li>`;
}

/**
 * The step list for a layout: stages at the Overview, stacked groups at Architecture, rows at
 * Protocol.
 */
export function renderList(
  layout: DiagramLayout,
  title: string,
  names: Readonly<Record<string, string>> = {},
): string {
  const body = layout.stages.length
    ? `<ol class="stages">${layout.stages.map((s) => renderStage(s, layout.stages.length)).join('')}</ol>`
    : layout.groups.length
      ? layout.groups.map((g) => renderSection(g, names)).join('')
      : renderRows(layout.arrows, names);
  return `<div class="step-list" role="group" aria-label="${esc(title)}">${body}</div>`;
}
