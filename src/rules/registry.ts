import type { RuleSelection } from '../types';
import type { RuleSet } from './contract';
import { hiddenCrown } from './hidden-crown';
import { hiddenCrown as hiddenCrownV1 } from './hidden-crown-v1';
import { hiddenCrown as hiddenCrownV2 } from './hidden-crown-v2';

export class RuleRegistry {
  private readonly entries = new Map<string, RuleSet>();
  constructor(definitions: RuleSet[]) {
    for (const rules of definitions) {
      const key = `${rules.id}@${rules.version}`;
      if (this.entries.has(key)) throw new Error('duplicate_ruleset');
      this.entries.set(key, rules);
    }
  }
  resolve(selection: Pick<RuleSelection, 'id' | 'version'>) {
    const rules = this.entries.get(`${selection.id}@${selection.version}`);
    if (!rules) throw new Error('unsupported_ruleset');
    return rules;
  }
  selection(input: unknown = { id: 'hidden-crown', version: 3 }) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_ruleset');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['id', 'version', 'options'].includes(key)) || typeof value.id !== 'string' || value.id.length > 64 || !Number.isSafeInteger(value.version)) throw new Error('invalid_ruleset');
    const rules = this.resolve({ id: value.id, version: Number(value.version) });
    return { id: rules.id, version: rules.version, options: rules.normalizeOptions(value.options ?? {}) };
  }
  list() { return [...this.entries.values()].map(rules => ({ id: rules.id, version: rules.version, name: rules.name, defaultOptions: rules.normalizeOptions({}) })); }
}
export const ruleRegistry = new RuleRegistry([hiddenCrown, hiddenCrownV2, hiddenCrownV1]);
