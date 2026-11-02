import type {
  FeedbackItemV2, TriageResultV2, SuggestionMatchResultV1,
  SuggestionActionRequestV1, AgentContextV2, InternalEventId, ReportV2
} from '@superagent/contracts';
declare const hostId: InternalEventId;
const mixed: TriageResultV2 = {
  schemaVersion: '2.0', batchId: 'b', pipelineVersion: 'triage-v2.0', revision: 1,
  items: [
    { kind:'defect', category:'bug', title:'崩溃', description:'联机崩溃', confidence:0.8,
      observedBehavior:'退出', evidence:[{eventId:hostId,role:'primary'}]},
    { kind:'suggestion', category:'feature_request', title:'自动重连', description:'希望自动重连', confidence:0.8,
      requestedOutcome:'自动重连', evidence:[{eventId:hostId,role:'primary'}]}
  ], requiresHumanReview: false
};
void mixed;
// @ts-expect-error feature_request cannot be a defect category
const badDefect: FeedbackItemV2 = { kind:'defect', category:'feature_request', title:'x', description:'x', confidence:1, observedBehavior:'x', evidence:[{eventId:hostId,role:'primary'}] };
void badDefect;
// @ts-expect-error bug cannot be a suggestion category
const badSuggestion: FeedbackItemV2 = { kind:'suggestion', category:'bug', title:'x', description:'x', confidence:1, requestedOutcome:'x', evidence:[{eventId:hostId,role:'primary'}] };
void badSuggestion;
const match: SuggestionMatchResultV1 = {candidateSuggestionId:'SUG-1',relationship:'uncertain',matchingOutcome:[],conflictingRequirements:[],distinguishingDetails:[],evidence:[],rationale:'missing context'};
void match;
const action: SuggestionActionRequestV1 = { suggestionId:'SUG-1', action:'implement', expectedVersion:2,actorRef:'dev1',source:'qq',interactionId:'cb1'};
void action;
declare const ctx: AgentContextV2;
void ctx.suggestions.search('controller',5);
declare const report: ReportV2;
void report.counts.newSuggestionItems;
