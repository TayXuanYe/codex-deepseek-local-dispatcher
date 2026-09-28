import assert from "node:assert/strict";
import test from "node:test";
import { RunManagerError, createRunManager, sanitizeRunEvent } from "../scripts/run-manager.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected clock and timer queue: health windows (60s/300s), wait timeouts, and
// retention (1h) are exercised without real elapsed time.
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(callback, milliseconds) {
        const id = nextId;
        nextId += 1;
        timers.set(id, { due: now + Math.max(0, Number(milliseconds) || 0), callback });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      }
    },
    advance(milliseconds) {
      now += milliseconds;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort((left, right) => left[1].due - right[1].due);
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.callback();
          progressed = true;
        }
      }
    },
    pending: () => timers.size
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeManager(clock, overrides = {}) {
  let counter = 0;
  return createRunManager({
    now: clock.now,
    timers: clock.timers,
    idFactory: () => `run-${(counter += 1)}`,
    ...overrides
  });
}

test("terminal state is separate from health and inactivity never ends a run", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  const gate = deferred();
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ hooks }) => {
      hooks.onRunning({ model: "deepseek-flash", mode: "read-only" });
      await gate.promise;
      return { status: "completed", result: { status: "completed" } };
    }
  });

  await delay(0); // let the injected executor report its first transition
  const starting = manager.getRun(runId);
  assert.equal(starting.state, "running");
  assert.equal(starting.terminal, false);
  assert.equal(starting.health, "active");
  assert.equal(starting.model, "deepseek-flash");
  assert.equal(starting.mode, "read-only");
  assert.equal(starting.revision > 0, true);

  clock.advance(59_999);
  assert.equal(manager.getRun(runId).health, "active");
  clock.advance(1);
  assert.equal(manager.getRun(runId).health, "quiet");
  clock.advance(240_000);
  const stalled = manager.getRun(runId);
  assert.equal(stalled.health, "suspected_stalled");
  // A stalled-looking run is still running: health never completes or cancels.
  assert.equal(stalled.state, "running");
  assert.equal(stalled.terminal, false);
  assert.equal(stalled.cancel_requested, false);

  clock.advance(3_600_000);
  assert.equal(manager.getRun(runId).health, "suspected_stalled");
  assert.equal(manager.isBusy(), true);

  gate.resolve();
  const completed = await manager.waitForTerminal(runId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.terminal, true);
  assert.equal(completed.health, null);
  assert.equal(completed.result.status, "completed");
  assert.equal(manager.isBusy(), false);
});

test("the manager keeps exactly one active run and releases the slot at a terminal state", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  const gate = deferred();
  const first = manager.startRun({ kind: "coding", execute: async () => gate.promise });
  assert.throws(
    () => manager.startRun({ kind: "coding", execute: async () => ({ status: "completed" }) }),
    (error) => error instanceof RunManagerError && error.code === "busy"
  );
  assert.equal(manager.activeRunId(), first);
  assert.equal(manager.activeRun().run_id, first);

  gate.resolve({ status: "completed", result: { status: "completed" } });
  await manager.waitForTerminal(first);
  const second = manager.startRun({ kind: "vision", execute: async () => ({ status: "failed", error: { code: "x", message: "y" } }) });
  const snapshot = await manager.waitForTerminal(second);
  assert.equal(snapshot.state, "failed");
  assert.equal(snapshot.error.code, "x");
  assert.equal(manager.activeRun(), null);
});

test("waitForRun returns on a revision change, a terminal state, or its bounded timeout", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  const gate = deferred();
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ hooks }) => {
      hooks.onRunning({ model: "deepseek-flash", mode: "read-only" });
      await gate.promise;
      return { status: "completed", result: { status: "completed" } };
    }
  });
  await delay(0);

  const timeoutWait = manager.waitForRun({ runId, afterRevision: 99, timeoutMs: 250 });
  clock.advance(250);
  const timedOut = await timeoutWait;
  assert.equal(timedOut.run_id, runId);
  assert.equal(timedOut.state, "running");

  // A run that already moved past after_revision returns immediately.
  const immediate = await manager.waitForRun({ runId, afterRevision: 0, timeoutMs: 5_000 });
  assert.equal(immediate.run_id, runId);

  const revision = manager.getRun(runId).revision;
  const waiting = manager.waitForRun({ runId, afterRevision: revision, timeoutMs: 5_000 });
  gate.resolve({ status: "completed", result: { status: "completed" } });
  const settled = await waiting;
  assert.equal(settled.terminal, true);
  assert.equal(settled.state, "completed");
  assert.equal(clock.pending(), 0);

  assert.throws(
    () => manager.waitForRun({ runId: "missing-run" }),
    (error) => error instanceof RunManagerError && error.code === "unknown_run"
  );
  assert.throws(
    () => manager.waitForRun({ runId, timeoutMs: 120_000 }),
    (error) => error instanceof RunManagerError && error.code === "invalid_argument"
  );
});

test("concurrent long-poll waiters are bounded per run", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock, { maxWaiters: 4, maxWaitersPerRun: 2 });
  const gate = deferred();
  const runId = manager.startRun({ kind: "coding", execute: async () => gate.promise });
  const first = manager.waitForRun({ runId, afterRevision: 99, timeoutMs: 1_000 });
  const second = manager.waitForRun({ runId, afterRevision: 99, timeoutMs: 1_000 });
  assert.throws(
    () => manager.waitForRun({ runId, afterRevision: 99, timeoutMs: 1_000 }),
    (error) => error instanceof RunManagerError && error.code === "too_many_waiters"
  );
  clock.advance(1_000);
  await Promise.all([first, second]);
  gate.resolve({ status: "completed", result: { status: "completed" } });
  await manager.waitForTerminal(runId);
});

