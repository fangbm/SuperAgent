/**
 * SuperAgent Contracts v0.8 (design-stage TypeScript contracts)
 * Host/plugin boundary. The Host MUST perform runtime JSON Schema validation.
 * This file is not a complete runtime implementation.
 */

export type ISO8601 = string;
export type UUID = string;
/** Host-only globally unique opaque id; NEVER a CloudEvents `id`. */
export type InternalEventId = string & { readonly __brand: "InternalEventId" };
/** Persisted by Host after commitBatch; not emitted by Source Plugins. */
export interface PersistedEventRefV1 {
  eventId: InternalEventId;
  source: string; // CloudEvents source (source URI)
  id: string;     // CloudEvents id (source-local event id)
}

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };

export type PlatformId =
  | "qq-official"
  | "discord"
  | "steam-reviews"
  | "steam-discussions"
  | (string & {});

/** Every known feedback event type has exactly one object.kind (v0.4). */
export interface FeedbackEventKindMapV1 {
  "com.superagent.feedback.message.created.v1": "message";
  "com.superagent.feedback.message.updated.v1": "message";
  "com.superagent.feedback.message.deleted.v1": "message";
  "com.superagent.feedback.review.created.v1": "review";
  "com.superagent.feedback.review.updated.v1": "review";
  "com.superagent.feedback.review.deleted.v1": "review";
  "com.superagent.feedback.thread.created.v1": "thread";
  "com.superagent.feedback.thread.updated.v1": "thread";
  "com.superagent.feedback.thread.deleted.v1": "thread";
  "com.superagent.feedback.comment.created.v1": "comment";
  "com.superagent.feedback.comment.updated.v1": "comment";
  "com.superagent.feedback.comment.deleted.v1": "comment";
}
export type FeedbackEventTypeV1 = keyof FeedbackEventKindMapV1;
export type CoverageEventTypeV1 = "com.superagent.source.coverage.changed.v1";
export type EventType = FeedbackEventTypeV1 | CoverageEventTypeV1;

export type SourceObjectKind = "message" | "review" | "thread" | "comment";
export type SourceCoverage = "full" | "partial" | "unknown" | "unavailable";

export interface FeedbackContentV1 {
  text: string | null;
  language?: string;
  attachments?: ReadonlyArray<{
    kind: "image" | "video" | "file" | "link";
    assetRef?: string;
    url?: string;
    mimeType?: string;
  }>;
}

export interface FeedbackDataV1<K extends SourceObjectKind = SourceObjectKind> {
  schemaVersion: "1.0";
  projectId: string;
  sourceId: string;
  platform: PlatformId;
  object: {
    kind: K;
    externalId: string;
    revision: string;
    parentExternalId?: string;
    threadExternalId?: string;
  };
  actor?: { opaqueId?: string; isBot?: boolean };
  content?: FeedbackContentV1;
  origin?: { permalink?: string; locale?: string };
  attributes?: Record<string, JSONValue>;
}

export interface CoverageDataV1 {
  schemaVersion: "1.0";
  projectId: string;
  sourceId: string;
  platform: PlatformId;
  coverage: SourceCoverage;
  reason?: string;
  since?: ISO8601;
}

/** CloudEvents v1.0-style envelope. Externally unique ONLY as `(source,id)`. */
export interface EventEnvelopeV1<T extends EventType, D> {
  specversion: "1.0";
  id: string; // source-local event id; never InternalEventId
  source: string; // source URI / stable source namespace
  type: T;
  time: ISO8601;
  subject?: string;
  datacontenttype: "application/json";
  data: D;
}

export type FeedbackEventV1 = {
  [T in FeedbackEventTypeV1]: EventEnvelopeV1<T, FeedbackDataV1<FeedbackEventKindMapV1[T]>>
}[FeedbackEventTypeV1];
export type CoverageEventV1 = EventEnvelopeV1<CoverageEventTypeV1, CoverageDataV1>;
/** Discriminated union: type narrows data in TypeScript AND runtime JSON Schema. */
export type NormalizedEventV1 = FeedbackEventV1 | CoverageEventV1;

