import { createInterface } from "node:readline";
import {
  DispatcherError,
  deepseekGrantInstructions,
  dispatcherLimits,
  dispatcherStatus,
  runDeepSeek
} from "./dispatcher.mjs";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const active = new Map();

const TOOL_DEFINITIONS = [
  {
    name: "deepseek_dispatcher_status",
    description: "Check whether the fixed local DeepSeek coding and vision dispatcher is configured and whether one-time path grant support is available. Never returns secret values, paths, or tokens.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "run_deepseek_task",
    description: "Run a bounded local Codex CLI worker using the fixed deepseek-v4-flash model. Defaults to read-only; use workspace-write only for an already approved implementation. Workspaces inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS need no grant; for an outside-root workspace pass a grant_token obtained from the user-approved deepseek_grant_instructions helper.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: dispatcherLimits.max_prompt_chars },
        workspace_path: { type: "string", description: "Absolute path inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS or covered by a one-time path grant." },
        mode: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
        timeout_sec: { type: "integer", minimum: 1, maximum: dispatcherLimits.max_timeout_seconds, default: 600 },
        grant_token: { type: "string", description: "Optional one-time path grant token for a workspace outside the static allowed roots. Ignored (left unconsumed) for workspaces inside the static roots. Never passed to the child or returned in dispatcher output; host/session logs may retain this MCP input, so treat it as a short-lived secret." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "run_deepseek_vision",
    description: "Run a read-only local Codex CLI visual inspection using the fixed deepseek-v4-flash-vision-exp model and explicitly supplied local images. Images must stay inside the static allowed roots or the authorized grant workspace. For an outside-root workspace the grant is claimed before image validation, so invalid images still consume the one-time grant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "workspace_path", "images"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: dispatcherLimits.max_prompt_chars },
        workspace_path: { type: "string", description: "Absolute path inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS or covered by a one-time path grant." },
        images: {
          type: "array",
          minItems: 1,
          maxItems: dispatcherLimits.max_images,
          items: { type: "string", description: "Absolute JPEG, PNG, GIF, or WebP path inside an allowed root or the authorized grant workspace." }
        },
        timeout_sec: { type: "integer", minimum: 1, maximum: dispatcherLimits.max_timeout_seconds, default: 600 },
        grant_token: { type: "string", description: "Optional one-time path grant token for a workspace outside the static allowed roots. Ignored (left unconsumed) for workspaces inside the static roots. Never passed to the child or returned in dispatcher output; host/session logs may retain this MCP input, so treat it as a short-lived secret." }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function safeFailure(error) {
  const known = error instanceof DispatcherError;
  const payload = {
    status: "failed",
    error: {
      code: known ? error.code : "internal_error",
      message: known ? error.message : "The local DeepSeek dispatcher failed unexpectedly."
    }
  };
  if (known && error.details) payload.error.details = error.details;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

async function runTool(id, name, args) {
  if (active.size > 0) {
    respond(id, safeFailure(new DispatcherError("busy", "The dispatcher permits only one active DeepSeek run.")));
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const result = await runDeepSeek(
      name === "run_deepseek_vision"
        ? { kind: "vision", ...args }
        : { kind: "coding", ...args },
      { signal: controller.signal }
    );
    respond(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false
    });
  } catch (error) {
    respond(id, safeFailure(error));
  } finally {
    active.delete(id);
  }
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "deepseek-local-dispatcher", version: "0.1.0" },
      instructions: "Use run_deepseek_task for approved, clearly scoped coding work and run_deepseek_vision only when images materially help. Workspaces inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS need no grant. For an outside-root workspace, call deepseek_grant_instructions, execute its helper in a separate user-approved exec (argv, no shell), and pass the printed one-time token as grant_token. Human approval is the external Codex exec approval policy and is not proven by this plugin; never rely on MCP annotations or a persistent approval prefix/rule for the helper. The helper stdout carries the one-time token once and may be retained in Codex host or session audit logs, so treat it as a short-lived secret; the dispatcher never returns or logs it. Native DeepSeek spawn_agent is not used in ChatGPT-account sessions. Sol must review changes and run final validation."
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    active.get(params.requestId)?.abort();
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
    if (params.name === "deepseek_dispatcher_status") {
      const status = { ...(await dispatcherStatus()), busy: active.size > 0 };
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
        isError: false
      });
      return;
    }
    if (params.name === "deepseek_grant_instructions") {
      try {
        const instructions = await deepseekGrantInstructions(params.arguments ?? {}, process.env);
        respond(id, {
          content: [{ type: "text", text: JSON.stringify(instructions, null, 2) }],
          structuredContent: instructions,
          isError: false
        });
      } catch (error) {
        respond(id, safeFailure(error));
      }
      return;
    }
    if (["run_deepseek_task", "run_deepseek_vision"].includes(params.name)) {
      void runTool(id, params.name, params.arguments ?? {});
      return;
    }
    respond(id, safeFailure(new DispatcherError("unknown_tool", `Unknown tool: ${params.name}`)));
    return;
  }
  respondError(id ?? null, -32601, `Method not found: ${method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
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

for (const controller of active.values()) controller.abort();
