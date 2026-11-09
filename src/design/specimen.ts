import '../styles/diagram.css';
import './specimen.css';
import { contrast } from './contrast';

const TOKENS = ['paper', 'ink', 'ink-muted', 'rule', 'accent', 'error'] as const;

const USE: Record<(typeof TOKENS)[number], string> = {
  paper: 'Background',
  ink: 'Text and data',
  'ink-muted': 'Secondary text, past steps, in-process arrows',
  rule: 'Lifelines, axes, separators (never meaning)',
  accent: 'What to look at now: current step, its pair, tracked values',
  error: 'Errors only, always with a text label',
};

/** Default retrieval scores from 05-rag-scenarios.yaml → reference_results.rag-query. */
const SCORES: ReadonlyArray<readonly [string, number]> = [
  ['savings-account · 001', 0.9041],
  ['everyday-account · 001', 0.8824],
  ['everyday-account · 002', 0.8745],
  ['savings-account · 002', 0.8143],
  ['release-notes · 001', 0.648],
  ['release-notes · 002', 0.3505],
  ['balance-api · 001', 0.1321],
];
const TOP_K = 3;
const THRESHOLD = 0.7;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

function swatches(): string {
  const paper = token('paper');
  return TOKENS.map((name) => {
    const value = token(name);
    const ratio = name === 'paper' ? '' : `${contrast(value, paper).toFixed(2)} : 1`;
    return `
      <span class="swatch" style="background: var(--color-${name})"></span>
      <code>${name}</code>
      <span class="small muted">${ratio}</span>
      <span class="small use">${USE[name]}</span>`;
  }).join('');
}

type ArrowKind = 'network' | 'in-process' | 'simulated';
interface Arrow {
  label: string;
  kind: ArrowKind;
  response?: boolean;
  current?: boolean;
  error?: boolean;
}

const ARROWS: Arrow[] = [
  { label: 'MCP · tools/call', kind: 'network' },
  { label: 'MCP · tools/call result', kind: 'network', response: true },
  { label: 'Invoke selected tool', kind: 'in-process' },
  { label: 'Similarity search', kind: 'simulated' },
  { label: 'LLM · submit conversation (current step)', kind: 'network', current: true },
  { label: 'LLM · answer (its pair)', kind: 'network', response: true, current: true },
  {
    label: 'MCP · tool execution error (isError: true)',
    kind: 'network',
    response: true,
    error: true,
  },
];

