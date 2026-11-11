# agentscope

AgentScope is an interactive learning tool that reveals what happens behind AI-powered applications. Explore MCP, RAG, and agent workflows through executable sequence diagrams, inspect every request and response, and follow how data and context flow between LLMs, tools, and external systems. From prompt to response, understand every interaction.

**Live:** https://m14dch.github.io/agentscope/

## What it teaches

AgentScope is for experienced software engineers who are new to AI integration. Every scenario is a
deterministic simulation of one question to Example Bank's assistant; nothing calls a real model, server or
bank, and the page says so. Each scenario states its learning question and its message, then lets you step
through it: an optional prediction before a step, the step highlighted in a sequence diagram, one sentence
explaining it, and the exact payloads on demand.

- **MCP** — "What is the current balance of my bank account?" Server discovery, tool listing and
  `tools/call` over MCP revision 2026-07-28 with the headers mirrored from the body; the model only requests
  a tool and the agent runs it; the MCP server, not MCP itself, reads the bank's REST API. Scenario:
  `mcp-balance`.
- **RAG** — "What are the conditions for opening and maintaining a bank account?" Ingestion (chunks,
  overlap, vectors), retrieval (scores against top K and the threshold, a 2D projection), the prompt before
  and after retrieval, and an answer whose every statement cites its chunk. Scenarios: `rag-query` (the
  question) and `rag-index` (building the index it searches), chosen from the tab's scenario menu; top K, the
  threshold, keyword retrieval, reranking and full documents change the retrieval in place.
- **Compare** — both flows side by side, kept on the same semantic phase, and where they differ: data
  source, freshness, model-visible context, actions vs retrieval, trust boundaries.
- **Combined** — one answer that takes the balance from an MCP tool and the account terms from retrieved
  documents, each statement labelled with its source. Scenario: `combined-balance-explanation`.

Two modes show the same step at two levels: **Architecture** groups each phase under its takeaway;
**Protocol** shows every event. The inspector holds Payload, Transport, Security and Lineage; the **Model
context** panel puts the agent's state beside what the model has actually seen. On a phone the diagram
becomes a step list and the controls move to a bar at the bottom of the screen. After the first visit the
site works offline.

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

Locally, `npm run test:e2e` builds first and then serves `dist/`. If a preview server is already running on port 4173, the tests reuse it, so stop it first if it serves an older build. Besides external requests, the browser tests fail on any same-origin request for something that is not a file of the build (a runtime API request).

The site is served under `/agentscope/` by default. Set `AGENTSCOPE_BASE=/` to build for a root site.

The browser tests (one spec file per area in `tests/e2e/`) cover the end-to-end tests of
`specifications/08-acceptance-tests.yaml`, including an accessibility scan with axe-core (`a11y.spec.ts`,
which fails on any serious or critical finding), a keyboard-only walk through every tab, reduced motion and
the event quality gate (`quality.spec.ts`). axe runs inside the page, so it needs no network and sends no
request.

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
- The approved silver-reticle wordmark and favicon live in `public/brand/`
  (`agentscope-silver-{light,dark,favicon}.svg`). The header shows the light wordmark (the app is light
  only); `index.html` declares the favicon. Both resolve against the base path and are precached. These three
  files are the only exception to the colour-token rule: they keep their own colours and the source scan skips
  exactly them. Do not edit them.
- Keyboard: → next, ← previous, Space plays or pauses, wherever the focused control does not need the key
  itself. Every control shows a 2 px accent focus outline (a diagram group: a 2 px ink frame). With reduced
  motion nothing animates. Code wraps instead of scrolling at 200% zoom.

### Known issues

- The approved wordmark (`public/brand/agentscope-silver-light.svg`) sets its lettering as SVG `<text>` in
  Helvetica or Arial. Where neither font is installed, a wider fallback font can clip the lettering. The fix
  belongs to the asset owner (convert the lettering to paths); the app does not modify the brand files.

## Deployment

