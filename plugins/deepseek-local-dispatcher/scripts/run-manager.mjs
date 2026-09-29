// In-memory run lifecycle manager for the DeepSeek local dispatcher.
//
// The MCP server must be able to start a DeepSeek run without blocking, read a
// safe status snapshot, wait for a revision change, and cancel the run. This
// module owns that lifecycle and is deliberately memory-only: no persistent
// store, bounded per-run event history, bounded retention, and an explicit
// "exactly one active run" rule.
//
// Terminal status and health are separate concerns. The terminal machine is
// starting -> running -> finalizing -> completed, or failed/cancelled/timed_out.
// Health is derived from inactivity (active, quiet after 60s, suspected_stalled
// after 300s) and never completes, fails, or kills a run by itself. Nothing here
// decides how a run finishes; the injected executor reports transitions and the
// manager only records them, so a stalled-but-alive run is observable without
// being destroyed.
//
// Every value that can leave this module goes through a structural sanitizer:
// only plain JSON scalars, arrays, and objects survive, keys and strings are
// bounded, and oversized events are replaced by a marker. The dispatcher is
// still responsible for redacting secrets and paths before an event is sent
// here; this pass is defense in depth for shape and size only.

import { randomUUID } from "node:crypto";

export const RUN_STATES = Object.freeze({
  STARTING: "starting",
  RUNNING: "running",
  FINALIZING: "finalizing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out"
});

const TERMINAL_STATES = new Set([
  RUN_STATES.COMPLETED,
  RUN_STATES.FAILED,
  RUN_STATES.CANCELLED,
  RUN_STATES.TIMED_OUT
]);

const OUTCOME_STATES = new Map([
  ["completed", RUN_STATES.COMPLETED],
  ["failed", RUN_STATES.FAILED],
  ["cancelled", RUN_STATES.CANCELLED],
  ["timed_out", RUN_STATES.TIMED_OUT]
]);

export const RUN_HEALTH = Object.freeze({
  ACTIVE: "active",
  QUIET: "quiet",
  SUSPECTED_STALLED: "suspected_stalled"
});

export const runManagerLimits = Object.freeze({
  max_events_per_run: 200,
  max_retained_runs: 20,
  retention_ms: 3_600_000,
  quiet_ms: 60_000,
  suspected_stalled_ms: 300_000,
  default_wait_ms: 30_000,
  max_wait_ms: 60_000,
  max_waiters: 64,
  max_waiters_per_run: 8,
  cancel_wait_ms: 5_000,
  shutdown_wait_ms: 5_000,
  default_event_limit: 10,
  max_event_limit: 50
});

const MAX_EVENT_STRING = 2_000;
const MAX_EVENT_KEYS = 20;
const MAX_EVENT_ITEMS = 20;
const MAX_EVENT_DEPTH = 4;
const MAX_EVENT_BYTES = 4_096;
const MAX_EVENT_TYPE_CHARS = 32;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TRUNCATION_MARKER = "[truncated]";

export class RunManagerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RunManagerError";
    this.code = code;
    this.details = details;
  }
}

const defaultTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle)
};

function sanitizeValue(value, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_EVENT_STRING
      ? `${value.slice(0, MAX_EVENT_STRING)}${TRUNCATION_MARKER}`
      : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (depth >= MAX_EVENT_DEPTH) return null;
    return value.slice(0, MAX_EVENT_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= MAX_EVENT_DEPTH) return null;
    const result = {};
    let keys = 0;
    for (const [key, item] of Object.entries(value)) {
      if (keys >= MAX_EVENT_KEYS) break;
      if (!SAFE_KEY_PATTERN.test(key)) continue;
      result[key] = sanitizeValue(item, depth + 1);
      keys += 1;
    }
    return result;
  }
  return null;
}

// Normalizes one published event: a bounded, JSON-safe object with a tagged
// type. Anything without a usable type is dropped, and anything larger than the
// per-event byte budget collapses to a marker so history stays bounded.
export function sanitizeRunEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const type = event.type;
  if (typeof type !== "string" || !EVENT_TYPE_PATTERN.test(type) || type.length > MAX_EVENT_TYPE_CHARS) {
    return null;
  }
  const body = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    if (!SAFE_KEY_PATTERN.test(key)) continue;
    body[key] = sanitizeValue(value, 1);
  }
  const sanitized = { type, ...body };
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_EVENT_BYTES) {
    return { type, truncated: true };
  }
  return sanitized;
}

function cloneEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

function isoTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function createRunManager(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timers = options.timers ?? defaultTimers;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : () => randomUUID();
  const limits = {
    maxEventsPerRun: options.maxEventsPerRun ?? runManagerLimits.max_events_per_run,
    maxRetainedRuns: options.maxRetainedRuns ?? runManagerLimits.max_retained_runs,
    retentionMs: options.retentionMs ?? runManagerLimits.retention_ms,
    quietMs: options.quietMs ?? runManagerLimits.quiet_ms,
    suspectedStalledMs: options.suspectedStalledMs ?? runManagerLimits.suspected_stalled_ms,
    defaultWaitMs: options.defaultWaitMs ?? runManagerLimits.default_wait_ms,
    maxWaitMs: options.maxWaitMs ?? runManagerLimits.max_wait_ms,
    maxWaiters: options.maxWaiters ?? runManagerLimits.max_waiters,
    maxWaitersPerRun: options.maxWaitersPerRun ?? runManagerLimits.max_waiters_per_run,
    cancelWaitMs: options.cancelWaitMs ?? runManagerLimits.cancel_wait_ms,
    shutdownWaitMs: options.shutdownWaitMs ?? runManagerLimits.shutdown_wait_ms,
    defaultEventLimit: options.defaultEventLimit ?? runManagerLimits.default_event_limit,
    maxEventLimit: options.maxEventLimit ?? runManagerLimits.max_event_limit
  };

  const runs = new Map();
  const waiters = new Set();
  let activeRunId = null;
  let shuttingDown = false;

  // Every retained safe event carries a monotonic, stable seq that never
  // changes once assigned. seq is a projection concern only: revision stays the
  // sole wait-wakeup signal, so event sequence and revision are never
  // conflated.
  function appendEvent(run, event, fallback = null) {
    const safe = sanitizeRunEvent(event) ?? fallback;
    if (!safe) return false;
    run.event_seq += 1;
    run.events.push({ ...safe, seq: run.event_seq });
    trimEvents(run);
    return true;
  }

  // Bounded history: evicting the oldest events is recorded so a reader can
  // tell that earlier events were truncated and are no longer available.
  function trimEvents(run) {
    if (run.events.length <= limits.maxEventsPerRun) return;
    const removed = run.events.length - limits.maxEventsPerRun;
    run.events.splice(0, removed);
    run.dropped_events += removed;
  }

  function boundedEventLimit(raw) {
    if (raw === undefined || raw === null) return limits.defaultEventLimit;
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > limits.maxEventLimit) {
      throw new RunManagerError(
        "invalid_argument",
        `event_limit must be an integer between 1 and ${limits.maxEventLimit}.`
      );
    }
    return raw;
  }

  function boundedEventFrom(raw) {
    if (raw === undefined || raw === null) return null;
    if (!Number.isSafeInteger(raw) || raw < 1) {
      throw new RunManagerError("invalid_argument", "event_from must be a positive integer.");
    }
    return raw;
  }

  function normalizeEventWindow(options = {}) {
    return {
      eventFrom: boundedEventFrom(options.eventFrom),
      eventLimit: boundedEventLimit(options.eventLimit)
    };
  }

  // Selects the retained events a caller asked for and describes the window.
  // Without event_from the latest event_limit events are returned; with
  // event_from up to event_limit retained events whose seq is >= event_from are
  // returned. Both shapes are ascending by seq.
  function projectEvents(run, eventFrom, eventLimit) {
    const retainedFrom = run.events.length > 0 ? run.events[0].seq : null;
    const retainedTo = run.events.length > 0 ? run.events[run.events.length - 1].seq : null;
    let selected;
    if (eventFrom === null) {
      selected = run.events.slice(Math.max(0, run.events.length - eventLimit));
    } else {
      selected = [];
      for (const event of run.events) {
        if (event.seq < eventFrom) continue;
        selected.push(event);
        if (selected.length >= eventLimit) break;
      }
    }
    const returnedFrom = selected.length > 0 ? selected[0].seq : null;
    const returnedTo = selected.length > 0 ? selected[selected.length - 1].seq : null;
    const hasMoreAfter = returnedTo !== null && retainedTo !== null && retainedTo > returnedTo;
    return {
      events: selected.map(cloneEvent),
      window: {
        limit: eventLimit,
        requested_from: eventFrom,
        retained_from: retainedFrom,
        retained_to: retainedTo,
        retained_count: run.events.length,
        returned_from: returnedFrom,
        returned_to: returnedTo,
        returned_count: selected.length,
        next_from: hasMoreAfter ? returnedTo + 1 : null,
        has_more_after: hasMoreAfter,
        truncated_before: run.dropped_events > 0,
        dropped_events: run.dropped_events
      }
    };
  }

  function snapshot(run, { eventFrom = null, eventLimit = limits.defaultEventLimit } = {}) {
    const terminal = isTerminalState(run.state);
    const referencePoint = run.last_activity_at ?? run.started_at ?? run.created_at;
    const idleMs = Math.max(0, now() - referencePoint);
    let health = null;
    if (!terminal) {
      if (idleMs >= limits.suspectedStalledMs) health = RUN_HEALTH.SUSPECTED_STALLED;
      else if (idleMs >= limits.quietMs) health = RUN_HEALTH.QUIET;
      else health = RUN_HEALTH.ACTIVE;
    }
    const latestMessageEvent = [...run.events]
      .reverse()
      .find((event) => typeof event.text === "string" || typeof event.message === "string");
    const { events, window: eventWindow } = projectEvents(run, eventFrom, eventLimit);
    return {
      run_id: run.run_id,
      kind: run.kind,
      state: run.state,
      terminal,
      health,
      revision: run.revision,
      cancel_requested: run.cancelRequested,
      created_at: isoTime(run.created_at),
      started_at: isoTime(run.started_at),
      updated_at: isoTime(run.updated_at),
      finished_at: isoTime(run.finished_at),
      last_activity_at: isoTime(run.last_activity_at),
      idle_ms: idleMs,
      elapsed_ms: Math.max(0, (run.finished_at ?? now()) - run.created_at),
      model: run.model,
      mode: run.mode,
      thread_id: run.thread_id,
      cleanup_forced: run.cleanup_forced,
      latest_safe_message: latestMessageEvent?.text ?? latestMessageEvent?.message ?? null,
      result: run.result ? cloneEvent(run.result) : null,
      error: run.error ? cloneEvent(run.error) : null,
      events,
      event_window: eventWindow
    };
  }

  function resolveWaiter(waiter, run) {
    waiters.delete(waiter);
    if (waiter.timer !== null) timers.clearTimeout(waiter.timer);
    waiter.resolve(run ? snapshot(run, waiter.eventOptions) : null);
  }

  function notify(run) {
    const ready = [];
    for (const waiter of waiters) {
      if (waiter.runId !== run.run_id) continue;
      if (waiter.predicate(run)) ready.push(waiter);
    }
    for (const waiter of ready) resolveWaiter(waiter, run);
  }

  // Revision is the only signal that wakes waiters. Activity timestamps change
  // constantly while a worker streams output, so they are recorded without a
  // revision bump; otherwise every output chunk would wake every waiter.
  function record(run, { event = null, state = null, activity = false } = {}) {
    if (isTerminalState(run.state)) return false;
    let changed = false;
    if (state !== null && run.state !== state) {
      run.state = state;
      changed = true;
    }
    if (event !== null) {
      if (appendEvent(run, event)) changed = true;
    }
    if (activity) run.last_activity_at = now();
    if (!changed) return false;
    run.revision += 1;
    run.updated_at = now();
    notify(run);
    return true;
  }

  function prune() {
    const finished = [...runs.values()].filter((run) => isTerminalState(run.state));
    finished.sort((left, right) => (left.finished_at ?? 0) - (right.finished_at ?? 0));
    const cutoff = now() - limits.retentionMs;
    const excess = finished.length - limits.maxRetainedRuns;
    for (let index = 0; index < finished.length; index += 1) {
      const run = finished[index];
      const tooOld = (run.finished_at ?? 0) < cutoff;
      if (index < excess || tooOld) runs.delete(run.run_id);
    }
  }

  function requireRun(runId) {
    if (typeof runId !== "string" || !runId.trim()) {
      throw new RunManagerError("invalid_argument", "run_id must be a non-empty string.");
    }
    prune();
    const run = runs.get(runId);
    if (!run) throw new RunManagerError("unknown_run", "No DeepSeek run matches that run_id.");
    return run;
  }

  function boundedWait(raw, fallback) {
    if (raw === undefined || raw === null) return fallback;
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > limits.maxWaitMs) {
      throw new RunManagerError(
        "invalid_argument",
        `timeout_ms must be an integer between 0 and ${limits.maxWaitMs}.`
      );
    }
    return raw;
  }

  function addWaiter(run, timeoutMs, predicate, eventOptions = {}) {
    if (predicate(run)) return Promise.resolve(snapshot(run, eventOptions));
    const runWaiters = [...waiters].filter((waiter) => waiter.runId === run.run_id).length;
    if (waiters.size >= limits.maxWaiters || runWaiters >= limits.maxWaitersPerRun) {
      throw new RunManagerError(
        "too_many_waiters",
        "Too many concurrent DeepSeek run wait requests; retry after an existing wait completes."
      );
    }
    return new Promise((resolve) => {
      const waiter = { runId: run.run_id, predicate, resolve, timer: null, eventOptions };
      if (timeoutMs !== null) {
        waiter.timer = timers.setTimeout(() => resolveWaiter(waiter, run), timeoutMs);
      }
      waiters.add(waiter);
    });
  }

  function requestCancellation(run) {
    if (run.cancelRequested) return false;
    run.cancelRequested = true;
    try {
      run.abortController.abort();
    } catch {
      // An already-aborted controller is harmless; cancellation stays recorded.
    }
    record(run, { event: { type: "cancel_requested" } });
    return true;
  }

  function finish(run, outcome) {
    if (isTerminalState(run.state)) return; // idempotent across every finalize path
    const status = typeof outcome?.status === "string" ? outcome.status : "failed";
    const state = OUTCOME_STATES.get(status) ?? RUN_STATES.FAILED;
    run.state = state;
    run.result = outcome?.result ?? null;
    run.error = outcome?.error ?? null;
    if (typeof outcome?.cleanup_forced === "boolean") run.cleanup_forced = outcome.cleanup_forced;
    run.finished_at = now();
    run.updated_at = run.finished_at;
    run.revision += 1;
    appendEvent(run, { type: "terminal", state }, { type: "terminal", state });
    if (activeRunId === run.run_id) activeRunId = null;
    run.resolveCompletion(snapshot(run));
    notify(run);
    prune();
  }

  function buildHooks(run) {
    return {
      onRunning(info = {}) {
        if (isTerminalState(run.state)) return;
        if (run.state === RUN_STATES.STARTING) {
          run.state = RUN_STATES.RUNNING;
          run.started_at = now();
        }
        if (typeof info.model === "string") run.model = info.model;
        if (typeof info.mode === "string") run.mode = info.mode;
        run.last_activity_at = now();
        run.revision += 1;
        run.updated_at = now();
        appendEvent(run, { type: "run_started", model: run.model, mode: run.mode }, { type: "run_started" });
        notify(run);
      },
      onActivity() {
        if (isTerminalState(run.state)) return;
        run.last_activity_at = now();
        run.updated_at = now();
      },
      onEvent(event) {
        if (isTerminalState(run.state)) return;
        record(run, { event });
      },
      onThread(threadId) {
        if (isTerminalState(run.state)) return;
        if (typeof threadId !== "string" || !threadId) return;
        run.thread_id = threadId;
        record(run, { event: { type: "thread", thread_id: threadId } });
      },
      onFinalizing(info = {}) {
        if (isTerminalState(run.state)) return;
        record(run, {
          state: RUN_STATES.FINALIZING,
          event: { type: "finalizing", grace_ms: Number.isSafeInteger(info.graceMs) ? info.graceMs : null }
        });
      },
      onCleanup(info = {}) {
        if (isTerminalState(run.state)) return;
        // The cleanup flag is part of the terminal record, so it is stored
        // without its own revision bump; the terminal transition notifies.
        if (typeof info.forced === "boolean") run.cleanup_forced = info.forced;
      }
    };
  }

  function startRun({ kind, execute } = {}) {
    prune();
    if (shuttingDown) {
      throw new RunManagerError("shutting_down", "The dispatcher is shutting down and cannot start a new run.");
    }
    if (typeof execute !== "function") {
      throw new RunManagerError("invalid_argument", "startRun requires an execute function.");
    }
    if (activeRunId !== null) {
      throw new RunManagerError("busy", "The dispatcher permits only one active DeepSeek run.");
    }
    const runId = idFactory();
    const createdAt = now();
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const run = {
      run_id: runId,
      kind: typeof kind === "string" ? kind : "coding",
      state: RUN_STATES.STARTING,
      revision: 0,
      cancelRequested: false,
      created_at: createdAt,
      started_at: null,
      updated_at: createdAt,
      finished_at: null,
      last_activity_at: null,
      model: null,
      mode: null,
      thread_id: null,
      cleanup_forced: null,
      events: [],
      event_seq: 0,
      dropped_events: 0,
      result: null,
      error: null,
      abortController: new AbortController(),
      completion,
      resolveCompletion
    };
    runs.set(runId, run);
    appendEvent(run, { type: "created", kind: run.kind });
    activeRunId = runId;
    run.revision += 1;
    run.updated_at = now();

    const hooks = buildHooks(run);
    Promise.resolve()
      .then(() => execute({ runId, signal: run.abortController.signal, hooks }))
      .then(
        (outcome) => finish(run, outcome),
        (error) => finish(run, {
          status: "failed",
          error: {
            code: error?.code ?? "internal_error",
            message: typeof error?.message === "string" ? error.message : "The DeepSeek run failed unexpectedly."
          }
        })
      );
    return runId;
  }

  function getRun(runId, options = {}) {
    const eventOptions = normalizeEventWindow(options);
    prune();
    const run = runs.get(runId);
    return run ? snapshot(run, eventOptions) : null;
  }

  function waitForRun({ runId, afterRevision = undefined, timeoutMs = undefined, eventFrom = undefined, eventLimit = undefined } = {}) {
    const eventOptions = normalizeEventWindow({ eventFrom, eventLimit });
    const run = requireRun(runId);
    if (afterRevision !== undefined && afterRevision !== null && (!Number.isSafeInteger(afterRevision) || afterRevision < 0)) {
      throw new RunManagerError("invalid_argument", "after_revision must be a non-negative integer.");
    }
    const budget = boundedWait(timeoutMs, limits.defaultWaitMs);
    const baseline = afterRevision === undefined || afterRevision === null ? run.revision : afterRevision;
    return addWaiter(
      run,
      budget,
      (candidate) => isTerminalState(candidate.state) || candidate.revision > baseline,
      eventOptions
    );
  }

  function waitForTerminal(runId, { timeoutMs = null } = {}) {
    const run = requireRun(runId);
    const budget = timeoutMs === null ? null : boundedWait(timeoutMs, limits.defaultWaitMs);
    return addWaiter(run, budget, (candidate) => isTerminalState(candidate.state));
  }

  async function cancelRun(runId, { timeoutMs = limits.cancelWaitMs } = {}) {
    const run = requireRun(runId);
    if (isTerminalState(run.state)) {
      return {
        ok: true,
        run_id: run.run_id,
        cancel_requested: run.cancelRequested,
        already_terminal: true,
        cancelled: run.state === RUN_STATES.CANCELLED,
        settled: true,
        run: snapshot(run)
      };
    }
    requestCancellation(run);
    const outcome = await raceWithTimeout(run.completion, timeoutMs);
    return {
      ok: true,
      run_id: run.run_id,
      cancel_requested: true,
      already_terminal: false,
      cancelled: run.state === RUN_STATES.CANCELLED,
      settled: outcome.settled,
      run: snapshot(run)
    };
  }

  function raceWithTimeout(promise, timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return promise.then(() => ({ settled: true }), () => ({ settled: true }));
    }
    return new Promise((resolve) => {
      let finished = false;
      const timer = timers.setTimeout(() => {
        if (finished) return;
        finished = true;
        resolve({ settled: false });
      }, timeoutMs);
      promise.then(
        () => {
          if (finished) return;
          finished = true;
          timers.clearTimeout(timer);
          resolve({ settled: true });
        },
        () => {
          if (finished) return;
          finished = true;
          timers.clearTimeout(timer);
          resolve({ settled: true });
        }
      );
    });
  }

  async function shutdown({ timeoutMs = limits.shutdownWaitMs } = {}) {
    shuttingDown = true;
    const pending = [];
    for (const run of [...runs.values()]) {
      if (isTerminalState(run.state)) continue;
      requestCancellation(run);
      pending.push(run.completion);
    }
    for (const waiter of [...waiters]) {
      const run = runs.get(waiter.runId) ?? null;
      resolveWaiter(waiter, run);
    }
    if (pending.length > 0) {
      await raceWithTimeout(Promise.all(pending).catch(() => []), timeoutMs);
    }
  }

  return {
    limits,
    startRun,
    getRun,
    waitForRun,
    waitForTerminal,
    cancelRun,
    shutdown,
    isBusy: () => activeRunId !== null,
    activeRunId: () => activeRunId,
    activeRun: () => {
      if (activeRunId === null) return null;
      const run = runs.get(activeRunId);
      return run ? snapshot(run) : null;
    },
    runCount: () => runs.size
  };
}
