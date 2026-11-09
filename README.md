# agentscope

AgentScope is an interactive learning tool that reveals what happens behind AI-powered applications. Explore MCP, RAG, and agent workflows through executable sequence diagrams, inspect every request and response, and follow how data and context flow between LLMs, tools, and external systems. From prompt to response, understand every interaction.

## Development

Requires Node.js 22.12 or later and Python 3 (for spec validation).

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
