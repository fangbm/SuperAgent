import { seedSteamReviewCommentsCheckpoint } from '@superagent/connector-steam-reviews';

/** Trusted application preparation; plugins never inspect the archive or rewrite events. */
export function initializeSteamReviewComments({ runtime, entry, binding }) {
  return runtime.store.transaction(() => {
    const scope = { projectId: binding.projectId, sourceId: binding.sourceId };
    const previous = runtime.ingress.getCheckpoint(scope);
    const events = previous?.version === 2 ? [] : runtime.store.all(`
      SELECT e.payload_json FROM source_objects o JOIN source_events e ON e.event_id=o.event_id
      WHERE o.source_id=? AND e.project_id=? AND e.source_id=? AND o.object_kind='comment'
      ORDER BY o.external_id`, scope.sourceId, scope.projectId, scope.sourceId).map(row => JSON.parse(row.payload_json));
    let cursor;
    try { cursor = seedSteamReviewCommentsCheckpoint(entry.config, previous, events, scope); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('INVALID_EVENT')) throw new Error('INVALID_CHECKPOINT: archived comment projection mismatch', { cause:error });
      throw error;
    }
    if (previous?.version !== 2) runtime.ingress.commitBatch(scope, [], { sourceId: scope.sourceId, cursor });
    return cursor.nextEligibleAt;
  });
}

export function initializePublicSteamDiscussions({ runtime, entry, binding }) {
  if (entry.config.mode !== 'public') return;
  return runtime.ingress.getCheckpoint({ projectId:binding.projectId, sourceId:binding.sourceId })?.retryAfter;
}
