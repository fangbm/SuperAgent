/** Plugin authors depend on this boundary; platform adapters never import Host internals. */
export type {
  ISO8601, UUID, JSONPrimitive, JSONValue,
  PlatformId, EventType, FeedbackEventTypeV1, SourceObjectKind, SourceCoverage,
  FeedbackContentV1, FeedbackDataV1, CoverageDataV1,
  NormalizedEventV1, FeedbackEventV1, CoverageEventV1,
  InternalEventId, PersistedEventRefV1,
  PluginManifestV1, ConnectorCapabilityV1, PluginErrorCode, PluginLogger,
  SyncCheckpointV1, CommitResultV1,
  SourcePluginHostV1, SourcePluginV1,
  DeliveryRequestV1, DeliveryStatus, DeliveryResultV1,
  DeliveryPluginHostV1, DeliveryPluginV1,
  ReportPresentationV1, ReportNavigationActionV1, ReportSectionV1,
  P0AlertDeliveryRequestV1, P0AlertDeliveryPluginV1,
} from '@superagent/contracts';
