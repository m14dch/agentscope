# agentscope
AgentScope is an interactive learning tool that reveals what happens behind AI-powered applications. Explore MCP, RAG, and agent workflows through executable sequence diagrams, inspect every request and response, and follow how data and context flow between LLMs, tools, and external systems.  From prompt to response, understand every interaction.

## Specifications

The design lives in [`specifications/`](specifications/) as YAML:

| File | Contents |
| --- | --- |
| `00-product.yaml` | Audience, learning outcomes, constraints, shared Example Bank domain, primary questions |
| `01-architecture.yaml` | Runtime, modules, participant registry, boundaries, deployment |
| `02-ui-ux.yaml` | Layout, diagram, controls, inspectors, RAG controls |
| `03-simulation-engine.yaml` | Event, phase, variant and composition formats; invariants |
| `04-mcp-scenarios.yaml` | MCP balance trace and variants, pinned to MCP revision 2026-07-28 |
| `05-rag-scenarios.yaml` | RAG fixtures, demo embedding algorithm, scenarios, variants and reference results |
| `06-comparison-scenarios.yaml` | Compare phase mapping and the Combined scenario |
| `07-security-protocols.yaml` | MCP validation rules, trust boundaries, error taxonomy |
| `08-acceptance-tests.yaml` | Delivery phases, unit and end-to-end tests, definition of done |

### Validate the specifications

The validator expands every variant and the Combined composition, checks all cross-references and invariants,
validates every MCP payload against the official schema, and recomputes all RAG vectors, scores, selections and
answers from the fixtures.

```bash
pip install pyyaml jsonschema
```

```bash
curl -sSLo /tmp/mcp-schema.json https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.json
```

```bash
python3 specifications/tools/validate_specs.py --mcp-schema /tmp/mcp-schema.json
```
