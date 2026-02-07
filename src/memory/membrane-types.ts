/**
 * TypeScript types generated from Membrane protobuf definitions.
 * Source: ~/.agents/tools/memory-v1/infrastructure/membrane/src/api/proto/membrane/v1/membrane.proto
 *
 * These types mirror the gRPC API and the underlying Go schema structures.
 */

// =============================================================================
// Enums
// =============================================================================

export type MemoryType = "episodic" | "working" | "semantic" | "competence" | "plan_graph";

export type Sensitivity = "public" | "low" | "medium" | "high" | "hyper";

export type DecayCurve = "exponential" | "linear" | "custom";

export type DeletionPolicy = "auto_prune" | "manual_only" | "never";

export type RevisionStatus = "active" | "contested" | "retracted";

export type ValidityMode = "global" | "conditional" | "timeboxed";

export type TaskState = "planning" | "executing" | "blocked" | "waiting" | "done";

export type OutcomeStatus = "success" | "failure" | "partial";

export type AuditAction = "create" | "revise" | "fork" | "merge" | "delete" | "reinforce" | "decay";

export type ProvenanceKind = "event" | "artifact" | "tool_call" | "observation" | "outcome";

export type EdgeKind = "data" | "control";

// =============================================================================
// Core Structures
// =============================================================================

export interface DecayProfile {
  curve: DecayCurve;
  halfLifeSeconds?: number;
  decayRatePerSecond?: number;
  customParams?: Record<string, unknown>;
}

export interface Lifecycle {
  decay: DecayProfile;
  lastReinforcedAt: string; // RFC 3339
  lastAccessedAt?: string; // RFC 3339
  pinned?: boolean;
  deletionPolicy: DeletionPolicy;
}

export interface ProvenanceSource {
  kind: ProvenanceKind;
  ref?: string;
  createdBy?: string;
  timestamp?: string; // RFC 3339
}

export interface Provenance {
  sources: ProvenanceSource[];
  createdBy?: string;
}

