# AgentScope — Design & UX Handover

Status: Implementation in progress
Purpose: Refine the existing AgentScope application using Principiae’s scientific communication principles and Sanzo Wada’s Color Combination No. 303.

> Source document provided by the project owner. Where it conflicts with earlier specifications, the
> resolution is recorded in `02-ui-ux.yaml` → `design.handover_decisions` and in issue #22.

## 1. Objective

Improve the visual design, usability, and educational effectiveness of AgentScope without restarting or unnecessarily restructuring the existing implementation.

AgentScope is an interactive educational website for experienced technical learners. It explains AI concepts such as Model Context Protocol (MCP) and Retrieval-Augmented Generation (RAG) through guided, inspectable simulations.

The application must remain a static website, compatible with GitHub Pages, without requiring a backend.

Design philosophy:

Principiae determines how information is communicated. Sanzo Wada No. 303 determines how it looks.

The objective is not to create a decorative AI dashboard. It is to build a precise, visually distinctive teaching tool that makes complex technical interactions easier to understand.

## 2. Implementation Instructions

Development has already started. Treat this document as an incremental design and UX refinement, not a replacement for existing specifications.

Before making changes:

1. Inspect the current implementation, existing specifications, and project structure.
2. Identify the existing design tokens, components, diagrams, and simulation controls.
3. Preserve existing functionality, scenarios, simulation logic, and technical correctness.
4. Reuse existing architecture and components wherever practical.
5. Apply the design principles consistently rather than introducing isolated cosmetic changes.
6. Resolve conflicts with existing requirements explicitly. Do not silently remove functionality.

Do not introduce a UI framework, backend, build system, or additional dependencies solely to implement this design.

## 3. Principiae — Communication-First Design

Primary reference: Jean-luc Doumont, Trees, Maps, and Theorems.

Resources:

- https://principiae.be/X0010.php
- https://principiae.be/X0100.php

Use the following principles as practical design requirements, informed by Principiae’s approach to effective scientific communication.

### 3.1 Message before decoration

Every major screen and guided simulation step must communicate a clear learning objective.

Prefer explanatory headlines:

- “MCP allows the model to obtain live account information.”
- “RAG retrieves relevant documents before generating an answer.”

Avoid generic headings such as “Architecture” or “Processing” when a meaningful statement is possible.

The learner should understand what matters before inspecting technical details.

### 3.2 Maximize signal-to-noise ratio

Remove visual elements that do not contribute to understanding.

- Avoid unnecessary borders, shadows, gradients, decorative icons, and animations.
- Avoid excessive diagram connections.
- Use whitespace to establish relationships.
- Highlight only what is relevant to the current step.
- Keep supporting information visually subordinate.

Minimalism is not the goal by itself. Information clarity is the goal.

### 3.3 Effective visual hierarchy

Establish hierarchy using:

1. Position and grouping
2. Typography and size
3. Spacing
4. Contrast
5. Color

Do not rely primarily on color to communicate importance.

Each guided simulation step should have one dominant focal point.

### 3.4 Direct labeling

Place explanations close to the elements they describe.

For diagrams:

- Label nodes directly.
- Label meaningful connections where necessary.
- Clearly indicate message direction.
- Avoid legends when direct labeling is practical.
- Use descriptive labels instead of unexplained abbreviations.

Technical terms such as MCP, LLM, embedding, and vector search may be used, but their roles must remain understandable.

### 3.5 Effective redundancy

Important distinctions should be communicated using multiple visual signals.

For example, an active tool invocation may be identified through:

- Its position in the sequence
- An explicit “Tool call” label
- A highlighted connection
- A consistent accent color

Color must never be the only indicator of state.

### 3.6 Progressive disclosure

Support two complementary levels of understanding.

Conceptual level

- What is happening?
- Why is it happening?
- Which components participate?
- What changes as a result?

Technical level

- Exact messages and payloads
- Protocol boundaries
- Requests and responses
- Retrieval results and ranking
- Context construction
- Error and edge cases

