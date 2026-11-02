import type {
  NotificationSignalV1, NotificationRoutingDecisionV1, NotificationPolicyV1,
  P0AlertDeliveryPluginV1, DeliveryPluginV1, P0AlertV1, AgentTaskV1,
} from "../agent-contracts";
const p0: NotificationSignalV1 = {kind:"defect", projectId:"g", issueId:"b", severity:"P0", evidence:[], assessedAt:"2026-11-02T09:00:00Z"};
const review: NotificationSignalV1 = {kind:"steam_negative_review", projectId:"g", reviewId:"s", assessedAt:"2026-11-02T09:00:00Z"};
const allowed: NotificationRoutingDecisionV1 = {route:"p0_realtime", projectId:"g", issueId:"b", severity:"P0", policyVersion:"v1", reason:"verified"};
const digest: NotificationRoutingDecisionV1 = {route:"digest_only", projectId:"g", policyVersion:"v1", reason:"steam_review"};
// @ts-expect-error A P1 issue may not be represented as an eligible p0_realtime decision
const wrong: NotificationRoutingDecisionV1 = {route:"p0_realtime", projectId:"g", issueId:"b", severity:"P1", policyVersion:"v1", reason:"unsafe"};
// @ts-expect-error Steam review signals cannot carry defect severity
const badReview: NotificationSignalV1 = {kind:"steam_negative_review",projectId:"g",reviewId:"r",severity:"P0",assessedAt:"x"};
declare const a: P0AlertDeliveryPluginV1;
declare const legacy: DeliveryPluginV1;
// legacy plugin is NOT silently inferred to support P0
// @ts-expect-error Legacy plugin does not support urgent sends
legacy.sendP0Alert;
a.sendP0Alert;
declare const rule: NotificationPolicyV1;
rule.decide(p0);
rule.decide(review);
const task: AgentTaskV1['kind'] = 'notification.p0.deliver';
declare const alert: P0AlertV1;
alert.severity;
void [allowed,digest,wrong,badReview,task];
