// Host consumers use Node types; the separate SDK type suite stays platform-neutral.
import type { M1Runtime } from '@superagent/agent-core';
import type { InternalEventId, SourcePluginHostV1 } from '@superagent/contracts';

declare const runtime: M1Runtime;
declare const eventId: InternalEventId;
const host: SourcePluginHostV1 = runtime.ingress.sourceHost({ projectId: 'p', sourceId: 's' });
void host.getCheckpoint();
void runtime.accept(eventId);
void runtime.buffer.reprocessArchived(eventId, 'request', 'developer', 'audit');
void runtime.queue.claim('worker', 'admission');
// @ts-expect-error Internal IDs cannot be substituted with a platform string
void runtime.accept('platform-message-id');
// @ts-expect-error Platform plugins receive the Host facade, never SQLite access
void host.store;
// @ts-expect-error Queue lane names are a closed set
void runtime.queue.claim('worker', 'arbitrary-network');