export interface PluginManifestV1 {
  apiVersion: "superagent.io/plugin/v1";
  id: string;
  version: string;
  displayName: string;
  kind: "source" | "delivery";
  engine: { sdk: string }; // e.g. ^0.1.0
  permissions: {
    networkHosts: string[];
    secretKeys: string[];
    eventPublish?: boolean;
    deliverySend?: boolean;
  };
  configSchema: JSONValue; // JSON Schema document, validated by host
}

export interface ConnectorCapabilityV1 {
  connection: "push" | "poll" | "hybrid";
  coverage: SourceCoverage;
  readMessages: boolean;
  readHistory: boolean;
  readEdits: boolean;
  readAttachments: boolean;
  reason?: string;
}

export type PluginErrorCode =
  | "UNAUTHORIZED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "PLATFORM_UNAVAILABLE"
  | "INVALID_CONFIG"
  | "INVALID_EVENT"
  | "TRANSIENT_NETWORK"
  | "UNSUPPORTED_CAPABILITY";

export interface SyncCheckpointV1 {
  sourceId: string;
  cursor: JSONValue;
}

export interface CommitResultV1 {
  accepted: number;
  duplicates: number;
  transactionId: string;
  /** One result per input event, including duplicates; duplicates map to existing Host ids. */
  refs: ReadonlyArray<PersistedEventRefV1 & { inserted: boolean }>;
}

export interface PluginLogger {
  debug(message: string, metadata?: Record<string, JSONValue>): void;
  info(message: string, metadata?: Record<string, JSONValue>): void;
  warn(message: string, metadata?: Record<string, JSONValue>): void;
  error(message: string, metadata?: Record<string, JSONValue>): void;
}

export interface SourcePluginHostV1 {
  readonly projectId: string;
  readonly sourceId: string;
  readonly logger: PluginLogger;
  getCheckpoint(): Promise<JSONValue | null>;
  /** Atomic operation: inserts accepted events and advances the checkpoint together. */
  commitBatch(
    events: readonly NormalizedEventV1[],
    checkpoint?: SyncCheckpointV1,
  ): Promise<CommitResultV1>;
  getSecret(key: string): Promise<string>; // only keys declared in manifest
  reportHealth(info: {
    coverage: SourceCoverage;
    reason?: string;
    checkedAt: ISO8601;
  }): Promise<void>;
}

