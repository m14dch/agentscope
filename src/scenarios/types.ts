/**
 * Types for the scenario data defined in specifications/03-simulation-engine.yaml.
 * The YAML is converted to JSON at build time (scripts/vite-scenarios.ts) and
 * expanded and validated at startup (src/scenarios/registry.ts).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Protocol = 'MCP' | 'HTTP' | 'LLM_API' | 'RAG_INTERNAL' | 'UI' | 'DB' | 'INTERNAL';
export type Transport = 'streamable_http' | 'https' | 'in_process' | 'simulated';
export type ExecutionType = 'NETWORK' | 'IN_PROCESS' | 'SIMULATED_INTERNAL';
export type MessageType = 'REQUEST' | 'RESPONSE' | 'NOTIFICATION' | 'ACTION' | 'RESULT';

/** Simulated HTTP framing of a NETWORK event; body_ref points to the event's payload. */
export interface HttpEnvelope {
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  body_ref?: string;
}

export interface StateChange {
  path: string;
  op: 'set' | 'append';
  value?: Json;
  /** Dotted path into the same event, for example payload.result.tools. */
  value_ref?: string;
}

export interface ContextChange {
  target: 'agent_state' | 'model_visible_messages';
  action: 'set' | 'append';
  description: string;
  value_ref: string;
}

/** A question shown before the event runs; the event itself answers it. */
export interface Prediction {
  prompt: string;
}

export interface ScenarioEvent {
  id: string;
  scenario_id: string;
  phase: string;
  sequence: number;
  sender: string;
  receiver: string;
  operation: string;
  protocol: Protocol;
  transport: Transport;
  execution_type: ExecutionType;
  message_type: MessageType;
  explanation: string;
  /** JSON-RPC id as a string on MCP requests and responses. */
  correlation_id?: string;
  pair_id?: string;
  payload?: Json;
  http?: HttpEnvelope;
  technical_notes?: string[];
  security_boundaries?: string[];
  tracked_values?: Record<string, Json>;
  state_changes?: StateChange[];
  context_changes?: ContextChange[];
  prediction?: Prediction;
}

export interface Phase {
  id: string;
  /** Shown in architecture mode. */
  label: string;
  /** Drives Compare synchronisation (06-comparison-scenarios.yaml semantic_phases). */
  semantic_phase: string;
  /** One sentence: what the learner should understand from the phase. */
  takeaway: string;
}

export interface ParameterSpec {
  default: Json;
  min?: number;
  max?: number;
  /** When present, the only allowed values. */
  options?: Json[];
}

export interface OptionalStep {
  enabled_by: string;
  events: string[];
}

export interface Scenario {
  id: string;
  title: string;
  question?: string;
  learning_question: string;
  /** One sentence stating the main message; for an expanded variant, its lesson. */
  headline: string;
  participants: string[];
  phases: Phase[];
  events: ScenarioEvent[];
  initial_state: JsonObject;
  parameters?: Record<string, ParameterSpec>;
  derived_events?: string[];
  optional_steps?: OptionalStep[];
  context_rule?: string;
}

export type VariantOperation =
  | { op: 'patch'; event: string; set: Record<string, Json> }
  | { op: 'replace'; event: string; with: ScenarioEvent }
  | { op: 'remove'; events: string[] }
  | { op: 'insert_after'; event: string; events: ScenarioEvent[] };

export interface Variant {
  id: string;
  title: string;
  extends: string;
  question?: string;
  /** One sentence stating what the variant teaches. */
  lesson: string;
  fixture_overrides?: JsonObject;
  parameter_overrides?: JsonObject;
  operations?: VariantOperation[];
  /** Replaces the takeaways of base phases that are not true for the variant. */
  phase_overrides?: Record<string, { takeaway?: string }>;
}

export interface CopyStep {
  copy: {
    scenario: string;
    from: string;
    to: string;
    phase_map?: Record<string, string>;
    /** Field replacements keyed by source event ID. */
    patch?: Record<string, Record<string, Json>>;
  };
}

export interface InsertStep {
  insert: ScenarioEvent[];
}

export type CompositionStep = CopyStep | InsertStep;

export interface Composition {
  id: string;
  title: string;
  question: string;
  learning_question: string;
  headline: string;
  participants: string[];
  phases: Phase[];
  initial_state: JsonObject;
  compose: CompositionStep[];
  expanded_event_count: number;
  variants?: (Omit<Variant, 'extends'> & JsonObject)[];
}

/** The parsed specification files the app bundles (00, 01, 03, 04, 05, 06, 07). */
export interface SpecSources {
  product: { primary_questions: { mcp: string; rag: string; combined: string } } & JsonObject;
  architecture: { participants: { registry: { id: string }[] } } & JsonObject;
  engine: {
    event_schema: { required: string[]; fields: Record<string, string> };
    scenario_format: { required: string[] };
    lineage: { tracked: string[] };
  } & JsonObject;
  mcp: { protocol: { revision: string }; scenarios: Scenario[]; variants: Variant[] } & JsonObject;
  rag: { scenarios: Scenario[]; variants: Variant[] } & JsonObject;
  comparison: {
    semantic_phases: { id: string }[];
    compare: { phase_mapping: Record<string, Record<string, string>> } & JsonObject;
    combined: Composition;
  } & JsonObject;
  security: { trust_boundaries: { id: string }[] } & JsonObject;
}

/** Base scenarios, expanded variants and the composed scenario, in that order. */
export type Registry = Record<string, Scenario>;
