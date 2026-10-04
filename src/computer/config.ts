import type { ComputerConfig, RuleSelection } from '../types';
import { opposite } from '../engine';
export const difficulties = ['easy', 'medium', 'hard'] as const;
export function computerRequest(input: unknown, rules: RuleSelection, random: () => number): ComputerConfig {
  if (rules.id !== 'hidden-crown' || ![1, 2].includes(rules.version)) throw new Error('computer_unavailable');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_computer');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['humanColor', 'difficulty'].includes(key)) || !['w', 'b', 'random'].includes(String(value.humanColor)) || !difficulties.includes(value.difficulty as ComputerConfig['difficulty'])) throw new Error('invalid_computer');
  const human = value.humanColor === 'random' ? (random() < .5 ? 'w' : 'b') : value.humanColor as 'w' | 'b';
  return { color: opposite(human), difficulty: value.difficulty as ComputerConfig['difficulty'] };
}
