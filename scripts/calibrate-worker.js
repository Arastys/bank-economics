import { parentPort } from 'node:worker_threads';
import { runJob } from '../dist/src/calibration/harness.js';

parentPort.on('message', (job) => {
  try {
    parentPort.postMessage({ ok: true, result: runJob(job) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error?.stack ?? error) });
  }
});