Show the essential mechanism first. Make technical details available without forcing every learner to inspect them.

Progressive disclosure must not compromise technical accuracy.

## 4. Color System — Sanzo Wada No. 303

Use the following palette as the visual foundation.

| Color | HEX | Primary role |
| --- | --- | --- |
| Naples Yellow | #FBE6A0 | Warm emphasis, selected elements, secondary actions |
| Peach Red | #F15A30 | Primary actions, active simulation steps |
| Deep Slate Olive | #253122 | Primary text, dark surfaces, technical diagrams |
| Neutral Gray | #B6BFC1 | Secondary surfaces, inactive elements, separators |

Preserve these four colors as the recognizable brand identity.

### 4.1 Supporting colors

Introduce supporting colors only where needed for readability or semantic meaning.

| Token | HEX | Purpose |
| --- | --- | --- |
| Cream | #FFF9EA | Main page background |
| White | #FFFFFF | Reading surfaces |
| Information | #3478A1 | Informational states |
| Success | #387C60 | Successful operations |
| Error | #B73535 | Errors and failures |

These are proposed supporting colors, not part of Wada’s original palette.

Avoid expanding the palette unnecessarily.

### 4.2 Color usage

- Use cream or white for reading-intensive content.
- Use deep olive for technical diagram surfaces when contrast and clarity benefit.
- Use Naples Yellow for selected elements and warm emphasis.
- Reserve Peach Red for important actions and the current execution step.
- Use neutral gray for supporting structure, not essential low-contrast text.
- Avoid large areas of competing saturated colors.

Do not make every card, panel, or component colorful.

### 4.3 Accessibility

Target WCAG 2.2 AA.

- Normal text contrast: at least 4.5:1.
- Large text contrast: at least 3:1.
- Non-text UI indicators: at least 3:1 where applicable.
- Verify actual foreground/background combinations.
- Provide visible keyboard focus.
- Respect reduced-motion preferences.
- Never communicate execution state through color alone.

In particular, the original Peach Red does not provide sufficient contrast with Deep Slate Olive for normal-sized text. Use a verified accessible alternative for small labels.

## 5. Typography and Layout

Use restrained, modern typography optimized for technical education.

Typography

- Sans-serif for headings and body text.
- Monospace for code, identifiers, payloads, and protocol messages.
- Clear heading hierarchy.
- Comfortable line height.
- Consistent type scale.
- Avoid decorative typography.

Use typography to communicate structure, not to create unnecessary visual variation.

Layout

- Prefer consistent alignment and spacing.
- Group related information spatially.
- Keep reading widths comfortable.
- Use responsive layouts without losing diagram meaning.
- Avoid unnecessary nested cards.
- Maintain stable component positions during simulation playback.

The interface should feel like a carefully designed technical publication combined with an interactive laboratory.

## 6. MCP and RAG Visualization

The simulators are the most important part of the website.

Their design must prioritize understanding cause and effect.

### 6.1 Shared interaction model

Both simulations should follow a consistent interaction pattern:

1. Present the learning question.
2. Show the relevant components.
3. Allow the learner to predict or consider what happens next.
4. Execute one meaningful step.
5. Highlight the active interaction.
6. Explain what happened and why.
7. Allow inspection of technical details.
8. Continue, step backward, or replay.

Preserve existing controls and workflows where they already satisfy these requirements.

### 6.2 Diagram behavior

- Maintain stable node positions.
- Highlight the active node and relevant connection.
- Dim unrelated elements without making them illegible.
- Show direction of data flow explicitly.
- Use consistent visual conventions across MCP and RAG.
- Keep labels close to relevant components.
- Avoid decorative particle effects and continuously moving connections.
- Use animation only when it clarifies a state transition.

The learner must be able to pause and inspect any meaningful step.

### 6.3 MCP scenario

User question: “What is the current balance of my bank account?”

The simulation should explain how an AI assistant obtains live account information through MCP.

Illustrate the relevant stages:

