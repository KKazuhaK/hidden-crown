import { randomUUID, randomInt } from 'node:crypto';
import { isCrownCandidate } from '../src/computer/engine';
import { ComputerPool } from './computer-pool';
import { WebSocket } from 'ws';
import { RoomCore, type RoomContext, type RoomSocket, type Attachment } from '../src/room-core';
import type { RoomPersistence } from '../src/persistence';
import type { Store } from './storage';
import type { Configuration } from './config';

export class Socket implements RoomSocket {
  private data: Attachment | null = null;
  id = randomUUID();
  constructor(readonly ws: WebSocket) {}
  get readyState() { return this.ws.readyState; }
  serializeAttachment(value: Attachment) { this.data = value; }
  deserializeAttachment() { return this.data; }
  send(data: string) { if (this.ws.bufferedAmount > 1024 * 1024) this.ws.terminate(); else this.ws.send(data); }
  close(code = 1000, reason = '') { this.ws.close(code, reason); }
}
export class RuntimeRoom implements RoomContext {
  readonly core: RoomCore;
  sockets = new Set<Socket>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  alarmTimer?: NodeJS.Timeout;
  computerTimer?: NodeJS.Timeout;
  private computing = false;
  lastAccess = Date.now();
  bytes = 0;
  deleting = false;
  persistence: RoomPersistence;
  constructor(readonly id: string, store: Store, private manager: RoomManager) {
    this.persistence = {
      load: async () => {
        const saved = await store.load(id);
        this.bytes = saved ? (await store.header(id))!.bytes * 2 : 0;
        manager.ensureBudget(id, this.bytes); return saved;
      },
      commit: async (state, events, expectedRevision) => {
        if (this.deleting) throw new Error('room_deleted');
        // Include a conservative allowance for materialized history/object overhead.
        const bytes = await store.commit(state, events, expectedRevision, bytes => manager.ensureBudget(id, bytes * 2));
        this.bytes = bytes * 2;
      }
    };
    this.core = new RoomCore(this);
  }
  onStateChanged() { this.scheduleComputer(); }
  scheduleComputer() {
    clearTimeout(this.computerTimer);
    if (this.computing || this.deleting || this.manager.closing || this.manager.rooms.get(this.id) !== this) return;
    const turn = this.core.computerTurn(); if (!turn) return;
    this.computerTimer = setTimeout(() => { void this.runComputer(); }, turn.phase === 'crown_select' ? 250 : 450);
    this.computerTimer.unref();
  }
  private async runComputer() {
    const turn = this.core.computerTurn();
    if (!turn || this.computing || this.deleting || this.manager.closing) return;
    this.computing = true; let failed = false;
    try {
      let command;
      if (turn.phase === 'crown_select') {
        const choices = Object.values(turn.input.pieces).filter(p => p.color === turn.computer.color && isCrownCandidate(p));
        command = { type: 'select_crown' as const, pieceId: choices[randomInt(choices.length)].id };
      } else if (turn.undoRequest && turn.undoRequest.color !== turn.computer.color) {
        command = { type: 'respond_undo' as const, accept: true };
      } else if (turn.drawOffer && turn.drawOffer !== turn.computer.color) {
        // Clear policy independent of hidden choices: the computer declines offers.
        command = { type: 'respond_draw' as const, accept: false };
      } else {
        const result = await this.manager.computers.search(turn.input);
        if (!result.move) return;
        command = { type: 'move' as const, from: result.move.from, to: result.move.to, ...(result.move.promotion ? { promotion: result.move.promotion } : {}) };
      }
      if (!this.deleting && !this.manager.closing && this.manager.rooms.get(this.id) === this) await this.core.computerAction(command, turn.revision);
    } catch { failed = true; }
    finally {
      this.computing = false;
      if (failed && !this.deleting && !this.manager.closing) {
        this.computerTimer = setTimeout(() => this.scheduleComputer(), 1000); this.computerTimer.unref();
      } else this.scheduleComputer();
    }
  }
  async setAlarm(at: number) {
    clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(() => this.core.alarm().catch(() => {}), Math.max(1, at - Date.now())); this.alarmTimer.unref();
  }
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    if (this.queued >= 64) return Promise.reject(new Error('room_busy'));
    this.queued++;
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {}).finally(() => { this.queued--; }); return result;
  }
  getWebSockets() { this.lastAccess = Date.now(); return [...this.sockets]; }
  get busy() { return this.queued > 0; }
  async drain() { await this.queue; }
}

