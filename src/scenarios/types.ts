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
  /** Short phrases naming what the message carries (03 event_schema.carries). */
  carries?: string[];
  /** Groups that explain the payload field by field (03 annotation_rules). */
  annotations?: AnnotationGroup[];
}

/** One annotation group (03 event_schema.annotations). */
export interface AnnotationGroup {
  heading: string;
  /** One sentence on why the group exists. */
  sentence: string;
  /** JSON paths of the payload members the group holds. */
  paths: string[];
  /** Meaning of the value at each JSON path inside the group, one bullet each. */
  values?: Record<string, string>;
}

export interface Phase {
  id: string;
  /** Shown at the Architecture level. */
  label: string;
  /** Drives Compare synchronisation (06-comparison-scenarios.yaml semantic_phases). */
  semantic_phase: string;
  /** One sentence: what the learner should understand from the phase. */
  takeaway: string;
}

/** A party of the Overview: participants merged into one lifeline (03 overview_fields). */
export interface Party {
  id: string;
  label: string;
  /** Participant IDs of the scenario. */
  members: string[];
}

/** A stage of the Overview: consecutive phases told in one plain sentence. */
export interface Stage {
  id: string;
  /** Phase IDs, a consecutive run of the scenario's phases. */
  phases: string[];
  sentence: string;
}

/** The scenario at the Overview zoom level (02 zoom_levels.overview). */
export interface Overview {
  parties: Party[];
  stages: Stage[];
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
  /** One sentence stating the main message. */
  headline: string;
  participants: string[];
  phases: Phase[];
  /** Parties and stages of the Overview zoom level. */
  overview: Overview;
  events: ScenarioEvent[];
  initial_state: JsonObject;
  parameters?: Record<string, ParameterSpec>;
  /** Local IDs of the events the scenario's engine recomputes from parameters and fixtures. */
  derived_events?: string[];
  /** Events that play only while their boolean parameter is on. */
  optional_steps?: OptionalStep[];
  context_rule?: string;
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
  overview: Overview;
  initial_state: JsonObject;
  compose: CompositionStep[];
  expanded_event_count: number;
  derived_events?: string[];
}

/** One message of an earlier protocol revision, shown only for comparison. */
export interface EarlierMessage {
  operation: string;
  sender: string;
  receiver: string;
  http: HttpEnvelope;
  payload: Json;
}

/** 04-mcp-scenarios.yaml protocol.earlier_revision_handshake. */
export interface EarlierRevision {
  revision: string;
  summary: string;
  messages: EarlierMessage[];
}

/** The parsed specification files the app bundles (00, 01, 03, 04, 05, 06, 07). */
export interface SpecSources {
  product: { primary_questions: { mcp: string; rag: string; combined: string } } & JsonObject;
  architecture: { participants: { registry: { id: string }[] } } & JsonObject;
  engine: {
    event_schema: { required: string[]; fields: Record<string, string> };
    scenario_format: { required: string[] };
    lineage: { tracked: string[]; origins?: Record<string, unknown> };
  } & JsonObject;
  mcp: {
    protocol: { revision: string; earlier_revision_handshake?: EarlierRevision };
    scenarios: Scenario[];
  } & JsonObject;
  rag: { scenarios: Scenario[] } & JsonObject;
  comparison: {
    semantic_phases: { id: string; label: string }[];
    compare: Compare;
    combined: Composition;
  } & JsonObject;
  security: { trust_boundaries: { id: string }[] } & JsonObject;
}

/** The Compare view's data (06-comparison-scenarios.yaml compare). */
export type Compare = {
  id: string;
  left_scenario: string;
  right_scenario: string;
  headline: string;
  left_question: string;
  right_question: string;
  /** Scenario ID → scenario phase ID → semantic phase ID. */
  phase_mapping: Record<string, Record<string, string>>;
  /** Scenario ID → semantic phase without events → what the pane shows instead. */
  placeholders?: Record<string, Record<string, string>>;
  /** One sentence per comparison aspect. */
  aspects?: { label: string; sentence: string }[];
} & JsonObject;

/** The scenarios of 04 and 05, then the composed scenario, in that order. */
export type Registry = Record<string, Scenario>;
