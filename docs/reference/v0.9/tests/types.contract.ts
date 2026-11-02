import type {
  AgentCoreV1, AgentRunViewV1, InternalEventId, NormalizedEventV1,
  FeedbackBatchV1, EvidenceRefV1, CoverageEventV1
} from "../agent-contracts";

declare const hostId: InternalEventId;
declare const core: AgentCoreV1;
declare const run: AgentRunViewV1;
void core.accept(hostId);
void core.getRun(run.runId);
const ref: EvidenceRefV1 = { eventId: hostId };
const batch: FeedbackBatchV1 = {
  schemaVersion: "1.0", batchId: "batch", projectId: "p", sourceId: "s", segmentIds: ["seg"],
  candidateEventIds: [hostId], contextEventIds: [hostId], policyVersion: "1", revision: 1,
  reason: "urgent", createdAt: "2026-11-02T10:00:00Z"
};
void [ref, batch];

// @ts-expect-error CloudEvents source-local id is not assignable to Host internal ID
core.accept("ev-platform-001");
// @ts-expect-error EvidenceRef requires Host internal ID
const badRef: EvidenceRefV1 = { eventId: "ev-platform-001" };
void badRef;

const valid: NormalizedEventV1 = {
  specversion: "1.0", id: "platform-event", source: "urn:source:1",
  type: "com.superagent.feedback.message.created.v1", time: "2026-11-02T10:00:00Z",
  datacontenttype: "application/json", data: {
    schemaVersion: "1.0", projectId: "p", sourceId: "s", platform: "qq-official",
    object: { kind: "message", externalId: "message-1", revision: "original" }
  }
};
void valid;

// @ts-expect-error a message.created event cannot carry kind=review
const mismatchedKind: NormalizedEventV1 = {
  ...valid, type: "com.superagent.feedback.message.created.v1",
  data: { schemaVersion: "1.0", projectId: "p", sourceId: "s", platform: "qq-official",
    object: { kind: "review", externalId: "x", revision: "original" } }
};
void mismatchedKind;
const mismatchedCoverage: CoverageEventV1 = {
  ...valid, type: "com.superagent.source.coverage.changed.v1",
  // @ts-expect-error a coverage event must contain CoverageData, not FeedbackData
  data: valid.data
};
void mismatchedCoverage;