function arrows(): string {
  const left = 40;
  const right = 600;
  const rowHeight = 48;
  const top = 40;
  const height = top + ARROWS.length * rowHeight;
  const rows = ARROWS.map((a, i) => {
    const y = top + i * rowHeight + 32;
    const [x1, x2] = a.response ? [right, left] : [left, right];
    const classes = ['arrow', `arrow--${a.kind}`];
    if (a.current) classes.push('arrow--current');
    if (a.error) classes.push('arrow--error');
    const head = a.response ? 'url(#head-response)' : 'url(#head-request)';
    const labelX = a.response ? right - 8 : left + 8;
    const anchor = a.response ? 'end' : 'start';
    const labelClass = a.error ? 'arrow-label arrow-label--error' : 'arrow-label';
    return `
      <line class="${classes.join(' ')}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-end="${head}" />
      <text class="${labelClass}" x="${labelX}" y="${y - 8}" text-anchor="${anchor}">${a.label}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 640 ${height}" role="img" aria-label="Arrow encoding: one arrow of each kind">
      <defs>
        <marker id="head-request" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path class="head--request" d="M0,1 L10,5 L0,9 z" />
        </marker>
        <marker id="head-response" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path class="head--response" d="M0,1 L10,5 L0,9" />
        </marker>
      </defs>
      <line class="lifeline" x1="${left}" y1="24" x2="${left}" y2="${height}" />
      <line class="lifeline" x1="${right}" y1="24" x2="${right}" y2="${height}" />
      <text class="participant" x="${left}" y="16" text-anchor="middle">client</text>
      <text class="participant" x="${right}" y="16" text-anchor="middle">server</text>
      ${rows}
    </svg>`;
}

function scorePlot(): string {
  const labelWidth = 200;
  const plotLeft = labelWidth + 16;
  const plotWidth = 360;
  const rowHeight = 24;
  const top = 8;
  const axisY = top + SCORES.length * rowHeight + 8;
  const x = (score: number) => plotLeft + score * plotWidth;
  const ranked = SCORES.filter(([, s]) => s >= THRESHOLD).slice(0, TOP_K);
  const rows = SCORES.map(([name, score], i) => {
    const y = top + i * rowHeight + 12;
    const retained = ranked.some(([n]) => n === name);
    return `
      <text class="plot-label${retained ? '' : ' plot-label--muted'}" x="${labelWidth}" y="${y + 4}" text-anchor="end">${name}</text>
      <circle class="dot${retained ? ' dot--retained' : ''}" cx="${x(score)}" cy="${y}" r="4" />
      <text class="plot-label plot-label--muted" x="${x(score) + 10}" y="${y + 4}">${score.toFixed(2)}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 640 ${axisY + 40}" role="img" aria-label="Retrieval scores as dots on a 0 to 1 scale">
      ${rows}
      <line class="axis" x1="${plotLeft}" y1="${axisY}" x2="${x(1)}" y2="${axisY}" />
      <line class="threshold" x1="${x(THRESHOLD)}" y1="${top}" x2="${x(THRESHOLD)}" y2="${axisY}" />
      <text class="plot-label plot-label--muted" x="${plotLeft}" y="${axisY + 20}" text-anchor="middle">0</text>
      <text class="plot-label plot-label--muted" x="${x(THRESHOLD)}" y="${axisY + 20}" text-anchor="middle">threshold 0.7</text>
      <text class="plot-label plot-label--muted" x="${x(1)}" y="${axisY + 20}" text-anchor="middle">1</text>
      <text class="plot-label" x="${plotLeft}" y="${axisY + 36}">cosine similarity to the question · top 3 retained</text>
    </svg>`;
}

const PAYLOAD = `{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_customer_balance",
    "arguments": { "customerId": <span class="tracked">"123"</span> },
    <button class="fold" type="button" aria-label="Show _meta">"_meta": { … protocol version, client info, capabilities }</button><span class="fold-body" hidden>"_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "agentscope-demo", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }</span>
  }
}`;

export function renderSpecimen(root: HTMLElement): void {
  root.className = 'page specimen';
  root.innerHTML = `
    <h1>Design system</h1>
    <p class="lead">Every element must carry information; anything that does not is removed.
      Grey carries structure, one accent marks what to look at now, and red means an error.</p>

    <section aria-labelledby="type">
      <h2 id="type">Type</h2>
      <div class="type-sample">
        <span class="small muted">title 24/32</span><span class="title">The agent asks the MCP client to call the tool</span>
        <span class="small muted">text 16/24</span><span>The model never calls the server itself; it asks the agent to run the tool.</span>
        <span class="small muted">small 13/16</span><span class="small">mcp-client → mcp-server · tools/call · 1 234.56</span>
        <span class="small muted">code 13/16</span><code>MCP-Protocol-Version: 2026-07-28</code>
      </div>
    </section>

    <section aria-labelledby="colour">
      <h2 id="colour">Colour</h2>
      <div class="swatches">${swatches()}</div>
    </section>

    <section aria-labelledby="arrows">
      <h2 id="arrows">Arrows</h2>
      <p class="small muted">Solid: network. Thin grey: in-process. Dashed: simulated internal step.
        Filled head: request. Open head: response.</p>
      <div class="figure">${arrows()}</div>
    </section>

    <section aria-labelledby="payload">
      <h2 id="payload">Payload</h2>
      <p class="small muted">Boilerplate folds to one line and expands on click; tracked values are underlined.</p>
      <pre class="payload">${PAYLOAD}</pre>
    </section>

    <section aria-labelledby="scores">
      <h2 id="scores">Scores</h2>
      <div class="figure">${scorePlot()}</div>
    </section>
  `;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.fold')) {
    const body = button.nextElementSibling as HTMLElement | null;
    button.addEventListener('click', () => {
      if (!body) return;
      button.hidden = true;
      body.hidden = false;
    });
  }
}
