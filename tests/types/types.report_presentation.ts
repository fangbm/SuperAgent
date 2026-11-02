import type { ReportPresentationV1, ReportNavigationActionV1, DeliveryRequestV1, ReportNavigationQueryV1 } from '@superagent/contracts';

const actions = [
  {kind:'report.open_section',section:'bugs',label:'查看 Bug'},
  {kind:'report.open_section',section:'suggestions',label:'查看建议'},
  {kind:'report.open_section',section:'steam_negative_reviews',label:'查看 Steam 差评'}
] as const satisfies readonly ReportNavigationActionV1[];
const presentation: ReportPresentationV1 = {
  schemaVersion: '1.0', kind: 'report_summary', format: 'markdown', reportId:'report1',revision:1,actions
};
const req: DeliveryRequestV1 = {deliveryId:'d', idempotencyKey:'key',projectId:'p',reportId:'report1',recipientRef:'dev',title:'半日报',text:'test',requestedAt:'2026-11-02T10:00:00Z',presentation};
const query: ReportNavigationQueryV1 = {reportId:'report1',reportRevision:1,section:'bugs',actorRef:'approved-actor',interactionId:'int1',limit:3};
void req;void query;
// @ts-expect-error no invalid section
const invalid: ReportNavigationActionV1 = {kind:'report.open_section',section:'other',label:'其他'};
void invalid;