- User request
- Model determines that external information is needed
- Available tool information
- Tool invocation through the MCP client/server interaction
- External banking service or simulated API
- Tool response
- Model interpretation
- Final answer

Clearly distinguish the MCP protocol interaction from the external banking API call.

Do not imply that MCP itself stores bank balances or directly accesses the banking database.

### 6.4 RAG scenario

User question: “What are the conditions for opening and maintaining a bank account?”

The simulation should illustrate:

- User question
- Query preparation and embedding where applicable
- Document search
- Retrieval of relevant passages
- Ranking or filtering where applicable
- Context assembly
- Model generation
- Answer with source references

Make the distinction between retrieved evidence and generated text explicit.

The learner should understand why the final answer is grounded in retrieved documents.

### 6.5 Technical inspection

Where appropriate, allow learners to inspect:

- Request and response payloads
- Tool definitions
- Retrieved document excerpts
- Similarity or ranking information
- Context supplied to the model
- Generated answers
- Failure cases

These details should be accessible without overwhelming the conceptual visualization.

## 7. Educational Interaction Principles

AgentScope must support active learning, not merely present an animated explanation.

Where compatible with existing specifications:

- Ask learners to anticipate the next step.
- Let them inspect what changed.
- Explain why an operation is necessary.
- Support replay and step-by-step navigation.
- Make failures and limitations visible.
- Distinguish simulated behavior from actual AI or protocol execution.

Use deterministic simulations for reproducibility.

Do not imply that a simulated model is making live decisions when the behavior is scripted.

## 8. Technical Constraints

Preserve the existing technical direction:

- Static HTML, CSS, and JavaScript
- GitHub Pages compatible
- No mandatory backend
- No live banking integration required
- No mandatory external AI API
- Minimal runtime dependencies
- Reusable CSS design tokens
- Separation of presentation and simulation logic
- Responsive desktop and mobile behavior

Avoid unnecessary architectural changes.

## 9. Implementation Priorities

Apply changes in the following order.

Priority 1 — Communication clarity

Review headings, explanations, diagram labels, and information hierarchy. Ensure each guided step communicates one meaningful insight.

Priority 2 — Diagram comprehension

Improve component grouping, data-flow direction, active-state highlighting, and technical inspection.

Priority 3 — Visual consistency

Apply the Wada palette through reusable tokens. Standardize typography, spacing, controls, and surfaces.

Priority 4 — Accessibility and responsiveness

Validate contrast, keyboard navigation, focus states, reduced motion, and mobile layouts.

Priority 5 — Visual refinement

Remove unnecessary decoration and polish the remaining interactions.

Do not prioritize cosmetic changes over educational clarity or functional correctness.

## 10. Acceptance Criteria

The design refinement is complete when:

- [ ] Existing MCP and RAG functionality remains intact.
- [ ] Each guided step has a clear learning takeaway.
- [ ] Diagrams communicate relationships through position, labels, direction, and restrained highlighting.
- [ ] Technical details remain available without dominating the initial view.
- [ ] The four original Wada colors are used consistently.
- [ ] Supporting colors have clear semantic purposes.
- [ ] Text and interactive controls meet the applicable accessibility requirements.
- [ ] Learners can navigate, pause, and inspect the simulations.
- [ ] The interface distinguishes simulated behavior from real protocol execution.
- [ ] The website remains deployable as static files on GitHub Pages.
- [ ] No unnecessary dependencies or architectural changes have been introduced.

## 11. Final Guidance for the Implementation Agent

Review the current application against this document and implement improvements incrementally.

Do not rewrite working functionality merely to achieve visual consistency.

Use Principiae’s communication principles as the basis for evaluating design decisions. Use Wada No. 303 as the visual identity, not as a requirement to color every interface element.

When a design choice creates tension between visual appeal and comprehension, prioritize comprehension.

The desired result is a visually distinctive, technically accurate, interactive educational tool that helps experienced learners understand AI systems through clear explanations and carefully structured visualizations.
