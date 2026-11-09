/** Parameter value rules (03-simulation-engine.yaml state_model.reducer_rules). */
import type { Json, ParameterSpec } from './types.ts';

/** Returns why `value` is not allowed for the parameter, or undefined if it is. */
export function parameterProblem(
  name: string,
  spec: ParameterSpec,
  value: Json,
): string | undefined {
  if (typeof value !== typeof spec.default) {
    return `${name} must be a ${typeof spec.default}, not ${JSON.stringify(value)}`;
  }
  if (spec.options && !spec.options.some((option) => option === value)) {
    return `${name} ${JSON.stringify(value)} is not one of ${spec.options.map((o) => JSON.stringify(o)).join(', ')}`;
  }
  if (typeof value === 'number') {
    const { min, max } = spec;
    if (!Number.isFinite(value)) return `${name} must be a finite number`;
    if (Number.isInteger(spec.default) && !Number.isInteger(value))
      return `${name} must be a whole number`;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      return `${name} ${value} is outside ${String(min)}..${String(max)}`;
    }
  }
  return undefined;
}
