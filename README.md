# agentscope

AgentScope is an interactive learning tool that reveals what happens behind AI-powered applications. Explore MCP, RAG, and agent workflows through executable sequence diagrams, inspect every request and response, and follow how data and context flow between LLMs, tools, and external systems. From prompt to response, understand every interaction.

**Live:** https://m14dch.github.io/agentscope/

## Development

Requires Node.js 22.18 or later and Python 3 (for spec validation).

```bash
npm ci
```

```bash
npm run dev
```

| Command                  | What it does                                                           |
| ------------------------ | ---------------------------------------------------------------------- |
| `npm run dev`            | Start the development server                                           |
| `npm run build`          | Type-check and build the static site into `dist/`                      |
| `npm run preview`        | Serve `dist/` under the base path at http://localhost:4173/agentscope/ |
| `npm test`               | Unit tests (Vitest)                                                    |
| `npm run test:e2e`       | Browser tests (Playwright); fail on any request outside the app        |
| `npm run validate:specs` | Validate the specifications (needs the Python requirements below)      |
| `npm run check`          | Everything CI runs except the build and browser tests                  |

Locally, `npm run test:e2e` builds first and then serves `dist/`. If a preview server is already running on port 4173, the tests reuse it, so stop it first if it serves an older build.

The site is served under `/agentscope/` by default. Set `AGENTSCOPE_BASE=/` to build for a root site.

## Design rules

[`specifications/design-handover.md`](specifications/design-handover.md) sets the direction:
Principiae (Jean-luc Doumont, _Trees, maps, and theorems_) decides how information is communicated,
Sanzo Wada's Color Combination No. 303 decides how it looks. The governing rule is to **maximise the
signal-to-noise ratio**: anything that carries no information is removed. The concrete rules (grid,
type, colour tokens and contrast, charts, motion, writing) are in `specifications/02-ui-ux.yaml` →
`design`; the live specimen at [`#/design`](https://m14dch.github.io/agentscope/#/design) shows them
in use.

- Deep Slate Olive carries text and data on a cream page, Neutral Gray carries structure only,
  Peach Red marks the current step, Naples Yellow marks what the learner selected or tracks, and
  errors always carry a × and a label naming the kind. Colour is never the only signal.
- Colours exist only as tokens in `src/styles/tokens.css`. A unit test fails on hex values or
  colour functions anywhere else in `src/`, `public/` or `index.html`, and on tokens that differ
  from the spec or miss its contrast rules. A browser test fails if any colour the rendered pages
  actually use is not a token.
- Label data directly; no legends, shadows, gradients, rounded cards or decorative icons.
- Font licences ship with the site in `public/licenses/fonts.txt`.

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`: all CI checks, a build with the base path from
the repository's Pages settings, deployment to GitHub Pages, then `scripts/check-deployment.ts`, which
fails the workflow if the live page or any asset it references does not load. The repository's Pages
source must be **GitHub Actions**. A deployment can also be started by hand from the Actions tab; only `main` deploys. Each build carries
`<meta name="agentscope-version">` with its commit SHA, so the check also detects a stale deployment.

To check the live site yourself (add `--expect-version` with a commit SHA to require that exact build):

```bash
node scripts/check-deployment.ts https://m14dch.github.io/agentscope/
```

A local build is stamped `dev`; with `npm run preview` running:

```bash
node scripts/check-deployment.ts http://localhost:4173/agentscope/ --expect-version dev
```

## Specifications

The design lives in [`specifications/`](specifications/) as YAML:

| File                           | Contents                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `00-product.yaml`              | Audience, learning outcomes, constraints, shared Example Bank domain, primary questions |
| `01-architecture.yaml`         | Runtime, modules, participant registry, boundaries, deployment                          |
| `02-ui-ux.yaml`                | Layout, diagram, controls, inspectors, RAG controls                                     |
| `03-simulation-engine.yaml`    | Event, phase, variant and composition formats; invariants                               |
| `04-mcp-scenarios.yaml`        | MCP balance trace and variants, pinned to MCP revision 2026-07-28                       |
| `05-rag-scenarios.yaml`        | RAG fixtures, demo embedding algorithm, scenarios, variants and reference results       |
| `06-comparison-scenarios.yaml` | Compare phase mapping and the Combined scenario                                         |
| `07-security-protocols.yaml`   | MCP validation rules, trust boundaries, error taxonomy                                  |
| `08-acceptance-tests.yaml`     | Delivery phases, unit and end-to-end tests, definition of done                          |

### Validate the specifications

The validator expands every variant and the Combined composition, checks all cross-references and invariants,
validates every MCP payload against the official schema (vendored in `specifications/tools/`), and recomputes
all RAG vectors, scores, selections and answers from the fixtures.

```bash
python3 -m venv .venv
```

```bash
. .venv/bin/activate
```

```bash
pip install -r specifications/tools/requirements.txt
```

```bash
npm run validate:specs
```

### How the app uses the specifications

The YAML is the single source of scenario data. At build time, a Vite plugin
([`scripts/vite-scenarios.ts`](scripts/vite-scenarios.ts)) parses it into a bundled JSON module; nothing generated
is committed. The app expands the variants and the Combined composition and validates every event at startup
([`src/scenarios/`](src/scenarios/)). Any invalid event fails the build with an error naming its scenario and event,
for example `mcp-balance/mcp-11: participant nobody not declared`.

A golden test checks that the TypeScript registry equals the Python validator's (`--dump-registry`), so the unit
tests also need the Python requirements.