One workflow, `.github/workflows/ci.yml`, runs on pull requests, pushes to `main` and manual dispatch. It
validates the specifications, lints, runs the unit tests, builds `dist/` once and runs the browser tests against
that build. On `main` (a push, or a run started by hand from the Actions tab) it then deploys exactly that tested
`dist/` to GitHub Pages and runs `scripts/check-deployment.ts`, which fails the workflow if the live page, any
asset it references, the service worker or any file of the asset manifest does not load, or a listed file does
not match its integrity digest. Pull requests and runs from other branches never deploy. Deployable runs take
the base path from the repository's Pages settings; other runs build for `/agentscope/`. The repository's Pages
source must be **GitHub Actions**. Each CI build carries `<meta name="agentscope-version">` with its commit SHA, so
the check also detects a stale deployment.

### Offline

The build writes `dist/asset-manifest.json` (every file of the build with its integrity digest, the version
stamp and a content hash) and generates `dist/sw.js` from `src/offline/sw.js` with that manifest inlined. On
HTTPS or localhost the page registers it for the base path. It precaches the whole build into one cache per
build, checking every file against its digest, so a stale file from the CDN fails the install and the browser
tries again later. It keeps the previous build's cache for tabs still running it, deletes only this app's older
caches for the same scope, and serves the app from the cache on reload. Once the cache is complete the header
says "Available offline." The first load after a deployment still shows the previous build while the new one
installs; the next load shows the current one, without an update notice. The development server registers no
service worker. In Chrome DevTools, Application → Service workers → Unregister (or a private window) starts
from a clean state.

### Checking a deployment

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
| `03-simulation-engine.yaml`    | Event, phase and composition formats; invariants                                        |
| `04-mcp-scenarios.yaml`        | MCP balance trace, pinned to MCP revision 2026-07-28                                    |
| `05-rag-scenarios.yaml`        | RAG fixtures, demo embedding algorithm, scenarios and reference results                 |
| `06-comparison-scenarios.yaml` | Compare phase mapping and the Combined scenario                                         |
| `07-security-protocols.yaml`   | MCP validation rules, trust boundaries, error taxonomy                                  |
| `08-acceptance-tests.yaml`     | Delivery phases, unit and end-to-end tests, definition of done                          |

### Validate the specifications

The validator expands the Combined composition, checks all cross-references and invariants,
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
is committed. The app expands the Combined composition and validates every event at startup
([`src/scenarios/`](src/scenarios/)). Any invalid event fails the build with an error naming its scenario and event,
for example `mcp-balance/mcp-11: participant nobody not declared`.

A golden test checks that the TypeScript registry equals the Python validator's (`--dump-registry`), so the unit
tests also need the Python requirements.

### Extend a scenario

Each use case has exactly one scenario (`03-simulation-engine.yaml` → `one_scenario_per_use_case`): `mcp-balance`,
`rag-query` with `rag-index`, and the Combined scenario. Scenarios are data, so none of this needs code.

1. **One more thing to teach** about an existing step goes into that step: one sentence in its `explanation` or
   its `technical_notes`. The tools/call result, for example, names the three failure kinds, and the prompt
   assembly names prompt injection. What a RAG parameter shows (no match, keyword retrieval, reranking, full
   documents) is reached with the parameter, and its reference result goes under `reference_results` in
   `05-rag-scenarios.yaml` as a `rag-query-…` case with its `parameters`.
2. **A new use case** is a new scenario under `scenarios:` in `04-mcp-scenarios.yaml` and appears in the MCP
   tab; a tab with more than one scenario shows a scenario menu. It needs a `learning_question` ending with
   "?", a one-sentence `headline`, `participants` from the registry in `01-architecture.yaml`, `phases` each
   with a `label`, a `takeaway` and a `semantic_phase` (Compare syncs on it), and `events` in the format of
   `03-simulation-engine.yaml` (sender, receiver, operation, protocol, transport, message type, a one-sentence
   `explanation`, `pair_id` and `correlation_id` for request/response pairs, `security_boundaries` from
   `07-security-protocols.yaml`, optionally a `prediction` whose prompt ends with "?"). MCP payloads must
   validate against the pinned schema. The RAG tab lists `rag-query` and `rag-index` only.
