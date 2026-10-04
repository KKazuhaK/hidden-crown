import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ComputerInput, chooseComputerMove } from '../src/computer/engine';
type Result = ReturnType<typeof chooseComputerMove>;
interface Job { id: number; input: ComputerInput; resolve(value: Result): void; reject(error: Error): void }
interface Slot { worker: Worker; job?: Job; timer?: NodeJS.Timeout }
// Bounded pool shared by every room. Workers receive a redacted position only.
export class ComputerPool {
  private slots: Slot[] = []; private queue: Job[] = []; private id = 0; private stopped = false;
  constructor(private maximum = 2, private workerUrl = new URL('./computer-worker.mjs', import.meta.url).href) {}
  search(input: ComputerInput): Promise<Result> {
    if (this.stopped || this.queue.length >= 64) return Promise.reject(new Error('computer_busy'));
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.id, input, resolve, reject }); this.pump(); });
  }
  private create() {
    const slot: Slot = { worker: new Worker(fileURLToPath(this.workerUrl), { resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8 } }) };
    this.slots.push(slot); slot.worker.unref();
    const failed = () => {
      if (!this.slots.includes(slot)) return;
      clearTimeout(slot.timer); slot.job?.reject(new Error('computer_failed'));
      this.slots.splice(this.slots.indexOf(slot), 1); void slot.worker.terminate(); this.pump();
    };
    slot.worker.on('error', failed); slot.worker.on('exit', failed);
    slot.worker.on('message', message => {
      if (!slot.job || message.id !== slot.job.id) return;
      const job = slot.job; slot.job = undefined; clearTimeout(slot.timer);
      if (message.error) job.reject(new Error('computer_failed')); else job.resolve(message.result);
      slot.worker.unref(); this.pump();
    });
    return slot;
  }
  private pump() {
    if (this.stopped) return;
    while (this.queue.length) {
      const slot = this.slots.find(slot => !slot.job) ?? (this.slots.length < this.maximum ? this.create() : undefined);
      if (!slot) return;
      slot.job = this.queue.shift()!; slot.worker.ref();
      // Includes worker startup; a wedged worker is replaced, without unbounded waits.
      slot.timer = setTimeout(() => { void slot.worker.terminate(); }, 2000);
      slot.worker.postMessage({ id: slot.job.id, input: slot.job.input });
    }
  }
  async close() {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('computer_stopped'));
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.job?.reject(new Error('computer_stopped')); }
    await Promise.all(this.slots.map(slot => slot.worker.terminate())); this.slots = [];
  }
}