export interface Relation {
  kind: string; // supersedes, derived_from, contested_by, supports, contradicts
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEntry {
  action: AuditAction;
  actor: string;
  timestamp: string; // RFC 3339
  rationale?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

// =============================================================================
// Payload Types
// =============================================================================

export interface TimelineEvent {
  t: string; // RFC 3339
  eventKind: string;
  ref: string;
  summary?: string;
}

export interface ToolNode {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  result?: unknown;
  timestamp?: string; // RFC 3339
  dependsOn?: string[];
}

export interface EnvironmentSnapshot {
  os?: string;
  osVersion?: string;
  toolVersions?: Record<string, string>;
  workingDirectory?: string;
  context?: Record<string, unknown>;
}

export interface EpisodicPayload {
  kind: "episodic";
  timeline: TimelineEvent[];
  toolGraph?: ToolNode[];
  environment?: EnvironmentSnapshot;
  outcome?: OutcomeStatus;
  artifacts?: string[];
  toolGraphRef?: string;
}

export interface Constraint {
  name: string;
  scope?: string;
  value?: unknown;
}

export interface WorkingPayload {
  kind: "working";
  threadId: string;
  state: TaskState;
  activeConstraints?: Constraint[];
  nextActions?: string[];
  openQuestions?: string[];
  contextSummary?: string;
}

export interface Validity {
  mode: ValidityMode;
  validFrom?: string; // RFC 3339
  validUntil?: string; // RFC 3339
  conditions?: Record<string, unknown>;
}

export interface ProvenanceRef {
  sourceType: string;
  sourceId: string;
  timestamp?: string; // RFC 3339
}

export interface SemanticPayload {
  kind: "semantic";
  subject: string;
  predicate: string;
  object: unknown;
  validity?: Validity;
  evidence?: ProvenanceRef[];
  revisionPolicy?: string;
  revisionStatus?: RevisionStatus;
  forkedFrom?: string;
  contestedBy?: string[];
}

export interface Precondition {
  description: string;
  checkRef?: string;
}

export interface PostCondition {
  description: string;
  verifyRef?: string;
}

export interface CompetencePayload {
  kind: "competence";
  goal: string;
  conditions?: string;
  procedure: string;
  outcomeHistory?: { success: number; failure: number; partial: number };
  preconditions?: Precondition[];
  postConditions?: PostCondition[];
  domain?: string[];
  successRate?: number;
}

export interface PlanNode {
  id: string;
  action: string;
  params?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PlanEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface PlanGraphPayload {
  kind: "plan_graph";
  goal: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  entryNodeId?: string;
  exitNodeId?: string;
  conditions?: string;
  reuseCount?: number;
}

export type Payload =
  | EpisodicPayload
  | WorkingPayload
  | SemanticPayload
  | CompetencePayload
  | PlanGraphPayload;

// =============================================================================
// Memory Record (main entity)
// =============================================================================

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  sensitivity: Sensitivity;
  confidence: number;
  salience: number;
  scope?: string;
  tags?: string[];
  createdAt: string; // RFC 3339
  updatedAt: string; // RFC 3339
  lifecycle: Lifecycle;
  provenance: Provenance;
  relations?: Relation[];
  payload: Payload;
  auditLog: AuditEntry[];
}

// =============================================================================
// Trust Context
// =============================================================================

export interface TrustContext {
  maxSensitivity: Sensitivity;
  authenticated: boolean;
  actorId?: string;
  scopes?: string[];
}

// =============================================================================
// gRPC Request/Response Types
// =============================================================================

// Ingestion requests
export interface IngestEventRequest {
  source: string;
  eventKind: string;
  ref?: string;
  summary?: string;
  timestamp?: string; // RFC 3339
  tags?: string[];
  scope?: string;
  sensitivity?: Sensitivity;
}

export interface IngestToolOutputRequest {
  source: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  dependsOn?: string[];
  timestamp?: string; // RFC 3339
  tags?: string[];
  scope?: string;
  sensitivity?: Sensitivity;
}

export interface IngestObservationRequest {
  source: string;
  subject: string;
  predicate: string;
  object: unknown;
  timestamp?: string; // RFC 3339
  tags?: string[];
  scope?: string;
  sensitivity?: Sensitivity;
}

export interface IngestOutcomeRequest {
  source: string;
  targetRecordId: string;
  outcomeStatus: OutcomeStatus;
  timestamp?: string; // RFC 3339
}

export interface IngestWorkingStateRequest {
  source: string;
  threadId: string;
  state: TaskState;
  nextActions?: string[];
  openQuestions?: string[];
  contextSummary?: string;
  activeConstraints?: Constraint[];
  timestamp?: string; // RFC 3339
  tags?: string[];
  scope?: string;
  sensitivity?: Sensitivity;
}

export interface IngestResponse {
  record: MemoryRecord;
}

// Retrieval requests
export interface RetrieveRequest {
  taskDescriptor: string;
  trust?: TrustContext;
  memoryTypes?: MemoryType[];
  minSalience?: number;
  limit?: number;
}

export interface RetrieveResponse {
  records: MemoryRecord[];
  selection?: SelectionResult;
}

export interface RetrieveByIDRequest {
  id: string;
  trust?: TrustContext;
}

export interface MemoryRecordResponse {
  record: MemoryRecord;
}

// Selection result from competence/plan_graph evaluation
export interface SelectionResult {
  selectedId?: string;
  candidates: Array<{
    id: string;
    score: number;
    rationale?: string;
  }>;
}

// Revision requests
export interface SupersedeRequest {
  oldId: string;
  newRecord: MemoryRecord;
  actor: string;
  rationale?: string;
}

export interface ForkRequest {
  sourceId: string;
  forkedRecord: MemoryRecord;
  actor: string;
  rationale?: string;
}

export interface RetractRequest {
  id: string;
  actor: string;
  rationale?: string;
}

export interface MergeRequest {
  ids: string[];
  mergedRecord: MemoryRecord;
  actor: string;
  rationale?: string;
}

export interface ContestRequest {
  id: string;
  contestingRef: string;
  actor: string;
  rationale?: string;
}

// Decay requests
export interface ReinforceRequest {
  id: string;
  actor: string;
  rationale?: string;
}

export interface PenalizeRequest {
  id: string;
  amount: number;
  actor: string;
  rationale?: string;
}

// Metrics
export interface MetricsSnapshot {
  totalRecords: number;
  recordsByType: Record<MemoryType, number>;
  avgSalience: number;
  avgConfidence: number;
  salienceDistribution: Record<string, number>;
  activeRecords: number;
  pinnedRecords: number;
  totalAuditEntries: number;
  memoryGrowthRate: number;
  retrievalUsefulness: number;
  competenceSuccessRate: number;
  planReuseFrequency: number;
  revisionRate: number;
}

export interface GetMetricsRequest {}

export interface MetricsResponse {
  snapshot: MetricsSnapshot;
}
