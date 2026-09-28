import { createInterface } from "node:readline";
import {
  DispatcherError,
  deepseekGrantInstructions,
  dispatcherLimits,
  dispatcherStatus,
  runDeepSeek
} from "./dispatcher.mjs";
import { RunManagerError, createRunManager, runManagerLimits } from "./run-manager.mjs";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const BUSY_MESSAGE = "The dispatcher permits only one active DeepSeek run.";
const MAX_RUN_ID_CHARS = 128;

// The run manager owns run identity, revisioned state, bounded event history,
// waiters, retention, cancellation, and the single-active-run rule. Every path
// that executes DeepSeek goes through it: the async start_* tools return as soon
// as the run exists, and the blocking run_* tools await the same managed run
// instead of executing a second, parallel code path.
const manager = createRunManager();
let cleanupBlocked = false;
// Blocking tools stay cancellable through notifications/cancelled, which only
// carries the originating JSON-RPC request id.
const blockingRequests = new Map();

const START_ARGUMENT_PROPERTIES = {
  prompt: { type: "string", minLength: 1, maxLength: dispatcherLimits.max_prompt_chars },
  workspace_path: { type: "string", description: "Absolute path inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS or covered by a one-time path grant." },
  mode: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
  timeout_sec: { type: "integer", minimum: 1, maximum: dispatcherLimits.max_timeout_seconds, default: 600 },
  grant_token: { type: "string", description: "Optional one-time path grant token for a workspace outside the static allowed roots. Ignored (left unconsumed) for workspaces inside the static roots. Never passed to the child or returned in dispatcher output; host/session logs may retain this MCP input, so treat it as a short-lived secret." }
};

const RUN_ID_PROPERTY = { type: "string", minLength: 1, maxLength: MAX_RUN_ID_CHARS, description: "Run identifier returned by start_deepseek_task or start_deepseek_vision." };

