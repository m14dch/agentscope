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

/** The selection background behind a line of 13 px text whose baseline is at y. */
function markRect(x: number, y: number, width: number): string {
  return `<rect class="label-mark" x="${x - 2}" y="${y - 12}" width="${width + 4}" height="16" />`;
}

function renderArrow(a: Arrow, ids: string, names: Readonly<Record<string, string>>): string {
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
  const name = `Step ${a.index + 1}: ${names[e.sender] ?? e.sender} to ${names[e.receiver] ?? e.receiver}, ${a.label}`;
  const current = a.visibility === 'current' ? ' data-current=""' : '';
  // The selected lineage value: selection background behind the label, ink underline on it.
  if (a.selected) label.push('arrow-label--selected');
  const mark = a.selected ? markRect(a.labelX, a.labelY, a.labelWidth) : '';
  const selected = a.selected ? ', carries the selected value' : '';
  return `<g class="step" data-index="${a.index}"${current} role="listitem" aria-label="${esc(name + selected)}">${shape}${mark}<text class="${label.join(' ')}" x="${a.labelX}" y="${a.labelY}">${esc(a.label)}</text></g>`;
}

function renderGroup(g: Group, ids: string, names: Readonly<Record<string, string>>): string {
  const cls = ['group'];
  if (g.current) cls.push('group--current');
  const textX = g.x1 + 2 * SIZES.groupPad;
  const lines = g.takeaway
    .map((t, i) => `<tspan x="${textX}" dy="${i === 0 ? 0 : SIZES.headerLine}">${esc(t)}</tspan>`)
    // A space between the lines, so the text reads as words to assistive technology.
    .join(' ');
  const firstLine = g.y + SIZES.groupPad + 12;
  const captionY = firstLine + g.takeaway.length * SIZES.headerLine;
  const bar = g.current
    ? `<rect class="group-bar" x="${g.x1}" y="${g.y}" width="3" height="${g.height}" />`
    : '';
  const current = g.current ? ' data-current=""' : '';
  // Paper behind the takeaway and caption, so lifelines do not run through the text.
  const textTop = g.y + SIZES.groupPad;
  const band = `<rect class="group-text-band" x="${textX - 4}" y="${textTop}" width="${g.textWidth + 8}" height="${captionY + 4 - textTop}" />`;
  const error = g.error ? `<tspan class="group-error"> · × ${esc(g.error)} error</tspan>` : '';
  const takeaway = g.takeaway.length
    ? `<text class="group-takeaway" x="${textX}" y="${firstLine}">${lines}</text>`
    : '';
  // The name is the visible text in reading order (WCAG 2.5.3 label in name): the takeaway,
  // then the caption without its fold mark (aria-expanded states it), then the error.
  const name = [
    g.takeaway.join(' '),
    `${g.caption.replace(/^[▸▾] /, '')}${g.error ? ` · × ${g.error} error` : ''}`,
  ]
    .filter(Boolean)
    .join(' ');
  const steps = g.arrows.length
    ? `<g role="list" aria-label="${esc(g.phase.label)} steps">${g.arrows.map((a) => renderArrow(a, ids, names)).join('')}</g>`
    : '';
  return `<g class="${cls.join(' ')}" data-group="${esc(g.key)}" data-phase="${esc(g.phase.id)}"${current} role="button" tabindex="0" aria-expanded="${g.expanded}" aria-label="${esc(name)}">
<rect class="group-frame" x="${g.x1}" y="${g.y}" width="${g.x2 - g.x1}" height="${g.height}" />${band}${bar}${takeaway}
${g.selected ? markRect(textX, captionY, g.captionWidth) : ''}<text class="group-label${g.selected ? ' arrow-label--selected' : ''}" x="${textX}" y="${captionY}">${esc(g.caption)}${error}</text>
</g>${steps}`;
}

export function renderSvg(
  layout: DiagramLayout,
  title: string,
  ids = 'diagram',
  names: Readonly<Record<string, string>> = {},
): string {
  const participants = layout.lifelines
    .map((l) => {
      const tspans = l.lines
        .map((t, i) => `<tspan x="${l.x}" dy="${i === 0 ? 0 : SIZES.headerLine}">${esc(t)}</tspan>`)
        .join(' ');
      const y = SIZES.margin + 12;
      return `<text class="participant" role="listitem" text-anchor="middle" x="${l.x}" y="${y}">${tspans}</text>`;
    })
    .join('');
  const lifelines = layout.lifelines
    .map(
      (l) =>
        `<line class="lifeline" x1="${l.x}" y1="${layout.top - 8}" x2="${l.x}" y2="${layout.height}" />`,
    )
    .join('');
  // The participant names are a drawing of their own before the diagram, in an element that
  // sticks to the top of the scroll region (diagram.css), so every lifeline stays named while
  // the region scrolls vertically, and assistive technology meets the names first. Their paper
  // band hides what passes beneath. The diagram continues below them in the same coordinates.
  const head = layout.lifelines.length ? layout.top - 8 : 0;
  const header = head
    ? `<div class="diagram-head" data-header="${head}"><svg class="diagram-participants" width="${layout.width}" height="${head}" viewBox="0 0 ${layout.width} ${head}" role="list" aria-label="Participants"><rect class="participants-band" x="0" y="0" width="${layout.width}" height="${head}" />${participants}</svg></div>`
    : '';
  const height = layout.height - head;
  const body = layout.groups.length
    ? layout.groups.map((g) => renderGroup(g, ids, names)).join('')
    : `<g role="list" aria-label="Steps">${layout.arrows.map((a) => renderArrow(a, ids, names)).join('')}</g>`;
  return `${header}<svg class="diagram" width="${layout.width}" height="${height}" viewBox="0 ${head} ${layout.width} ${height}" role="group" aria-label="${esc(title)}">
<defs>
<marker id="${ids}-request" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--request" d="M 0 0 L 10 5 L 0 10 z" /></marker>
<marker id="${ids}-response" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--response" d="M 0 0 L 10 5 L 0 10" /></marker>
</defs>${lifelines}${body}</svg>`;
}
