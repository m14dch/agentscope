/**
 * Renders a DiagramLayout as SVG markup (02-ui-ux.yaml diagram.encoding). Every text is
 * escaped; colours come from classes in src/styles/diagram.css only.
 */
import { type Arrow, type DiagramLayout, type Group, SIZES } from './model.ts';

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Requests and actions get a filled head; responses and results an open one. */
function head(a: Arrow): 'request' | 'response' {
  return a.event.message_type === 'RESPONSE' || a.event.message_type === 'RESULT'
    ? 'response'
    : 'request';
}

function renderArrow(a: Arrow, ids: string): string {
  const line = ['arrow', `arrow--${a.line}`];
  const label = ['arrow-label'];
  if (a.emphasized) {
    line.push('arrow--current');
    label.push('arrow-label--current');
  } else label.push('arrow-label--past');
  if (a.error) {
    line.push('arrow--error');
    label.push('arrow-label--error');
  }
  const marker = `url(#${ids}-${head(a)})`;
  const { x1, x2, y } = a;
  const shape = a.self
    ? `<path class="${line.join(' ')}" d="M ${x1} ${y} h ${SIZES.selfWidth} v ${SIZES.selfHeight} h ${-SIZES.selfWidth + 2}" marker-end="${marker}" />`
    : `<line class="${line.join(' ')}" x1="${x1}" y1="${y}" x2="${x2 + (x2 > x1 ? -1 : 1)}" y2="${y}" marker-end="${marker}" />`;
  const e = a.event;
  const name = `Step ${a.index + 1}: ${e.sender} to ${e.receiver}, ${a.label}`;
  const current = a.visibility === 'current' ? ' data-current=""' : '';
  return `<g class="step" data-index="${a.index}"${current} role="listitem" aria-label="${esc(name)}">${shape}<text class="${label.join(' ')}" x="${a.labelX}" y="${a.labelY}">${esc(a.label)}</text></g>`;
}

function renderGroup(g: Group, ids: string): string {
  const cls = ['group'];
  if (g.current) cls.push('group--current');
  const textX = g.x1 + 2 * SIZES.groupPad;
  const lines = g.takeaway
    .map((t, i) => `<tspan x="${textX}" dy="${i === 0 ? 0 : SIZES.headerLine}">${esc(t)}</tspan>`)
    .join('');
  const firstLine = g.y + SIZES.groupPad + 12;
  const labelY = firstLine + g.takeaway.length * SIZES.headerLine;
  const bar = g.current
    ? `<rect class="group-bar" x="${g.x1}" y="${g.y}" width="3" height="${g.height}" />`
    : '';
  const current = g.current ? ' data-current=""' : '';
  const name = `${g.phase.label}: ${g.phase.takeaway}`;
  return `<g class="${cls.join(' ')}" data-phase="${esc(g.phase.id)}"${current} role="button" tabindex="0" aria-expanded="${g.expanded}" aria-label="${esc(name)}">
<rect class="group-frame" x="${g.x1}" y="${g.y}" width="${g.x2 - g.x1}" height="${g.height}" />${bar}
<text class="group-takeaway" x="${textX}" y="${firstLine}">${lines}</text>
<text class="group-label" x="${textX}" y="${labelY}">${esc(g.caption)}</text>
</g><g role="list" aria-label="${esc(g.phase.label)} steps">${g.arrows.map((a) => renderArrow(a, ids)).join('')}</g>`;
}

export function renderSvg(layout: DiagramLayout, title: string, ids = 'diagram'): string {
  const participants = layout.lifelines
    .map((l) => {
      const tspans = l.lines
        .map((t, i) => `<tspan x="${l.x}" dy="${i === 0 ? 0 : SIZES.headerLine}">${esc(t)}</tspan>`)
        .join('');
      const y = SIZES.margin + 12;
      return `<text class="participant" text-anchor="middle" x="${l.x}" y="${y}">${tspans}</text><line class="lifeline" x1="${l.x}" y1="${layout.top - 8}" x2="${l.x}" y2="${layout.height}" />`;
    })
    .join('');
  const body = layout.groups.length
    ? layout.groups.map((g) => renderGroup(g, ids)).join('')
    : `<g role="list" aria-label="Steps">${layout.arrows.map((a) => renderArrow(a, ids)).join('')}</g>`;
  return `<svg class="diagram" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="${esc(title)}">
<defs>
<marker id="${ids}-request" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--request" d="M 0 0 L 10 5 L 0 10 z" /></marker>
<marker id="${ids}-response" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--response" d="M 0 0 L 10 5 L 0 10" /></marker>
</defs>${participants}${body}</svg>`;
}
