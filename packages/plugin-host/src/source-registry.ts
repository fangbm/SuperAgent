import type { IngressService, SourceBinding, SourcePolicy, SourceScope } from '@superagent/ingress';
import type { SourcePluginHostV1 } from '@superagent/plugin-sdk';

export interface ConfiguredSource extends SourceBinding { policy: SourcePolicy }
type SourceHostOptions = NonNullable<Parameters<IngressService['sourceHost']>[1]>;

function validate(entries: readonly ConfiguredSource[]): readonly ConfiguredSource[] {
  if (!Array.isArray(entries)) throw new Error('INVALID_SOURCE_CONFIGURATION');
  const ids = new Set<string>();
  const uris = new Set<string>();
  return Object.freeze(entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('INVALID_SOURCE_BINDING');
    const { projectId, sourceId, sourceUri, platform, policy } = entry;
    if ([projectId, sourceId, sourceUri, platform].some(value => typeof value !== 'string' || !value.trim())) throw new Error('INVALID_SOURCE_BINDING');
    try { new URL(sourceUri); } catch { throw new Error('INVALID_SOURCE_URI'); }
    if (ids.has(sourceId)) throw new Error('DUPLICATE_SOURCE_ID');
    if (uris.has(sourceUri)) throw new Error('DUPLICATE_SOURCE_URI');
    ids.add(sourceId);
    uris.add(sourceUri);
    if (!policy || !['standard', 'archive_only'].includes(policy.processingMode) || !['public', 'staff'].includes(policy.visibility)
      || (policy.visibility === 'staff' && policy.processingMode !== 'archive_only')) throw new Error('INVALID_SOURCE_POLICY');
    return Object.freeze({ projectId, sourceId, sourceUri, platform, policy: Object.freeze({ ...policy }) });
  }));
}

/** Trusted Core configuration for source identity, policy, and scoped plugin access. */
export class TrustedSourceRegistry {
  private readonly entries: readonly ConfiguredSource[];
  private readonly byScope = new Map<string, ConfiguredSource>();

  constructor(private readonly ingress: IngressService, entries: readonly ConfiguredSource[]) {
    this.entries = validate(entries);
    for (const entry of this.entries) this.byScope.set(this.key(entry), entry);
  }

  private key(scope: SourceScope): string { return JSON.stringify([scope.projectId, scope.sourceId]); }

  apply(): void {
    // Revalidate before any write in case the constructor's input was mutated through an unsafe cast.
    const entries = validate(this.entries);
    this.ingress.store.transaction(() => {
      for (const { projectId, sourceId, sourceUri, platform, policy } of entries) {
        const binding = { projectId, sourceId, sourceUri, platform };
        this.ingress.registerSource(binding);
        const current = this.ingress.store.get<{ processing_mode: string; visibility: string }>(
          'SELECT processing_mode,visibility FROM source_policies WHERE source_id=?', sourceId);
        if (current && current.processing_mode === policy.processingMode && current.visibility === policy.visibility) continue;
        this.ingress.setSourcePolicy({ projectId, sourceId }, policy);
      }
    });
  }

  binding(scope: SourceScope): SourceBinding {
    const entry = this.byScope.get(this.key(scope));
    if (!entry) throw new Error('SOURCE_NOT_AUTHORIZED');
    return Object.freeze({ projectId: entry.projectId, sourceId: entry.sourceId, sourceUri: entry.sourceUri, platform: entry.platform });
  }

  sourceHost(scope: SourceScope, options?: SourceHostOptions): SourcePluginHostV1 {
    this.binding(scope);
    return this.ingress.sourceHost(scope, options);
  }
}
