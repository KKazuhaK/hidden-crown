import { parentPort } from 'node:worker_threads';
import { chooseComputerMove, type ComputerInput } from '../src/computer/engine';
parentPort!.on('message', ({ id, input }: { id: number; input: ComputerInput }) => {
  try { parentPort!.postMessage({ id, result: chooseComputerMove(input) }); }
  catch { parentPort!.postMessage({ id, error: 'computer_failed' }); }
});
