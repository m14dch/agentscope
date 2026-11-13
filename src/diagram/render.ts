/**
 * Renders a DiagramLayout as SVG markup (02-ui-ux.yaml diagram.encoding). Every text is
 * escaped; colours come from classes in src/styles/diagram.css only.
 */
import { type Arrow, type DiagramLayout, type Group, SIZES, type StageBlock } from './model.ts';

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

/** The words that state an arrow's state in its name (02 diagram.visibility.accessible_name). */
const STATE_WORD = { past: 'done', current: 'current', future: 'upcoming' } as const;

/**
 * One arrow: a list item holding a button that moves the cursor to its step (02
 * diagram.arrow_activation). Its line and label carry the classes of its state; the current
 * step's pair, once played, carries the current ones (02 diagram.visibility.classes). Every
 * button starts outside the tab order; the view makes one of them the tab stop.
 */
function renderArrow(a: Arrow, ids: string, names: Readonly<Record<string, string>>): string {
  const state = a.emphasized ? 'current' : a.visibility;
  const line = ['arrow', `arrow--${a.line}`, `arrow--${state}`];
  const label = ['arrow-label', `arrow-label--${state}`];
  const marker = `url(#${ids}-${head(a)})`;
  const { x1, x2, y } = a;
  const shape = a.self
    ? `<path class="${line.join(' ')}" d="M ${x1} ${y} h ${SIZES.selfWidth} v ${SIZES.selfHeight} h ${-SIZES.selfWidth + 2}" marker-end="${marker}" />`
    : `<line class="${line.join(' ')}" x1="${x1}" y1="${y}" x2="${x2 + (x2 > x1 ? -1 : 1)}" y2="${y}" marker-end="${marker}" />`;
  const e = a.event;
  const name = `Step ${a.index + 1}, ${STATE_WORD[a.visibility]}: ${names[e.sender] ?? e.sender} to ${names[e.receiver] ?? e.receiver}, ${a.label}`;
  const current = a.visibility === 'current';
  const b = a.box;
  const target = `<rect class="step-target" x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" />`;
  return `<g class="step step--${a.visibility}" data-index="${a.index}"${current ? ' data-current=""' : ''} role="listitem"><g class="step-button" role="button" tabindex="-1" aria-label="${esc(name)}"${current ? ' aria-current="step"' : ''}>${target}${shape}<text class="${label.join(' ')}" x="${a.labelX}" y="${a.labelY}">${esc(a.label)}</text></g></g>`;
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
  const takeaway = g.takeaway.length
    ? `<text class="group-takeaway" x="${textX}" y="${firstLine}">${lines}</text>`
    : '';
  // The name is the visible text in reading order (WCAG 2.5.3 label in name): the takeaway,
  // then the caption without its fold mark (aria-expanded states it).
  const name = [g.takeaway.join(' '), g.caption.replace(/^[▸▾] /, '')].filter(Boolean).join(' ');
  const steps = g.arrows.length
    ? `<g role="list" aria-label="${esc(g.phase.label)} steps">${g.arrows.map((a) => renderArrow(a, ids, names)).join('')}</g>`
    : '';
  return `<g class="${cls.join(' ')}" data-group="${esc(g.key)}" data-phase="${esc(g.phase.id)}"${current} role="button" tabindex="0" aria-expanded="${g.expanded}" aria-label="${esc(name)}">
<rect class="group-frame" x="${g.x1}" y="${g.y}" width="${g.x2 - g.x1}" height="${g.height}" />${band}${bar}${takeaway}
<text class="group-label" x="${textX}" y="${captionY}">${esc(g.caption)}</text>
</g>${steps}`;
}

/** A stage of the Overview: its frame, the accent bar when current, and its sentence. */
function renderStage(s: StageBlock, count: number): string {
  const cls = ['stage'];
  if (s.current) cls.push('stage--current');
  const textX = s.x1 + 2 * SIZES.groupPad;
  const first = s.y + SIZES.groupPad + SIZES.stageFont;
  const lines = s.sentence
    .map((t, i) => `<tspan x="${textX}" dy="${i === 0 ? 0 : SIZES.stageLine}">${esc(t)}</tspan>`)
    .join(' ');
  const bar = s.current
    ? `<rect class="group-bar" x="${s.x1}" y="${s.y}" width="3" height="${s.height}" />`
    : '';
  // Paper behind the sentence, so lifelines pass under it rather than through it.
  const band = `<rect class="group-text-band" x="${textX - 4}" y="${s.y + SIZES.groupPad}" width="${s.textWidth + 8}" height="${s.sentence.length * SIZES.stageLine}" />`;
  const current = s.current ? ' data-current="" aria-current="step"' : '';
  const name = `Stage ${s.number} of ${count}: ${s.sentence.join(' ')} ${s.parties.join(', ')}.`;
  return `<g class="${cls.join(' ')}" data-stage="${esc(s.stage.id)}"${current} role="listitem" aria-label="${esc(name)}"><rect class="group-frame stage-frame" x="${s.x1}" y="${s.y}" width="${s.x2 - s.x1}" height="${s.height}" />${band}${bar}<text class="stage-sentence" x="${textX}" y="${first}">${lines}</text></g>`;
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
    ? `<div class="diagram-head" data-header="${head}"><svg class="diagram-participants" width="${layout.width}" height="${head}" viewBox="0 0 ${layout.width} ${head}" role="list" aria-label="${layout.stages.length ? 'Parties' : 'Participants'}"><rect class="participants-band" x="0" y="0" width="${layout.width}" height="${head}" />${participants}</svg></div>`
    : '';
  const height = layout.height - head;
  const body = layout.stages.length
    ? `<g role="list" aria-label="Stages">${layout.stages.map((s) => renderStage(s, layout.stages.length)).join('')}</g>`
    : layout.groups.length
      ? layout.groups.map((g) => renderGroup(g, ids, names)).join('')
      : `<g role="list" aria-label="Steps">${layout.arrows.map((a) => renderArrow(a, ids, names)).join('')}</g>`;
  return `${header}<svg class="diagram" width="${layout.width}" height="${height}" viewBox="0 ${head} ${layout.width} ${height}" role="group" aria-label="${esc(title)}">
<defs>
<marker id="${ids}-request" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--request" d="M 0 0 L 10 5 L 0 10 z" /></marker>
<marker id="${ids}-response" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="head--response" d="M 0 0 L 10 5 L 0 10" /></marker>
</defs>${lifelines}${body}</svg>`;
}