// A replaceable directory/owner boundary for a future distributed room service.
// Today one process owns all live rooms; PG startup enforces that ownership.
export class RoomManager {
  closing = false;
  readonly computers: ComputerPool;
  readonly rooms = new Map<string, RuntimeRoom>();
  private loading = new Map<string, Promise<RuntimeRoom>>();
  private expiryTask: Promise<void> | null = null;
  constructor(readonly store: Store, private config: Configuration, readonly waitingMinutes: () => number) { this.computers = new ComputerPool(config.computerWorkers); }
  async get(id: string): Promise<RuntimeRoom> {
    const loading = this.loading.get(id); if (loading) return loading;
    const existing = this.rooms.get(id); if (existing) { existing.lastAccess = Date.now(); await existing.core.ready; return existing; }
    const task = (async () => {
      this.ensureBudget(id, 0);
      if (this.rooms.size >= this.config.maxLoadedRooms) this.evictIdle(1);
      if (this.rooms.size >= this.config.maxLoadedRooms) throw new Error('server_busy');
      const room = new RuntimeRoom(id, this.store, this); this.rooms.set(id, room);
      try { await room.core.ready; return room; } catch (error) { this.rooms.delete(id); throw error; }
    })();
    this.loading.set(id, task);
    try { return await task; } finally { this.loading.delete(id); }
  }
  private evictIdle(count: number) {
    const idle = [...this.rooms.values()].filter(room => !room.sockets.size && !room.busy).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const room of idle.slice(0, count)) { clearTimeout(room.alarmTimer); clearTimeout(room.computerTimer); this.rooms.delete(room.id); }
  }
  ensureBudget(id: string, incoming: number) {
    let total = incoming;
    for (const [key, room] of this.rooms) if (key !== id) total += room.bytes;
    if (total > this.config.maxCacheBytes) {
      const idle = [...this.rooms.values()].filter(room => room.id !== id && !room.sockets.size && !room.busy).sort((a, b) => a.lastAccess - b.lastAccess);
      for (const room of idle) { total -= room.bytes; clearTimeout(room.alarmTimer); clearTimeout(room.computerTimer); this.rooms.delete(room.id); if (total <= this.config.maxCacheBytes) break; }
      if (total > this.config.maxCacheBytes) throw new Error('server_busy');
    }
  }
  async remove(id: string, expired = false) {
    const room = this.rooms.get(id);
    const remove = async () => {
      const deleted = await this.store.delete(id, expired ? Date.now() - this.waitingMinutes() * 60000 : undefined);
      if (!deleted) return;
      if (room) {
        room.deleting = true;
        for (const socket of room.sockets) { socket.serializeAttachment({ ...socket.deserializeAttachment()!, active: false }); socket.ws.close(4001, expired ? 'room_expired' : 'room_deleted'); }
        clearTimeout(room.alarmTimer); clearTimeout(room.computerTimer); this.rooms.delete(id);
      }
    };
    if (room) await room.blockConcurrencyWhile(remove); else await remove();
  }
  expire() {
    if (this.expiryTask) return this.expiryTask;
    this.expiryTask = (async () => {
      const rows = await this.store.expired(Date.now() - this.waitingMinutes() * 60000);
      for (const id of rows) await this.remove(id, true);
    })().finally(() => { this.expiryTask = null; }); return this.expiryTask;
  }
  async close() {
    this.closing = true;
    for (const room of this.rooms.values()) { clearTimeout(room.alarmTimer); clearTimeout(room.computerTimer); }
    await this.computers.close(); await Promise.all([...this.rooms.values()].map(room => room.drain()));
  }
}
