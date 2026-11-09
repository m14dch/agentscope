import '../styles/diagram.css';
import './specimen.css';
import { contrast } from './contrast';

const TOKENS = [
  'paper',
  'selection',
  'ink',
  'ink-muted',
  'rule',
  'accent',
  'accent-text',
  'error',
] as const;
type Token = (typeof TOKENS)[number];

/** Backgrounds show the contrast of ink on them; everything else its contrast on paper. */
const BACKGROUNDS: ReadonlySet<Token> = new Set(['paper', 'selection']);

const USE: Record<Token, string> = {
  paper: 'Cream · page',
  selection: 'Naples Yellow · what the learner selected or tracks',
  ink: 'Deep Slate Olive · text and data',
  'ink-muted': 'Secondary text, past-step labels, in-process arrows',
  rule: 'Neutral Gray · lifelines, axes, separators (never text)',
  accent: 'Peach Red · the current step and its pair, retained chunks',
  'accent-text': 'Small text in the accent role',
  error: 'Errors only, always with × and a label',
};

/** Default retrieval scores from 05-rag-scenarios.yaml → reference_results.rag-query. */
const SCORES: ReadonlyArray<readonly [string, number]> = [
  ['account-opening · 001', 0.9761],
  ['everyday-account · 002', 0.9565],
  ['everyday-account · 001', 0.9495],
  ['account-opening · 002', 0.9232],
  ['savings-account · 001', 0.9078],
  ['savings-account · 002', 0.8938],
  ['release-notes · 001', 0.3723],
];
const TOP_K = 5;
const THRESHOLD = 0.7;

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();
}

function swatches(): string {
  const paper = token('paper');
  const ink = token('ink');
  return TOKENS.map((name) => {
    const value = token(name);
    const ratio = BACKGROUNDS.has(name)
      ? `ink ${contrast(ink, value).toFixed(2)} : 1`
      : `${contrast(value, paper).toFixed(2)} : 1`;
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
  state?: 'past' | 'current';
  error?: boolean;
}

const ARROWS: Arrow[] = [
  { label: 'MCP · tools/list', kind: 'network', state: 'past' },
  { label: 'MCP · tools/call', kind: 'network' },
  { label: 'MCP · tools/call result', kind: 'network', response: true },
  { label: 'Invoke selected tool', kind: 'in-process' },
  { label: 'Similarity search', kind: 'simulated' },
  { label: 'LLM · submit conversation', kind: 'network', state: 'current' },
  { label: 'LLM · answer', kind: 'network', response: true, state: 'current' },
  {
    label: '× MCP · tool execution error (isError: true)',
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
    const line = ['arrow', `arrow--${a.kind}`];
    const label = ['arrow-label'];
    if (a.state === 'current') line.push('arrow--current');
    if (a.state) label.push(`arrow-label--${a.state}`);
    if (a.error) {
      line.push('arrow--error');
      label.push('arrow-label--error');
    }
    const head = a.response ? 'url(#head-response)' : 'url(#head-request)';
    const labelX = a.response ? right - 8 : left + 8;
    const anchor = a.response ? 'end' : 'start';
    return `
      <line class="${line.join(' ')}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" marker-end="${head}" />
      <text class="${label.join(' ')}" x="${labelX}" y="${y - 8}" text-anchor="${anchor}">${a.label}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 640 ${height}" role="group" aria-label="Arrow examples between a client and a server">
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

function dotPlot(): string {
  const retained = new Set(
    SCORES.filter(([, s]) => s >= THRESHOLD)
      .slice(0, TOP_K)
      .map(([name]) => name),
  );
  const rows = SCORES.map(([name, score]) => {
    const kept = retained.has(name);
    return `
      <li class="${kept ? 'retained' : ''}" style="--x: ${score}">
        <span class="name">${name}</span>
        <span class="track">
          <span class="dot"></span>
          <span class="value">${score.toFixed(2)}${kept ? '<span class="visually-hidden">, retained</span>' : ''}</span>
        </span>
      </li>`;
  }).join('');
  return `
    <ol class="dotplot" style="--threshold: ${THRESHOLD}" aria-label="Retrieval scores, cosine similarity from 0 to 1">
      <li aria-hidden="true">
        <span></span>
        <span class="scale scale--top"><span style="left: ${THRESHOLD * 100}%">threshold ${THRESHOLD}</span></span>
      </li>
      ${rows}
      <li aria-hidden="true">
        <span></span>
        <span class="scale">
          <span style="left: 0">0</span>
          <span style="left: 100%">1</span>
        </span>
      </li>
      <li><span></span><span class="caption">Cosine similarity to the question; the top ${TOP_K} above the threshold are retained.</span></li>
    </ol>`;
}

const META_FOLDED = '{ … protocol version, client info, capabilities }';
const META_FULL = `{
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "agentscope-demo", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }`;

const PAYLOAD = `{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_customer_balance",
    "arguments": { "customerId": <span class="tracked">"123"</span> },
    <button class="fold" type="button" aria-expanded="false" aria-controls="meta-value">"_meta"</button>: <span id="meta-value" class="folded">${META_FOLDED}</span>
  }
}`;

export function renderSpecimen(root: HTMLElement): void {
  root.className = 'page specimen';
  root.innerHTML = `
    <h1>Design system</h1>
    <p class="lead">Every element must carry information; anything that does not is removed.
      Olive carries text and data, grey carries structure, Peach Red marks the current step,
      Naples Yellow marks what you selected, and errors always say so in words.</p>

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
      <p class="small muted note">Solid: network. Thin grey: in-process. Dashed: simulated internal step.
        Filled head: request. Open head: response. Accent line and bold label: the current step and
        its pair. Grey label: a past step.</p>
      <div class="scroller" tabindex="0" role="region" aria-label="Arrow examples, scrolls horizontally">${arrows()}</div>
    </section>

    <section aria-labelledby="payload">
      <h2 id="payload">Payload</h2>
      <p class="small muted note">Boilerplate folds to one line; select its key to expand or fold it.
        Tracked values are highlighted and underlined.</p>
      <pre class="payload">${PAYLOAD}</pre>
    </section>

    <section aria-labelledby="scores">
      <h2 id="scores">Scores</h2>
      ${dotPlot()}
    </section>
  `;
  for (const button of root.querySelectorAll<HTMLButtonElement>('.fold')) {
    const value = root.querySelector<HTMLElement>(`#${button.getAttribute('aria-controls') ?? ''}`);
    button.addEventListener('click', () => {
      if (!value) return;
      const expand = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expand));
      value.textContent = expand ? META_FULL : META_FOLDED;
      value.classList.toggle('folded', !expand);
    });
  }
}
