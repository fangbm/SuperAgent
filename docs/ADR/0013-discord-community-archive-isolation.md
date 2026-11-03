# ADR 0013: Discord community features and private archive isolation

Status: implemented, 2026-11-03; live deployment pending.

Use the existing collector Gateway and Source Host. Store ticket/room entity state in the existing SQLite file, behind a narrow trusted Host interface. Platform packages do not import database/Core implementations.

Private tickets use a separate private project and permanent archive-only source policy. Outbox dispatch, admission/forced replay and model evidence access enforce that policy. Mixed public/private source projects and private-to-public policy downgrade are rejected. Sources without policies retain existing behavior. The community runner keeps public sources archive-only for this rollout as well.

Original source events remain canonical; lifecycle state keeps references. Archive submissions before acceptance and flush history before destructive actions. Advance the shared Gateway sequence only after routed commits/intents; persist first-observation time without persisting interaction tokens/private payloads in its checkpoint.

Lease fencing and entity/provider markers handle interrupted effects. Add migrations012/013 rather than altering frozen migrations, SDK contracts or job/external-operation kinds. Do not create a second queue/database or change QQ/M3 business workflows. Actual Discord permissions and container execution remain separate from local Host/transport verification.
