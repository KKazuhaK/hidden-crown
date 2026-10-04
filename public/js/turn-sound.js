export function startsYourTurn(before, after) {
  return !!before && after.phase === 'playing' && ['w', 'b'].includes(after.role) && after.turn === after.role && !after.undoRequest &&
    (before.phase !== 'playing' || before.turn !== after.turn || !!before.undoRequest && after.moves.length < before.moves.length);
}

// Browsers require a user gesture before audio can play. Create/resume the
// context in that gesture and keep game state independent of audio support.
export function createTurnSound(storage = globalThis.localStorage, Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext) {
  let enabled = storage.getItem('hidden-crown:turn-sound') !== 'off', context;
  function unlock() {
    if (!enabled || !Audio) return;
    try { context ??= new Audio(); if (context.state === 'suspended') context.resume().catch(() => {}); } catch { /* Audio unavailable. */ }
  }
  return {
    get enabled() { return enabled; },
    toggle() { enabled = !enabled; storage.setItem('hidden-crown:turn-sound', enabled ? 'on' : 'off'); if (enabled) { unlock(); this.play(); } return enabled; },
    unlock,
    play() {
      if (!enabled || !context || context.state !== 'running') return false;
      try {
        const at = context.currentTime, gain = context.createGain(), tone = context.createOscillator();
        tone.type = 'sine'; tone.frequency.setValueAtTime(660, at); tone.frequency.setValueAtTime(880, at + 0.09);
        gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.045, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.24);
        tone.connect(gain); gain.connect(context.destination); tone.start(at); tone.stop(at + 0.25);
        tone.onended = () => { tone.disconnect(); gain.disconnect(); }; return true;
      } catch { return false; }
    }
  };
}
