import { hiddenCrown as previousRules } from './hidden-crown-v3';
import type { RuleSet } from './contract';

// Preserve the full-turn interrogation rules of rooms already pinned to v4.
export const hiddenCrown: RuleSet = {
  ...previousRules,
  version: 4,
  availableForNewRooms: false,
  supportsUndo: false,
  canRequestUndo() { return false; },
  applyCommand(state, color, command, now) {
    if (command.type === 'request_undo' || command.type === 'respond_undo') return { error: 'undo_disabled' };
    return previousRules.applyCommand(state, color, command, now);
  }
};
