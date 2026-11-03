import type { InternalEventId, JSONValue, NormalizedEventV1 } from '@superagent/contracts';
import { canonicalJSON } from '@superagent/persistence';
import { parseContract } from '@superagent/contract-validation';
import type { IngressService, SourceScope } from '@superagent/ingress';
import { DurableCommunityState } from './community-state.js';

type TicketStatus = 'pending_create' | 'creating' | 'unknown_create' | 'open' | 'closed' | 'blocked' | 'delete_pending' | 'deleting' | 'deleted' | 'unknown_delete';
type Ticket = { version: 1; id: string; userId: string; kind: 'bug' | 'suggestion' | 'help'; status: TicketStatus; evidenceEventId: string; createdAt: string; createMarker: string };
export interface CommunitySubmissionResult { status: 'created' | 'replayed' | 'existing'; ticketId: string; eventId: string }
export interface CommunityRecoverySummary { recovered: number; staleLocksCleared: number }
export interface CommunitySubmissionOptions { scope: SourceScope; guildId: string; clock?: () => string }
const ticketKey = (id: string) => `ticket:${id}`;
const openKey = (id: string) => `ticket:open:${id}`;
const interactionKey = (id: string) => `interaction:${id}`;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const isTicket = (value: unknown): value is Ticket => obj(value) && value.version === 1 && str(value.id) && str(value.userId)
  && ['bug', 'suggestion', 'help'].includes(String(value.kind))
  && ['pending_create', 'creating', 'unknown_create', 'open', 'closed', 'blocked', 'delete_pending', 'deleting', 'deleted', 'unknown_delete'].includes(String(value.status))
  && str(value.evidenceEventId) && str(value.createdAt) && str(value.createMarker);
const active = (value: unknown): value is Ticket => isTicket(value) && !['closed', 'deleted'].includes(value.status);
interface TicketSubmission { id: string; userId: string; kind: Ticket['kind']; title: string; body: string }

function ticketSubmission(event: NormalizedEventV1, scope: SourceScope, guildId: string): TicketSubmission | null {
  if (event.type !== 'com.superagent.feedback.message.created.v1') return null;
  const data = event.data as unknown as Record<string, unknown>;
  const attrs = obj(data.attributes) ? data.attributes : null;
  const native = attrs && obj(attrs.native) ? attrs.native : null;
  const actor = obj(data.actor) ? data.actor : null;
  const object = obj(data.object) ? data.object : null;
  const content = obj(data.content) ? data.content : null;
  if (data.projectId !== scope.projectId || data.sourceId !== scope.sourceId || data.platform !== 'discord'
    || attrs?.guildId !== guildId || !str(attrs.interactionId) || !/^\d{1,22}$/.test(attrs.interactionId)
    || event.id !== `discord-community:${attrs.interactionId}` || !str(actor?.opaqueId) || !/^\d{1,22}$/.test(actor.opaqueId)
    || !object || object.kind !== 'message' || object.externalId !== attrs.interactionId || !native
    || native.interactionId !== attrs.interactionId || native.kind !== attrs.ticketKind
    || !['bug', 'suggestion', 'help'].includes(String(attrs.ticketKind))
    || !str(native.title) || !native.title.trim() || native.title.length > 120
    || !str(native.body) || !native.body.trim() || native.body.length > 3500
    || content?.text !== `[${String(attrs.ticketKind)}] ${native.title}\n\n${native.body}`) return null;
  return { id: attrs.interactionId, userId: actor.opaqueId, kind: attrs.ticketKind as Ticket['kind'], title: native.title, body: native.body };
}

/** Core-owned atomic archive plus lifecycle initialization for private Discord tickets. */
export class CommunitySubmissions {
  private readonly leaseGeneration: number | null;
  constructor(readonly ingress: IngressService, readonly state: DurableCommunityState, readonly options: CommunitySubmissionOptions) {
    if (!options.scope.projectId.trim() || !options.scope.sourceId.trim() || !/^\d{1,22}$/.test(options.guildId)
      || state.namespace !== `discord-community:${options.guildId}`) throw new Error('INVALID_COMMUNITY_SUBMISSION_BINDING');
    this.leaseGeneration = state.getLeaseGeneration();
    if (this.leaseGeneration === null) throw new Error('COMMUNITY_LEASE_REQUIRED');
  }

