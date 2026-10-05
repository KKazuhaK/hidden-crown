import { hiddenCrown as previousRules } from './hidden-crown-v3';
import type { RuleSet } from './contract';
export { crownCandidate, interrogationTargets } from './hidden-crown-v3';

// Historical rooms keep their pinned rules. New games cannot rewind information
// revealed by a capture, even when the opponent or computer would agree.
export const hiddenCrown: RuleSet = {
  ...previousRules,
  version: 4,
  availableForNewRooms: true,
  supportsUndo: false,
  canRequestUndo() { return false; },
  applyCommand(state, color, command, now) {
    if (command.type === 'request_undo' || command.type === 'respond_undo') return { error: 'undo_disabled' };
    return previousRules.applyCommand(state, color, command, now);
  }
};