test("cancelRun is idempotent, aborts the run, and resolves waiters", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ signal, hooks }) => {
      hooks.onRunning({ model: "deepseek-flash", mode: "read-only" });
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      return { status: "cancelled", error: { code: "cancelled", message: "The DeepSeek run was cancelled." } };
    }
  });
  const waiting = manager.waitForTerminal(runId);
  await delay(0); // let the fake executor attach its abort listener
  const first = await manager.cancelRun(runId);
  assert.equal(first.cancel_requested, true);
  assert.equal(first.already_terminal, false);
  assert.equal(first.cancelled, true);
  assert.equal(first.run.state, "cancelled");
  const settled = await waiting;
  assert.equal(settled.state, "cancelled");

  const second = await manager.cancelRun(runId);
  assert.equal(second.ok, true);
  assert.equal(second.already_terminal, true);
  assert.equal(second.cancelled, true);
  assert.equal(second.run.state, "cancelled");
});

test("run history and completed runs stay bounded, and old runs are pruned", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock, { maxEventsPerRun: 5, maxRetainedRuns: 3 });
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ hooks }) => {
      hooks.onRunning({ model: "deepseek-flash", mode: "read-only" });
      for (let index = 0; index < 20; index += 1) {
        hooks.onEvent({ type: "agent_message", text: `chunk ${index}` });
      }
      return { status: "completed", result: { status: "completed" } };
    }
  });
  await manager.waitForTerminal(runId);
  const events = manager.getRun(runId).events;
  assert.ok(events.length <= 5, `history must stay bounded: ${events.length}`);
  assert.equal(events.at(-1).type, "terminal");

  for (let index = 0; index < 5; index += 1) {
    const id = manager.startRun({ kind: "coding", execute: async () => ({ status: "completed" }) });
    await manager.waitForTerminal(id);
    clock.advance(1_000);
  }
  assert.equal(manager.runCount() <= 3, true);
  // The newest run survives; the older completed runs are gone.
  assert.equal(manager.getRun(runId), null);

  clock.advance(3_700_000);
  manager.startRun({ kind: "coding", execute: async () => ({ status: "completed" }) });
  assert.equal(manager.runCount() <= 2, true);
});

test("late executor hooks cannot mutate a terminal run", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  let capturedHooks;
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ hooks }) => {
      capturedHooks = hooks;
      hooks.onRunning({ model: "deepseek-flash", mode: "read-only" });
      hooks.onEvent({ type: "agent_message", text: "final" });
      return { status: "completed", result: { status: "completed" } };
    }
  });
  const terminal = await manager.waitForTerminal(runId);
  const revision = terminal.revision;
  assert.equal(terminal.latest_safe_message, "final");
  capturedHooks.onActivity();
  capturedHooks.onEvent({ type: "agent_message", text: "late" });
  capturedHooks.onThread("late-thread");
  capturedHooks.onFinalizing({ graceMs: 1 });
  capturedHooks.onCleanup({ forced: true });
  const unchanged = manager.getRun(runId);
  assert.equal(unchanged.revision, revision);
  assert.equal(unchanged.latest_safe_message, "final");
  assert.equal(unchanged.thread_id, null);
});

test("sanitizeRunEvent bounds shape, size, and key names", () => {
  assert.equal(sanitizeRunEvent(null), null);
  assert.equal(sanitizeRunEvent("raw jsonl line"), null);
  assert.equal(sanitizeRunEvent({ type: "Not A Type" }), null);
  assert.equal(sanitizeRunEvent({ type: "thread.started" }), null);
  assert.deepEqual(sanitizeRunEvent({ type: "agent_message", text: "ok", ignored: () => {} }), {
    type: "agent_message",
    text: "ok",
    ignored: null
  });
  const longText = sanitizeRunEvent({ type: "agent_message", text: "y".repeat(5_000) });
  assert.equal(longText.text.length, 2_000 + "[truncated]".length);
  const oversized = sanitizeRunEvent({
    type: "agent_message",
    text: "z".repeat(2_000),
    extra: "w".repeat(2_000),
    extra2: "v".repeat(2_000)
  });
  assert.deepEqual(oversized, { type: "agent_message", truncated: true });
});

test("shutdown cancels the active run, unblocks waiters, and refuses new runs", async () => {
  const clock = fakeClock();
  const manager = makeManager(clock);
  const runId = manager.startRun({
    kind: "coding",
    execute: async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      return { status: "cancelled", error: { code: "cancelled", message: "cancelled" } };
    }
  });
  // A waiter that cannot be satisfied by any revision must still be released by
  // shutdown instead of hanging.
  const waiting = manager.waitForRun({ runId, afterRevision: 99_999, timeoutMs: 60_000 });
  await delay(0);
  await manager.shutdown();
  const snapshot = await waiting;
  assert.equal(snapshot.run_id, runId);
  assert.equal(manager.isBusy(), false);
  assert.throws(
    () => manager.startRun({ kind: "coding", execute: async () => ({ status: "completed" }) }),
    (error) => error instanceof RunManagerError && error.code === "shutting_down"
  );
});