  submitTicket(input: NormalizedEventV1): CommunitySubmissionResult {
    const event = parseContract('normalized-event-v1', input) as Extract<NormalizedEventV1, { type: 'com.superagent.feedback.message.created.v1' }>;
    const payload = ticketSubmission(event, this.options.scope, this.options.guildId);
    if (!payload) throw new Error('COMMUNITY_TICKET_EVENT_NOT_AUTHORIZED');
    const { id, userId, kind } = payload;
    return this.ingress.store.transaction(() => {
      this.state.assertLease(this.leaseGeneration);
      const binding = this.ingress.store.get<{ source_uri: string; platform: string; visibility: string; processing_mode: string }>(`SELECT s.source_uri,s.platform,p.visibility,p.processing_mode
        FROM sources s JOIN source_policies p USING(source_id) WHERE s.project_id=? AND s.source_id=?`, this.options.scope.projectId, this.options.scope.sourceId);
      if (!binding || binding.visibility !== 'staff' || binding.processing_mode !== 'archive_only'
        || event.source !== binding.source_uri || binding.platform !== 'discord') throw new Error('COMMUNITY_TICKET_SOURCE_NOT_PRIVATE');
      const prior = this.state.getSync(interactionKey(id));
      if (prior) {
        const saved = obj(prior) && str(prior.ticketId) && str(prior.eventId) ? { ticketId: prior.ticketId, eventId: prior.eventId } : null;
        const archived = saved ? this.ingress.getEvent(this.options.scope.projectId, saved.eventId as InternalEventId) : undefined;
        if (!saved || !archived || canonicalJSON(archived.event as unknown as JSONValue) !== canonicalJSON(event as unknown as JSONValue)) throw new Error('COMMUNITY_INTERACTION_IDENTITY_CONFLICT');
        return { status: 'replayed', ticketId: saved.ticketId, eventId: saved.eventId };
      }
      const committed = this.ingress.commitBatch(this.options.scope, [event]);
      const ref = committed.refs[0]; if (!ref) throw new Error('ARCHIVE_COMMIT_MISSING_REF');
      let open = this.state.getSync(openKey(userId));
      if (typeof open === 'string' && open.startsWith('pending:')) {
        this.recover();
        open = this.state.getSync(openKey(userId));
      }
      const existing = typeof open === 'string' && open && !open.startsWith('pending:') ? this.state.getSync(ticketKey(open)) : null;
      if (active(existing) && existing.userId === userId && existing.id === open) {
        this.state.setSync(interactionKey(id), { status: 'archived', ticketId: existing.id, eventId: ref.eventId });
        return { status: 'existing', ticketId: existing.id, eventId: ref.eventId };
      }
      const ticket: Ticket = { version: 1, id, userId, kind: kind as Ticket['kind'], status: 'pending_create', evidenceEventId: ref.eventId,
        createdAt: event.time, createMarker: `superagent-ticket:${id}` };
      this.state.setSync(ticketKey(id), ticket as unknown as JSONValue);
      this.state.setSync(openKey(userId), id);
      this.state.setSync(interactionKey(id), { status: 'archived', ticketId: id, eventId: ref.eventId });
      return { status: committed.accepted ? 'created' : 'replayed', ticketId: id, eventId: ref.eventId };
    });
  }

