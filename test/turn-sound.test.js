import { describe, expect, it } from 'vitest';
import { startsYourTurn, createTurnSound } from '../public/js/turn-sound.js';
const playing = { role: 'w', phase: 'playing', turn: 'w', moves: [] };
describe('turn notifications', () => {
  it('sounds on actual turn transitions and accepted undo without duplicate reconnect/presence sounds', () => {
    expect(startsYourTurn(null, playing)).toBe(false);
    expect(startsYourTurn(playing, { ...playing, revision: 2 })).toBe(false);
    expect(startsYourTurn({ ...playing, phase: 'crown_select' }, playing)).toBe(true);
    expect(startsYourTurn({ ...playing, turn: 'b' }, playing)).toBe(true);
    expect(startsYourTurn({ ...playing, turn: 'b' }, { ...playing, role: 'observer' })).toBe(false);
    expect(startsYourTurn(playing, { ...playing, phase: 'ended' })).toBe(false);
    expect(startsYourTurn({ ...playing, undoRequest: { color: 'w' }, moves: [{}] }, playing)).toBe(true);
    expect(startsYourTurn({ ...playing, undoRequest: { color: 'w' } }, playing)).toBe(false);
    expect(startsYourTurn({ ...playing, turn: 'b' }, { ...playing, undoRequest: { color: 'b' } })).toBe(false);
  });
  it('respects gesture unlocking, persistent mute and browsers without audio', () => {
    const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    let tones = 0;
    class Audio {
      state = 'running'; currentTime = 0; destination = {};
      createOscillator() { tones++; return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    }
    const sound = createTurnSound(storage, Audio);
    expect(sound.play()).toBe(false); sound.unlock(); expect(sound.play()).toBe(true); expect(tones).toBe(1);
    sound.toggle(); expect(sound.enabled).toBe(false); expect(sound.play()).toBe(false);
    expect(createTurnSound(storage, Audio).enabled).toBe(false);
    const unsupported = createTurnSound(storage, null); unsupported.toggle(); unsupported.unlock(); expect(unsupported.play()).toBe(false);
  });
});
