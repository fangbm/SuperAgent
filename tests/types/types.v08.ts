import type { ReportV2, ReportV2Legacy, ReportSnapshotStoreV1, SteamNegativeReviewSnapshotMemberV1, AgentCoreV1 } from '@superagent/contracts';

declare const report: ReportV2;
declare const legacy: ReportV2Legacy;
declare const snapshots: ReportSnapshotStoreV1;
declare const core: AgentCoreV1;
const n: number = report.revision;
const cutoff: string = report.snapshotCutoffAt;
const member: SteamNegativeReviewSnapshotMemberV1 = report.steamNegativeReviews[0]!;
const eventId = member.evidenceEventId;
void [n,cutoff,eventId];
const get = snapshots.getExact(report.reportId, report.revision);
const request = core.requestReport(report.window);
void [get,request];
// @ts-expect-error old schema cannot be used as v0.8 writable report
const oldAsNew: ReportV2 = legacy;
// @ts-expect-error must include snapshot revision
const invalid: ReportV2 = { schemaVersion: '2.1', reportId:'r' };
void [oldAsNew, invalid];