const TOOL_DEFINITIONS = [
  {
    name: "deepseek_dispatcher_status",
    description: "Check whether the fixed local unified DeepSeek Flash coding and vision dispatcher is configured and whether one-time path grant support is available, plus a safe summary of the active run. Never returns secret values, paths, or tokens.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "run_deepseek_task",
    description: "Blocking coding entry point: start a bounded local Codex CLI worker with the fixed unified deepseek-flash multimodal model and return only when the run reaches a terminal state. Defaults to read-only; use workspace-write only for an already approved implementation. Prefer start_deepseek_task, get_deepseek_run, wait_deepseek_run, and cancel_deepseek_run when Sol needs progress or cancellation. Workspaces inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS need no grant; for an outside-root workspace pass a grant_token obtained from the user-approved deepseek_grant_instructions helper.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path"],
      properties: START_ARGUMENT_PROPERTIES
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "run_deepseek_vision",
    description: "Blocking vision entry point: start a local Codex CLI worker with the fixed unified deepseek-flash multimodal model and explicitly supplied local images, and return only when the run reaches a terminal state. Defaults to read-only visual inspection; use workspace-write only for an already approved visually relevant implementation. Source images are always read-only and sandbox-enforced: workspace-write runs reject any image inside the writable workspace or the writable temporary roots, so a workspace-write child can never overwrite an input image. Read-only runs require images inside the static allowed roots or the authorized grant workspace; workspace-write runs require images inside the static allowed roots (never the grant workspace). For an outside-root workspace the grant is claimed before image validation, so invalid images still consume the one-time grant. Prefer start_deepseek_vision, get_deepseek_run, wait_deepseek_run, and cancel_deepseek_run when Sol needs progress or cancellation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path", "images"],
      properties: {
        ...START_ARGUMENT_PROPERTIES,
        images: {
          type: "array",
          minItems: 1,
          maxItems: dispatcherLimits.max_images,
          items: { type: "string", description: "Absolute JPEG, PNG, GIF, or WebP path. Read-only runs accept an image inside the static allowed roots or the authorized grant workspace. Workspace-write runs require an image inside the static allowed roots and outside the writable workspace and the writable temporary roots." }
        },
        mode: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only", description: "Defaults to read-only visual inspection; workspace-write is permitted only for an approved visually relevant implementation and enforces source-image read-only at the sandbox boundary." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "start_deepseek_task",
    description: "Start a coding DeepSeek run without waiting for DeepSeek to finish and return its run_id immediately. Exactly one DeepSeek run may be active at a time; status, get, wait, and cancel stay callable while it runs. Use get_deepseek_run for the current safe snapshot, wait_deepseek_run to block until the run changes or finishes, and cancel_deepseek_run to stop it. Inactivity is reported as health (active, quiet, suspected_stalled) and never completes or kills the run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path"],
      properties: START_ARGUMENT_PROPERTIES
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "start_deepseek_vision",
    description: "Start a vision DeepSeek run without waiting for DeepSeek to finish and return its run_id immediately. Image validation, source-image protection, read-only defaults, and workspace-write boundaries are identical to run_deepseek_vision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path", "images"],
      properties: {
        ...START_ARGUMENT_PROPERTIES,
        images: {
          type: "array",
          minItems: 1,
          maxItems: dispatcherLimits.max_images,
          items: { type: "string", description: "Absolute JPEG, PNG, GIF, or WebP path. Read-only runs accept an image inside the static allowed roots or the authorized grant workspace. Workspace-write runs require an image inside the static allowed roots and outside the writable workspace and the writable temporary roots." }
        },
        mode: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only", description: "Defaults to read-only visual inspection; workspace-write is permitted only for an approved visually relevant implementation and enforces source-image read-only at the sandbox boundary." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "get_deepseek_run",
    description: "Return an immediate safe snapshot of one DeepSeek run: run_id, state, health, revision, timing, model/mode, cleanup flag, terminal result or error, and a bounded redacted event history. Never returns secrets, prompts, allowlist paths, raw command output, or unparsed JSONL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run_id"],
      properties: { run_id: RUN_ID_PROPERTY }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "wait_deepseek_run",
    description: `Wait for a DeepSeek run to change. Returns as soon as the run revision moves past after_revision, the run reaches a terminal state, or timeout_ms elapses. Omit after_revision to wait for the next change from the current revision. timeout_ms is bounded by ${runManagerLimits.max_wait_ms} and defaults to ${runManagerLimits.default_wait_ms}.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run_id"],
      properties: {
        run_id: RUN_ID_PROPERTY,
        after_revision: { type: "integer", minimum: 0, description: "Return only when the run revision is greater than this value." },
        timeout_ms: { type: "integer", minimum: 0, maximum: runManagerLimits.max_wait_ms, default: runManagerLimits.default_wait_ms }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "cancel_deepseek_run",
    description: "Cancel one DeepSeek run and await its bounded cleanup. Idempotent: cancelling an already cancelled run, or a run that already finished, reports the terminal snapshot without error. Inactivity never cancels a run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run_id"],
      properties: { run_id: RUN_ID_PROPERTY }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "deepseek_grant_instructions",
    description: "Validate a local workspace and return structured executable/argv/cwd instructions for the separate, user-approved one-time path grant helper. This tool never grants access and never creates a grant; it only reports whether a grant is required and how to run the helper after approval. Human approval is the external Codex exec approval policy and is not cryptographically or OS-proven by this plugin; never rely on MCP annotations or a persistent approval prefix/rule for the helper. The helper stdout carries the one-time token once and may be retained in Codex host or session audit logs, so treat it as a short-lived secret.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspace_path"],
      properties: {
        workspace_path: { type: "string", description: "Absolute local workspace directory to validate." },
        mode: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
        ttl_sec: { type: "integer", minimum: 60, maximum: 3600, default: 600, description: "Grant lifetime in seconds; it bounds the token only until the grant is claimed at run start." }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

const SERVER_INSTRUCTIONS = "Use run_deepseek_task or run_deepseek_vision for blocking, clearly scoped DeepSeek work, or start_deepseek_task/start_deepseek_vision plus get_deepseek_run, wait_deepseek_run, and cancel_deepseek_run to keep visibility and control while a long run is active. All entry points run the single unified deepseek-flash multimodal model; the coding/vision split only controls image validation, --image arguments, source-image protection, sandbox defaults, and prompt specialization. Exactly one DeepSeek run may be active at a time, and status/get/wait/cancel stay callable while it runs. Terminal state (starting, running, finalizing, completed, failed, cancelled, timed_out) is separate from health (active, quiet after 60 seconds, suspected_stalled after 300 seconds); inactivity never completes or kills a run. run_deepseek_vision defaults to read-only, and workspace-write is allowed only for an approved visually relevant implementation. Workspace-write Vision images must be outside the writable workspace and the writable temporary roots, so source images stay sandbox-enforced read-only. Workspaces inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS need no grant. For an outside-root workspace, call deepseek_grant_instructions, execute its helper in a separate user-approved exec (argv, no shell), and pass the printed one-time token as grant_token. Human approval is the external Codex exec approval policy and is not proven by this plugin; never rely on MCP annotations or a persistent approval prefix/rule for the helper. The helper stdout carries the one-time token once and may be retained in Codex host or session audit logs, so treat it as a short-lived secret; the dispatcher never returns or logs it. Run history is memory-only, bounded, and redacted. Native DeepSeek spawn_agent is not used in ChatGPT-account sessions. Sol must review changes and run final validation.";

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function respondOk(id, payload) {
  respond(id, {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false
  });
}

function errorPayload(error) {
  const known = error instanceof DispatcherError || error instanceof RunManagerError;
  const payload = {
    code: known ? error.code : "internal_error",
    message: known ? error.message : "The local DeepSeek dispatcher failed unexpectedly."
  };
  if (known && error.details) payload.details = error.details;
  return payload;
}

// Managed status is queryable while the run is active and may be retained for
// an hour, so never persist raw stderr diagnostics there. Blocking callers
// still receive the normal direct tool failure shape for validation errors.
function managedErrorPayload(error, runId) {
  const payload = errorPayload(error);
  const details = { run_id: runId };
  if (!payload.details || typeof payload.details !== "object") return { ...payload, details };
  for (const key of ["run_id", "elapsed_ms", "exit_code", "cleanup_forced"]) {
    const value = payload.details[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      details[key] = value;
    }
  }
  return Object.keys(details).length > 0 ? { ...payload, details } : { code: payload.code, message: payload.message };
}

function safeFailure(error) {
  const payload = { status: "failed", error: errorPayload(error) };
  return failureContent(payload);
}

function failureContent(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

function requireRunId(args) {
  const runId = args?.run_id;
  if (typeof runId !== "string" || !runId.trim() || runId.length > MAX_RUN_ID_CHARS) {
    throw new DispatcherError("invalid_argument", "run_id must be a non-empty run identifier.");
  }
  return runId;
}

// Argument shape is checked before a run exists so an obviously malformed
// request never allocates a run. Deep validation (mode, grants, images, paths)
// stays in the dispatcher and surfaces as a terminal failed run.
function validateStartArguments(kind, args) {
  if (!args || typeof args !== "object") {
    throw new DispatcherError("invalid_argument", "Tool arguments must be an object.");
  }
  if (typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new DispatcherError("invalid_argument", "prompt must be a non-empty string.");
  }
  if (typeof args.workspace_path !== "string" || !args.workspace_path.trim()) {
    throw new DispatcherError("invalid_argument", "workspace_path must be a non-empty string.");
  }
  if (kind === "vision" && (!Array.isArray(args.images) || args.images.length === 0)) {
    throw new DispatcherError("invalid_argument", "images must contain at least one local image path.");
  }
  return args;
}

function kindForTool(name) {
  return name.includes("vision") ? "vision" : "coding";
}

function terminalStatusForError(error) {
  if (!(error instanceof DispatcherError)) return "failed";
  if (error.code === "cancelled") return "cancelled";
  if (error.code === "timeout") return "timed_out";
  return "failed";
}

async function executeManagedRun(kind, args, runId, signal, hooks) {
  try {
    const result = await runDeepSeek({ kind, ...args }, { runId, signal, hooks });
    return { status: "completed", result, cleanup_forced: result.cleanup_forced };
  } catch (error) {
    if (error instanceof DispatcherError && error.code === "cleanup_failed") cleanupBlocked = true;
    return { status: terminalStatusForError(error), error: managedErrorPayload(error, runId) };
  }
}

function startManagedRun(name, args) {
  const kind = kindForTool(name);
  if (cleanupBlocked) {
    throw new DispatcherError(
      "cleanup_unconfirmed",
      "A previous DeepSeek child did not confirm exit; restart the dispatcher before starting another run."
    );
  }
  try {
    return manager.startRun({
      kind,
      execute: ({ runId, signal, hooks }) => executeManagedRun(kind, args, runId, signal, hooks)
    });
  } catch (error) {
    if (error instanceof RunManagerError && error.code === "busy") {
      throw new DispatcherError("busy", BUSY_MESSAGE);
    }
    throw error;
  }
}

function startRunTool(id, name, args) {
  try {
    validateStartArguments(kindForTool(name), args);
    const runId = startManagedRun(name, args);
    respondOk(id, manager.getRun(runId));
  } catch (error) {
    respond(id, safeFailure(error));
  }
}

// Blocking tools share the managed run path: they create the same run, then
// await its terminal state. They stay cancellable through the same cancel tool
// and through notifications/cancelled.
function blockingRunTool(id, name, args) {
  void (async () => {
    try {
      validateStartArguments(kindForTool(name), args);
      const runId = startManagedRun(name, args);
      blockingRequests.set(id, runId);
      const snapshot = await manager.waitForTerminal(runId);
      if (snapshot && snapshot.state === "completed") {
        respondOk(id, snapshot.result);
      } else {
        respond(id, failureContent({
          status: "failed",
          error: {
            code: snapshot?.error?.code ?? "internal_error",
            message: snapshot?.error?.message ?? "The local DeepSeek dispatcher failed unexpectedly.",
            ...(snapshot?.error?.details ? { details: snapshot.error.details } : {})
          }
        }));
      }
    } catch (error) {
      respond(id, safeFailure(error));
    } finally {
      blockingRequests.delete(id);
    }
  })();
}

function waitRunTool(id, args) {
  void (async () => {
    try {
      const runId = requireRunId(args);
      const snapshot = await manager.waitForRun({
        runId,
        afterRevision: args?.after_revision,
        timeoutMs: args?.timeout_ms
      });
      respondOk(id, snapshot);
    } catch (error) {
      respond(id, safeFailure(error));
    }
  })();
}

function cancelRunTool(id, args) {
  void (async () => {
    try {
      respondOk(id, await manager.cancelRun(requireRunId(args)));
    } catch (error) {
      respond(id, safeFailure(error));
    }
  })();
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "deepseek-local-dispatcher", version: "0.1.0" },
      instructions: SERVER_INSTRUCTIONS
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    const runId = blockingRequests.get(params.requestId);
    if (runId && manager.getRun(runId)?.terminal === false) {
      void manager.cancelRun(runId).catch(() => {});
    }
    return;
  }
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOL_DEFINITIONS });
    return;
  }
  if (method === "tools/call") {
    const args = params.arguments ?? {};
    switch (params.name) {
      case "deepseek_dispatcher_status": {
        const status = {
          ...(await dispatcherStatus()),
          busy: manager.isBusy(),
          cleanup_blocked: cleanupBlocked,
          active_run: manager.activeRun()
        };
        respondOk(id, status);
        return;
      }
      case "deepseek_grant_instructions": {
        try {
          respondOk(id, await deepseekGrantInstructions(args, process.env));
        } catch (error) {
          respond(id, safeFailure(error));
        }
        return;
      }
      case "start_deepseek_task":
      case "start_deepseek_vision":
        startRunTool(id, params.name, args);
        return;
      case "get_deepseek_run": {
        try {
          const snapshot = manager.getRun(requireRunId(args));
          if (!snapshot) throw new DispatcherError("unknown_run", "No DeepSeek run matches that run_id.");
          respondOk(id, snapshot);
        } catch (error) {
          respond(id, safeFailure(error));
        }
        return;
      }
      case "wait_deepseek_run":
        waitRunTool(id, args);
        return;
      case "cancel_deepseek_run":
        cancelRunTool(id, args);
        return;
      case "run_deepseek_task":
      case "run_deepseek_vision":
        blockingRunTool(id, params.name, args);
        return;
      default:
        respond(id, safeFailure(new DispatcherError("unknown_tool", `Unknown tool: ${params.name}`)));
        return;
    }
  }
  respondError(id ?? null, -32601, `Method not found: ${method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let signalShutdownStarted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (signalShutdownStarted) return;
    signalShutdownStarted = true;
    // Stop accepting input, then let the normal loop epilogue await bounded
    // cleanup. Do not force process.exit while a child tree may still exist.
    lines.close();
    process.stdin.pause();
  });
}
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    continue;
  }
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    respondError(message?.id ?? null, -32600, "Invalid Request");
    continue;
  }
  void handle(message).catch(() => respondError(message.id ?? null, -32603, "Internal error"));
}

// MCP shutdown: cancel and clean the active child process instead of leaving an
// orphaned codex exec behind. There is no persistent store to flush and no
// forced process.exit that could outrun Windows process-tree cleanup.
await manager.shutdown();
if (manager.isBusy()) process.exitCode = 1;
