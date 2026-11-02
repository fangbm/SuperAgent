import type { StructuredModel } from '@superagent/llm';
import type { AnalysisWorker } from '@superagent/agent-workers';
import type { DomainService } from '@superagent/domain';
import type { SourcePluginHostV1 } from '@superagent/plugin-sdk';
declare const model: StructuredModel;
declare const analysis: AnalysisWorker;
declare const domain: DomainService;
declare const source: SourcePluginHostV1;
void analysis.getRun('run');
void analysis.tick(new AbortController().signal);
void model.modelId;
void domain.getWork('project','defect','issue');
// @ts-expect-error Source plugins cannot execute model or domain operations
source.generateStructured;
// @ts-expect-error Search/write kinds are closed
domain.getWork('project','arbitrary-external-send','issue');