export interface SourcePluginV1 {
  readonly manifest: PluginManifestV1;
  probe(): Promise<ConnectorCapabilityV1>;
  start(host: SourcePluginHostV1, signal: AbortSignal): Promise<void>;
  sync(host: SourcePluginHostV1, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

/** v0.6: UI-independent report navigation. The QQ plugin maps these actions to Keyboard. */
export type ReportSectionV1 = "bugs" | "suggestions" | "steam_negative_reviews";
export interface ReportNavigationActionV1 {
  kind: "report.open_section";
  section: ReportSectionV1;
  label: string;
}

export interface ReportPresentationV1 {
  schemaVersion: "1.0";
  kind: "report_summary";
  format: "markdown";
  reportId: string;
  revision: number;
  /** The default configuration has exactly three actions in this order. */
  actions: readonly ReportNavigationActionV1[];
}

/** Filled by the trusted Host from an authenticated C2C interaction. */
export interface ReportNavigationQueryV1 {
  reportId: string;
  reportRevision: number;
  section: ReportSectionV1;
  actorRef: string;
  interactionId: string;
  cursor?: string;
  limit: number;
}

export type ReportNavigationEntryV1 =
  | { kind: "bug"; id: string; title: string; newFeedbackCount: number; priority?: string }
  | { kind: "suggestion"; id: string; title: string; newFeedbackCount: number; status: SuggestionStatusV1 }
  | { kind: "steam_negative_review"; id: string; sourceId: string; reviewExternalId: string;
      evidenceEventId: InternalEventId; originalText: string; occurredAt: ISO8601;
      originalUrl?: string; updatedInWindow: boolean };

export interface ReportNavigationPageV1 {
  schemaVersion: "1.0";
  reportId: string;
  reportRevision: number;
  section: ReportSectionV1;
  entries: readonly ReportNavigationEntryV1[];
  nextCursor?: string;
  /** Coverage may be partial; an empty list does not assert there were no player reports. */
  coverageWarning?: string;
}

export interface DeliveryRequestV1 {
  deliveryId: UUID;
  idempotencyKey: string;
  projectId: string;
  reportId: string;
  /** Frozen revision for report deliveries; Host MUST require it for a report with presentation. */
  reportRevision?: number;
  recipientRef: string; // recipient is resolved by Host from approved admin config
  title: string;
  text: string;
  requestedAt: ISO8601;
  /** Optional additive hint; QQ must render it as Markdown + Keyboard. */
  presentation?: ReportPresentationV1;
}

export type DeliveryStatus =
  | "accepted" // provider API accepted; NOT read/receipt confirmation
  | "rejected"
  | "retryable"
  | "blocked"
  | "unknown"; // request may have been accepted; no blind retry

export interface DeliveryResultV1 {
  status: DeliveryStatus;
  providerMessageId?: string;
  errorCode?: string;
  retryAfterMs?: number;
  detail?: string;
  /** The provider's reliable receipt/reconciliation token, when offered. */
  providerRequestId?: string;
}

export interface DeliveryPluginHostV1 {
  readonly logger: PluginLogger;
  getSecret(key: string): Promise<string>;
}

export interface DeliveryPluginV1 {
  readonly manifest: PluginManifestV1;
  probe(): Promise<{ available: boolean; reason?: string }>;
  send(request: DeliveryRequestV1, host: DeliveryPluginHostV1): Promise<DeliveryResultV1>;
}

export type TaskStatus =
  | "pending"
  | "leased"
  | "running"
  | "retry_wait"
  | "completed"
  | "dead_letter"
  | "cancelled";

export interface AgentTaskV1 {
  id: UUID;
  projectId: string;
  kind:
    | "feedback.admit"
    | "feedback.segment.flush"
    | "feedback.batch.triage"
    | "feedback.audit"
    | "feedback.triage"
    | "feedback.extract.v2"
    | "suggestion.retrieve"
    | "suggestion.match"
    | "suggestion.github.sync"
    | "suggestion.action"
    | "feedback.link_issue"
    | "issue.reprioritize"
    | "issue.github.sync"
    | "issue.action"
    | "report.generate"
    | "report.deliver"
    | "notification.p0.evaluate"
    | "notification.p0.deliver";
  payload: JSONValue;
  idempotencyKey: string;
  priority: number;
  createdAt: ISO8601;
}

export interface EvidenceRefV1 {
  eventId: InternalEventId;
  feedbackId?: string;
  excerpt?: string;
}

export type FeedbackClass =
  | "bug"
  | "feature_request"
  | "performance"
  | "usability"
  | "question"
  | "other";

/** @deprecated Retained for reading v0.4 results; new writes MUST use TriageResultV2. */
export interface TriageResultV1 {
  schemaVersion: "1.0";
  classification: FeedbackClass;
  title: string;
  summary: string;
  confidence: number; // 0..1, not assumed calibrated
  productVersion?: string;
  reproductionSteps?: string[];
  evidence: EvidenceRefV1[];
  candidateIssueIds?: string[];
  requiresHumanReview: boolean;
}

/** v0.5: Extraction is multi-intent. Input Source Events remain NormalizedEventV1. */
export interface EvidenceAnchorV2 {
  /** Host-generated, not the source-local CloudEvents id. */
  eventId: InternalEventId;
  /** Optional exact, unmodified quote; Host checks it against stored source text. */
  quote?: string;
  /** UTF-16 offsets in the canonical text projection; [start,end). */
  start?: number;
  end?: number;
  role: "primary" | "context" | "corroboration";
}

export interface FeedbackItemCommonV2 {
  title: string;
  description: string;
  /** Model's uncertain estimate, not calibrated probability. */
  confidence: number;
  evidence: EvidenceAnchorV2[];
  /** Optional extracted game version, never guessed from relative time phrases. */
  productVersion?: string;
}

export interface DefectFeedbackItemV2 extends FeedbackItemCommonV2 {
  kind: "defect";
  category: "bug" | "performance" | "usability";
  observedBehavior: string;
  expectedBehavior?: string;
  reproductionSteps?: string[];
  errorSignature?: string;
}
export interface SuggestionFeedbackItemV2 extends FeedbackItemCommonV2 {
  kind: "suggestion";
  category: "feature_request" | "improvement" | "performance" | "usability";
  requestedOutcome: string;
  targetFeature?: string;
  motivation?: string;
}
export type FeedbackItemV2 = DefectFeedbackItemV2 | SuggestionFeedbackItemV2;

/** One batch may contain zero, one, or multiple items with independent evidence.
 * The Host generates persisted item ids; this result has NO model-controlled global ids.
 * Triage run (batchId, pipelineVersion, revision) is stable before model invocation.
 */
export interface TriageResultV2 {
  schemaVersion: "2.0";
  batchId: string;
  pipelineVersion: string;
  revision: number;
  items: FeedbackItemV2[];
  /** Questions, ordinary chat and ambiguous content remain here, not fake suggestions. */
  nonActionableReason?: "question_only" | "ordinary_chat" | "insufficient_context";
  requiresHumanReview: boolean;
}

export type SuggestionStatusV1 =
  | "candidate" | "reviewing" | "accepted" | "planned"
  | "in_progress" | "implemented" | "verified" | "declined" | "archived";
export type SuggestionRelationshipV1 = "same_request" | "related" | "distinct" | "uncertain";
export interface SuggestionMatchResultV1 {
  candidateSuggestionId: string;
  relationship: SuggestionRelationshipV1;
  matchingOutcome: string[];
  conflictingRequirements: string[];
  distinguishingDetails: string[];
  evidence: EvidenceAnchorV2[];
  confidence?: number;
  rationale: string;
}
/** Explicit command; model may suggest a transition but not invoke it itself. */
export interface SuggestionActionRequestV1 {
  suggestionId: string;
  action: "review" | "accept" | "plan" | "start" | "implement" | "verify" | "decline" | "archive" | "reopen";
  expectedVersion: number;
  actorRef: string;
  source: "qq" | "web" | "discord" | (string & {});
  interactionId: string;
  oneTimeToken?: string;
  /** Immutable evidence for review decisions; no public QQ/Steam raw text required. */
  rationale?: string;
}

export interface AgentWorker<I, O> {
  readonly id: string;
  execute(input: I, context: AgentContextV1): Promise<O>;
}

export interface AgentContextV1 {
  runId: string;
  projectId: string;
  signal: AbortSignal;
  evidence: {
    get(eventId: InternalEventId): Promise<NormalizedEventV1 | null>;
    search(query: string, limit: number): Promise<EvidenceRefV1[]>;
  };
  issues: {
    search(query: string, limit: number): Promise<Array<{ id: string; title: string }>>;
    proposeChange(change: JSONValue, evidence: EvidenceRefV1[]): Promise<string>;
  };
  llm: {
    generateStructured<T extends JSONValue>(request: {
      schemaId: string;
      prompt: string;
      timeoutMs: number;
      maxOutputTokens: number;
    }): Promise<T>;
  };
}

/** Additive Agent context v2; older AgentContextV1 implementations stay valid. */
export interface AgentContextV2 extends AgentContextV1 {
  suggestions: {
    search(query: string, limit: number): Promise<Array<{ id: string; title: string; status: SuggestionStatusV1 }>>;
    proposeChange(change: JSONValue, evidence: EvidenceRefV1[]): Promise<string>;
  };
}
/** Workers that support suggestion tools opt into the new context. */
export interface AgentWorkerV2<I, O> {
  readonly id: string;
  execute(input: I, context: AgentContextV2): Promise<O>;
}

export interface ReportWindowV1 {
  projectId: string;
  startInclusive: ISO8601;
  endExclusive: ISO8601;
  timezone: string;
}

export interface ReportV1 {
  reportId: string;
  window: ReportWindowV1;
  generatedAt: ISO8601;
  coverage: Array<{ sourceId: string; status: SourceCoverage; reason?: string }>;
  counts: {
    newFeedback: number;
    newIssues: number;
    newSuggestions: number;
    pendingAnalysis: number;
  };
  issueIds: string[];
  markdown: string;
}


/** Read-only legacy report from v0.7; cannot backfill snapshot membership by guessing. */
export interface ReportV2Legacy extends Omit<ReportV1, "counts"> {
  schemaVersion: "2.0";
  counts: ReportCountsV2;
  suggestionIds: string[];
  uniqueSourceEventCount: number;
}

export interface ReportCountsV2 {
  newFeedbackItems: number;
  newDefectItems: number;
  newSuggestionItems: number;
  uniqueDefects: number;
  uniqueSuggestions: number;
  pendingAnalysis: number;
}

/** v0.8: one immutable per-(reportId,revision) Steam member. The host guarantees
 * this event is the chosen review revision AS OBSERVED at snapshot cutoff.
 * Original text is retrieved from immutable Source Events, never live Steam.
 */
export interface SteamNegativeReviewSnapshotMemberV1 {
  sourceId: string;
  reviewExternalId: string; // Steam review/recommendation id, NOT source event ID
  /** Latest observed review revision selected as of snapshot cutoff. */
  evidenceEventId: InternalEventId;
  /** Window events causing this review to appear; all Host internal IDs. */
  triggerEventIds: readonly InternalEventId[];
  observedAt: ISO8601; // Host received_at of evidenceEventId
  occurredAt: ISO8601; // Steam reported creation/update time
  updatedInWindow: boolean;
  sentimentAtSnapshot: "negative";
  originalUrl?: string;
}

/** v0.8 writes. `schemaVersion: 2.1` is intentional, because metadata/membership
 * are required; previously stored v2.0 remains legacy read-only.
 */
export interface ReportV2 extends Omit<ReportV1, "counts"> {
  schemaVersion: "2.1";
  /** Per-report monotonically increasing immutable snapshot revision, starting at 1. */
  revision: number;
  /** Snapshot is frozen as of a Host observation cutoff; never query latest at click time. */
  snapshotCutoffAt: ISO8601;
  /** Only set on revisions greater than 1. */
  supersedesRevision?: number;
  counts: ReportCountsV2;
  suggestionIds: string[];
  uniqueSourceEventCount: number;
  /** Source review members, frozen and deduplicated per sourceId+reviewExternalId. */
  steamNegativeReviews: SteamNegativeReviewSnapshotMemberV1[];
}

/** Persisted immutable membership of a report section, not a live Issue query. */
export interface ReportSnapshotEntryV1 {
  reportId: string;
  revision: number;
  section: ReportSectionV1;
  ordinal: number;
  entityId: string;
  /** frozen navigation metadata; raw Steam text is dereferenced from evidenceEventId */
  entry: ReportNavigationEntryV1;
}
export interface ReportSnapshotStoreV1 {
  getExact(reportId: string, revision: number): Promise<ReportV2 | null>;
  /** Cursor is bound to (reportId, revision, section); never jumps to latest. */
  getPage(query: ReportNavigationQueryV1): Promise<ReportNavigationPageV1>;
}

/** Admission is reversible: no decision may erase the source event. */
export type AdmissionKindV1 =
  | "candidate"
  | "urgent_candidate"
  | "needs_context"
  | "archive_only"
  | "audit_sample";

export interface AdmissionDecisionV1 {
  schemaVersion: "1.0";
  eventId: InternalEventId;
  decision: AdmissionKindV1;
  policyVersion: string;
  rationaleCode: string;
  decidedAt: ISO8601;
}

export type BatchFlushReasonV1 =
  | "quiet_timeout"
  | "max_wait"
  | "size_limit"
  | "urgent"
  | "replay";

/** A batch is a unit of computation, not a merged source event. */
export interface FeedbackBatchV1 {
  schemaVersion: "1.0";
  batchId: string;
  projectId: string;
  sourceId: string;
  segmentIds: string[];
  candidateEventIds: InternalEventId[];
  contextEventIds: InternalEventId[];
  policyVersion: string;
  revision: number;
  reason: BatchFlushReasonV1;
  createdAt: ISO8601;
}

export interface BatchingPolicyV1 {
  policyVersion: string;
  quietWindowMs: number;
  maxWaitMs: number;
  maxCandidateMessages: number;
  maxContextMessages: number;
  urgentMaxDelayMs: number;
  auditSampleRate: number;
  maxConcurrentFullAgentJobs: number;
}

export interface FeedbackBufferV1 {
  /** Lightweight decision only, no automatic full Agent invocation. */
  admit(eventId: InternalEventId): Promise<AdmissionDecisionV1>;
  /** Persists batch + processing job atomically, returns stable batch id. */
  flush(segmentId: string, reason: BatchFlushReasonV1): Promise<string>;
  recoverStale(now: ISO8601): Promise<number>;
}

export type BugRelationshipV1 = "same_issue" | "related" | "different" | "uncertain";
export interface BugMatchResultV1 {
  candidateIssueId: string;
  relationship: BugRelationshipV1;
  supportingEvidence: EvidenceRefV1[];
  conflictingEvidence: string[];
  missingInformation: string[];
  confidence?: number; // model judgment; not calibrated probability
  rationale: string;
}

/** Domain-facing interface; platform button callbacks use this, not the LLM. */
export interface IssueActionRequestV1 {
  issueId: string;
  action: "investigate" | "fix" | "verify" | "reopen" | "dismiss";
  expectedVersion: number;
  actorRef: string;
  source: "qq" | "web" | "discord" | (string & {});
  interactionId: string;
  oneTimeToken?: string;
}

export interface IssueEvidencePageV1 {
  issueId: string;
  total: number;
  items: Array<{
    evidenceId: string;
    platform: PlatformId;
    originalText: string;
    createdAt: ISO8601;
    originalUrl?: string;
  }>;
  nextCursor?: string;
}

/** Optional development tracker; implemented by GitHub adapter in MVP. */
export interface IssueTrackerProviderV1 {
  /** Must include stable, non-sensitive correlation marker in provider content. */
  create(issueId: string, operation: ExternalOperationV1): Promise<{ externalIssueRef: string }>;
  /** Compare desired state with remote before performing a retried PATCH. */
  update(issueId: string, operation: ExternalOperationV1): Promise<void>;
  syncStatus(issueId: string): Promise<void>;
}

/** Public Agent Core V1. `accept` always takes a Host internal event id. */
export interface AgentCoreV1 {
  accept(eventId: InternalEventId): Promise<{ jobId: string }>;
  enqueue(task: AgentTaskV1): Promise<{ jobId: string }>;
  getRun(runId: string): Promise<AgentRunViewV1 | null>;
  /** Returns the exact persisted revision; caller must never infer latest. */
  requestReport(window: ReportWindowV1): Promise<{ reportId: string; revision: number }>;
}

export type AgentRunStatusV1 = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface AgentRunViewV1 {
  runId: string;
  jobId: string;
  projectId: string;
  workerId: string;
  status: AgentRunStatusV1;
  attempt: number;
  inputEventIds: ReadonlyArray<InternalEventId>;
  queuedAt: ISO8601;
  startedAt?: ISO8601;
  endedAt?: ISO8601;
  modelId?: string;
  error?: { code: string; message: string; retryable: boolean };
}

/** Durable outbound side-effects: retryability differs from local job retry. */
export type ExternalOperationStateV1 =
  | "prepared"      // persisted locally; no request attempted yet
  | "in_flight"     // request may have reached provider
  | "unknown"       // timeout/connection reset/crash in send window
  | "reconciling"   // checking authoritative provider state
  | "succeeded"     // provider identity or accepted receipt persisted
  | "safe_retry"    // proven not accepted, or provider-enforced idempotency
  | "blocked"       // permissions or definitive failure
  | "manual_review";// cannot determine; automatic resend prohibited

export type ExternalOperationKindV1 = "github.issue.create" | "github.issue.update" | "github.comment.create" | "qq.c2c.send";
export interface ExternalOperationV1 {
  operationId: UUID;
  kind: ExternalOperationKindV1;
  idempotencyKey: string; // LOCAL de-duplication only unless provider guarantees otherwise
  targetRef: string;
  correlationMarker?: string; // for GitHub body/comment, never expose private user data
  requestHash: string;
  state: ExternalOperationStateV1;
  attempt: number;
  providerObjectId?: string;
  lastError?: string;
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

export type ReconciliationDecisionV1 =
  | { kind: "found"; providerObjectId: string }
  | { kind: "absent_proven"; reason: string }
  | { kind: "still_unknown"; reason: string }
  | { kind: "conflict"; providerObjectIds: string[] };

/** Read-only reconciliation must precede retries for unknown external writes. */
export interface RecoverableIssueTrackerProviderV1 extends IssueTrackerProviderV1 {
  reconcileCreate(operation: ExternalOperationV1): Promise<ReconciliationDecisionV1>;
}


/** v0.7: notification routing is a domain policy, never a source adapter concern. */
export type DefectSeverityV1 = "P0" | "P1" | "P2" | "P3" | "unknown";

/** A Steam review or suggestion has no inherent P0 alert entitlement.
 * If review evidence establishes a critical defect, the defect signal is evaluated separately.
 */
export type NotificationSignalV1 =
  | {
      kind: "defect";
      projectId: string;
      issueId: string;
      severity: DefectSeverityV1;
      evidence: readonly EvidenceRefV1[];
      assessedAt: ISO8601;
    }
  | {
      kind: "steam_negative_review";
      projectId: string;
      reviewId: string;
      associatedIssueId?: string;
      assessedAt: ISO8601;
    }
  | {
      kind: "suggestion";
      projectId: string;
      suggestionId: string;
      assessedAt: ISO8601;
    };

/** Domain policy result. It does not itself deliver a QQ message. */
export type NotificationRoutingDecisionV1 =
  | {
      route: "p0_realtime";
      issueId: string;
      projectId: string;
      severity: "P0";
      policyVersion: string;
      reason: string;
    }
  | {
      route: "digest_only";
      projectId: string;
      policyVersion: string;
      reason: "non_p0_defect" | "steam_review" | "suggestion" | "not_confirmed_p0";
    };

export interface NotificationPolicyV1 {
  decide(signal: NotificationSignalV1): Promise<NotificationRoutingDecisionV1>;
}

/** Persisted once per issue/incident; alertGeneration changes only for material escalations. */
export interface P0AlertV1 {
  schemaVersion: "1.0";
  alertId: string;
  incidentId: string;
  issueId: string;
  projectId: string;
  severity: "P0";
  alertGeneration: number;
  title: string;
  summary: string;
  evidence: readonly EvidenceRefV1[];
  detectedAt: ISO8601;
  policyVersion: string;
  /** True means it was scheduled for sending, not delivered or read. */
  deliveryRequested: boolean;
}

/** Separate from DeliveryRequestV1 so existing reporting DeliveryPluginV1 stays source/binary compatible. */
export interface P0AlertDeliveryRequestV1 {
  deliveryId: UUID;
  idempotencyKey: string; // per incident+generation+approved recipient; local only
  projectId: string;
  alertId: string;
  recipientRef: string;
  title: string;
  markdown: string;
  requestedAt: ISO8601;
}

/** Opt-in extension; plugins without sendP0Alert MUST NOT be used for P0 delivery. */
export interface P0AlertDeliveryPluginV1 extends DeliveryPluginV1 {
  sendP0Alert(
    request: P0AlertDeliveryRequestV1,
    host: DeliveryPluginHostV1,
  ): Promise<DeliveryResultV1>;
}
