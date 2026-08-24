/**
 * The simulation, on its own thread.
 *
 * The engine owns the world exclusively here and the page never touches it.
 * That keeps determinism completely intact -- there is still exactly one
 * thread advancing the simulation -- while letting the clock run flat out
 * without the page having to share a thread with it.
 */
import { newGame } from '../src/index.js';
import { buildSnapshot } from './snapshot.js';
import type { FromWorker, ToWorker } from './protocol.js';

const engine = newGame('uk2025');

/** Simulated days per real second. Zero is paused. */
let speed = 0;
let carry = 0;
let lastStep = performance.now();
let lastSnapshot = 0;

/** Ticks in the current measuring window, for the rate readout. */
let ticksThisWindow = 0;
let windowStarted = performance.now();
let observedRate = 0;

const STEP_INTERVAL_MS = 16;
/** Leave time in each step to pick up messages from the page. */
const STEP_BUDGET_MS = 13;
const SNAPSHOT_INTERVAL_MS = 200;

function send(message: FromWorker): void {
  self.postMessage(message);
}

function step(): void {
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - lastStep) / 1000);
  lastStep = now;

  if (speed > 0) {
    carry += speed * elapsed;
    const deadline = now + STEP_BUDGET_MS;
    while (carry >= 1 && performance.now() < deadline) {
      engine.tick();
      carry -= 1;
      ticksThisWindow += 1;
    }
    // Do not let an unmet backlog accumulate into a stall when the machine
    // cannot keep up with the requested speed.
    if (carry > 4) carry = 4;
  }

  if (now - windowStarted >= 1000) {
    observedRate = Math.round((ticksThisWindow * 1000) / (now - windowStarted));
    ticksThisWindow = 0;
    windowStarted = now;
  }

  if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
    lastSnapshot = now;
    send({ type: 'snapshot', snapshot: buildSnapshot(engine, observedRate) });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const message = event.data;
  if (message.type === 'setSpeed') {
    speed = Math.max(0, message.daysPerSecond);
    carry = 0;
    return;
  }
  if (message.type === 'command') {
    const result = engine.enqueue(message.command);
    if (!result.ok) send({ type: 'rejected', reason: String(result.error) });
    // Show the effect straight away rather than waiting for the next snapshot.
    send({ type: 'snapshot', snapshot: buildSnapshot(engine, observedRate) });
  }
};

setInterval(step, STEP_INTERVAL_MS);
send({ type: 'snapshot', snapshot: buildSnapshot(engine, 0) });
