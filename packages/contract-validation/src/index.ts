import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formatsPlugin } from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type {
  NormalizedEventV1, PluginManifestV1, FeedbackBatchV1, TriageResultV2,
  ReportV2, ReportPresentationV1, NotificationRoutingDecisionV1, P0AlertV1,
  CommitResultV1, DeliveryRequestV1, DeliveryResultV1, P0AlertDeliveryRequestV1,
  AgentTaskV1,
} from '@superagent/contracts';

export interface ContractTypes {
  'normalized-event-v1': NormalizedEventV1;
  'plugin-manifest-v1': PluginManifestV1;
  'feedback-batch-v1': FeedbackBatchV1;
  'triage-result-v2': TriageResultV2;
  'report-v2': ReportV2;
  'report-presentation-v1': ReportPresentationV1;
  'notification-routing-decision-v1': NotificationRoutingDecisionV1;
  'p0-alert-v1': P0AlertV1;
  'commit-result-v1': CommitResultV1;
  'delivery-request-v1': DeliveryRequestV1;
  'delivery-result-v1': DeliveryResultV1;
  'p0-alert-delivery-request-v1': P0AlertDeliveryRequestV1;
  'agent-task-v1': AgentTaskV1;
}
export type ContractName = keyof ContractTypes;
export const contractNames = [
  'normalized-event-v1', 'plugin-manifest-v1', 'feedback-batch-v1',
  'triage-result-v2', 'report-v2', 'report-presentation-v1',
  'notification-routing-decision-v1', 'p0-alert-v1', 'commit-result-v1',
  'delivery-request-v1', 'delivery-result-v1', 'p0-alert-delivery-request-v1',
  'agent-task-v1',
] as const satisfies readonly ContractName[];

/** Diagnostics contain locations and rule names, never the rejected source text/secrets. */
export interface ContractViolation {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
}
export type ContractValidation<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly errors: readonly ContractViolation[] };

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Upstream branches constrain properties declared by their parent schema.
  strictRequired: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
// The CommonJS package exposes its typed callable on .default under NodeNext.
formatsPlugin.default(ajv);
const validators = new Map<ContractName, ValidateFunction>();
for (const name of contractNames) {
  const schema: object = require(`@superagent/contracts/schemas/${name}.schema.json`);
  ajv.addSchema(schema, name);
}
for (const name of contractNames) {
  const validator = ajv.getSchema(name);
  if (!validator) throw new Error(`Missing contract schema: ${name}`);
  validators.set(name, validator);
}

function violations(errors: ErrorObject[] | null | undefined): ContractViolation[] {
  return (errors ?? []).map(({ instancePath, schemaPath, keyword }) => ({ instancePath, schemaPath, keyword }));
}

/** JSONValue also excludes functions, bigint, cyclic graphs and non-finite numbers. */
function invalidJSON(input: unknown): ContractViolation | undefined {
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; exit?: boolean }> = [{ value: input, path: '' }];
  while (stack.length) {
    const current = stack.pop()!;
    const value = current.value;
    if (typeof value === 'object' && value !== null) {
      if (current.exit) { ancestors.delete(value); continue; }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (ancestors.has(value) || (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)) {
        return { instancePath: current.path, schemaPath: '#/json-value', keyword: 'json' };
      }
      ancestors.add(value);
      stack.push({ ...current, exit: true });
      const entries: Array<[string, unknown]> = Array.isArray(value)
        ? Array.from({ length: value.length }, (_, index) => [String(index), value[index]])
        : Object.entries(value);
      for (const [key, child] of entries) {
        const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
        stack.push({ value: child, path: `${current.path}/${escaped}` });
      }
    } else if (!(value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)))) {
      return { instancePath: current.path, schemaPath: '#/json-value', keyword: 'json' };
    }
  }
  return undefined;
}

/** Shape validation only. Host must still resolve event ownership and domain invariants. */
export function validateContract<K extends ContractName>(name: K, input: unknown): ContractValidation<ContractTypes[K]> {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown contract: ${name}`);
  const jsonError = invalidJSON(input);
  if (jsonError) return { valid: false, errors: [jsonError] };
  if (!validator(input)) return { valid: false, errors: violations(validator.errors) };
  return { valid: true, value: input as ContractTypes[K] };
}

export class ContractValidationError extends Error {
  constructor(readonly contract: ContractName, readonly violations: readonly ContractViolation[]) {
    super(`Invalid contract: ${contract}`);
    this.name = 'ContractValidationError';
  }
}

export function parseContract<K extends ContractName>(name: K, input: unknown): ContractTypes[K] {
  const result = validateContract(name, input);
  if (!result.valid) throw new ContractValidationError(name, result.errors);
  return result.value;
}