  recover(): CommunityRecoverySummary {
    return this.ingress.store.transaction(() => {
      this.state.assertLease(this.leaseGeneration);
      const binding = this.ingress.store.get<{ source_uri: string; visibility: string; processing_mode: string }>(`SELECT s.source_uri,p.visibility,p.processing_mode
        FROM sources s JOIN source_policies p USING(source_id) WHERE s.project_id=? AND s.source_id=?`, this.options.scope.projectId, this.options.scope.sourceId);
      if (!binding || binding.visibility !== 'staff' || binding.processing_mode !== 'archive_only') throw new Error('COMMUNITY_TICKET_SOURCE_NOT_PRIVATE');
      let recovered = 0; let staleLocksCleared = 0;
      const rows = this.ingress.store.all<{ event_id: string; payload_json: string }>(`SELECT event_id,payload_json FROM source_events WHERE project_id=? AND source_id=? ORDER BY received_at,event_id`, this.options.scope.projectId, this.options.scope.sourceId);
      const activeByUser = new Map<string, Ticket[]>();
      for (const entry of this.state.listSync('ticket:')) {
        if (entry.key.startsWith('ticket:open:') || !active(entry.value) || entry.key !== ticketKey(entry.value.id)) continue;
        const tickets = activeByUser.get(entry.value.userId) ?? [];
        tickets.push(entry.value);
        activeByUser.set(entry.value.userId, tickets);
      }
      for (const tickets of activeByUser.values()) tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      for (const row of rows) {
        let event: NormalizedEventV1;
        try { event = JSON.parse(row.payload_json) as NormalizedEventV1; } catch { continue; }
        if (event.source !== binding.source_uri) continue;
        const payload = ticketSubmission(event, this.options.scope, this.options.guildId);
        if (!payload) continue;
        const { id, userId, kind } = payload;
        const interaction = this.state.getSync(interactionKey(id));
        const open = this.state.getSync(openKey(userId));
        const activeTicket = typeof open === 'string' && open ? this.state.getSync(ticketKey(open)) : null;
        const ownTicket = this.state.getSync(ticketKey(id));
        const mappedId = obj(interaction) && str(interaction.ticketId) ? interaction.ticketId : undefined;
        const activeForUser = active(activeTicket) && activeTicket.userId === userId && activeTicket.id === open
          ? activeTicket : activeByUser.get(userId)?.[0];
        const ticketId = mappedId ?? (isTicket(ownTicket) ? id : activeForUser?.id ?? id);
        let repaired = false; let createdTicket = false;
        if (!ownTicket && !mappedId && !activeForUser) {
          const ticket: Ticket = { version: 1, id, userId, kind, status: 'pending_create', evidenceEventId: row.event_id, createdAt: event.time, createMarker: `superagent-ticket:${id}` };
          this.state.setSync(ticketKey(id), ticket as unknown as JSONValue);
          const tickets = activeByUser.get(userId) ?? [];
          tickets.push(ticket); tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
          activeByUser.set(userId, tickets);
          repaired = true; createdTicket = true;
        }
        if (activeForUser && open !== activeForUser.id) {
          this.state.setSync(openKey(userId), activeForUser.id); repaired = true;
        } else if (createdTicket && (!open || open === '' || open === `pending:${id}` || (typeof open === 'string' && !open.startsWith('pending:') && !active(activeTicket)))) {
          this.state.setSync(openKey(userId), id); repaired = true;
        } else if (!activeForUser && typeof open === 'string' && open && !open.startsWith('pending:') && !createdTicket) {
          this.state.setSync(openKey(userId), ''); repaired = true;
        }
        if (!interaction) { this.state.setSync(interactionKey(id), { status: 'archived', ticketId, eventId: row.event_id }); repaired = true; }
        if (repaired) recovered++;
      }
      for (const { key, value } of this.state.listSync('ticket:open:')) {
        if (typeof value !== 'string' || !value.startsWith('pending:')) continue;
        const id = value.slice('pending:'.length);
        const exists = this.ingress.store.get(`SELECT 1 FROM source_events WHERE project_id=? AND source_id=? AND external_event_id=?`, this.options.scope.projectId, this.options.scope.sourceId, `discord-community:${id}`);
        if (!exists) { this.state.setSync(key, ''); staleLocksCleared++; }
      }
      return { recovered, staleLocksCleared };
    });
  }
}