3. Run `npm run validate:specs`, `npm test` (the golden test compares the Python and TypeScript registries)
   and `npm run build`; an invalid event fails the build with an error naming its scenario and event. Update
   the counts the unit tests pin (scenarios and events) and the scenario lists of the browser tests that
   enumerate scenarios (`diagram.spec.ts`, `phone.spec.ts`, `quality.spec.ts`).
4. Write for the learner: each step's explanation is its message in one sentence, and model output is
   labelled as simulated.

## Acceptance checklist (v1.0)

Every item of `specifications/08-acceptance-tests.yaml` → `quality_gates` and `definition_of_done`, with the
test or evidence that proves it. CI runs all of them on every pull request.

| Item                                                        | Evidence                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At least 80 events, played at the default parameters        | `tests/unit/rag.test.ts` (quality gate of supported events); `quality.spec.ts` steps through every scenario with the arrow key: 83 events, 95% of steps within 100 ms              |
| Desktop and tablet                                          | `diagram.spec.ts` (labels at desktop and tablet width), `compare.spec.ts` (panes stack at tablet width), `quality.spec.ts` (keyboard at 1440 and 820 px), `a11y.spec.ts` at 820 px |
| Phone                                                       | `phone.spec.ts` (phone-layout at 390 × 844 and 360 × 800), `a11y.spec.ts` at 390 px                                                                                                |
| Keyboard navigation                                         | `quality.spec.ts` (Tab reaches every control on every tab with a visible focus; keys and Enter step), `navigation.spec.ts`, `diagram.spec.ts`, `inspector.spec.ts`                 |
| Reduced motion                                              | `quality.spec.ts` (nothing animates, diagram regions jump at once), `diagram.spec.ts`                                                                                              |
| Scenario schema validation                                  | `npm run validate:specs`; `tests/unit/node/scenarios-build.test.ts` (a broken event fails the build), `scenarios-golden.test.ts`                                                   |
| Zero runtime API and external requests                      | `tests/e2e/fixtures.ts` fails every browser test on either; `guard.spec.ts` proves the guard catches both                                                                          |
| Offline reload after precache                               | `offline.spec.ts` (offline and pages)                                                                                                                                              |
| Static build and source delivered                           | This repository; CI builds `dist/` and deploys it to Pages; release v1.0.0                                                                                                         |
| README includes run and extend instructions                 | Development; Extend a scenario                                                                                                                                                     |
| All primary scenarios deterministic and executable          | `navigation.spec.ts` (deterministic snapshots), `mcp.spec.ts`, `rag.spec.ts`, `combined.spec.ts`, `tests/unit/engine.test.ts`                                                      |
| All protocol examples validated against the pinned revision | `npm run validate:specs` validates every MCP payload against `specifications/tools/mcp-schema-2026-07-28.json` in CI, and the golden tests run the validator                       |
| No fictional model output represented as real inference     | The header statement on every page (`navigation.spec.ts`); every model response, tool-call requests included, labelled "Simulated model output" (`tests/unit/scenarios.test.ts`)   |
| GitHub Pages workflow deploys the Vite dist artifact        | `.github/workflows/ci.yml`, `scripts/check-deployment.ts` (`tests/unit/deployment-check.test.ts`)                                                                                  |
| Production build runs offline after precache                | `offline.spec.ts`, `tests/unit/node/offline.test.ts`                                                                                                                               |
| No runtime backend, API keys or external services           | A static `dist/`; the request guard of every browser test                                                                                                                          |
| No serious or critical accessibility issue (axe)            | `a11y.spec.ts`: every tab, representative scenarios and steps, both modes, at 1440, 820 and 390 px, with panels and menus open                                                     |
