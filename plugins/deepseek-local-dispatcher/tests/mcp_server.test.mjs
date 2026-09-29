import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(environment) {
  const server = spawn(process.execPath, [path.join(pluginRoot, "scripts", "server.mjs")], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...environment }
  });
  const pending = new Map();
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  function request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`)), 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async function close() {
    if (server.exitCode !== null) return;
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.stdin.end();
    let closeTimer;
    const closeTimeout = new Promise((resolve) => {
      closeTimer = setTimeout(() => resolve(false), 5_000);
    });
    const closed = await Promise.race([
      exited.then(() => true),
      closeTimeout
    ]);
    clearTimeout(closeTimer);
    if (!closed) {
      server.kill();
      await exited;
      throw new Error(`Timed out waiting for the MCP test server to exit; stderr=${stderr}`);
    }
  }
  return { server, request, close };
}

test("MCP server initializes, advertises bounded tools, and returns secret-free status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-mcp-"));
  const workspace = path.join(root, "repo");
  const cliDirectory = process.platform === "win32"
    ? path.join(root, "OpenAI", "Codex", "bin", "path-alias")
    : path.join(root, "cli");
  const cliExecutable = path.join(cliDirectory, process.platform === "win32" ? "codex.exe" : "codex");
  await mkdir(workspace);
  await mkdir(cliDirectory, { recursive: true });
  await writeFile(cliExecutable, "test");
  const client = startServer({
    CODEX_CLI_PATH: "",
    LOCALAPPDATA: root,
    PATH: `${cliDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    DEEPSEEK_API_KEY: "mcp-test-secret",
    DEEPSEEK_DISPATCHER_ALLOWED_ROOTS: root
  });
  try {
    const initialized = await client.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(initialized.result.serverInfo.name, "deepseek-local-dispatcher");
    assert.match(initialized.result.instructions, /Native DeepSeek spawn_agent is not used/);
    assert.match(initialized.result.instructions, /deepseek-flash/);

    const listed = await client.request(2, "tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "deepseek_dispatcher_status",
        "run_deepseek_task",
        "run_deepseek_vision",
        "start_deepseek_task",
        "start_deepseek_vision",
        "get_deepseek_run",
        "wait_deepseek_run",
        "cancel_deepseek_run",
        "deepseek_grant_instructions"
      ]
    );
    const visionTool = listed.result.tools.find((tool) => tool.name === "run_deepseek_vision");
    const taskTool = listed.result.tools.find((tool) => tool.name === "run_deepseek_task");
    assert.match(taskTool.description, /deepseek-flash/);
    assert.match(visionTool.description, /deepseek-flash/);
    assert.equal(taskTool.inputSchema.properties.mode.default, "read-only");
    assert.equal(visionTool.inputSchema.properties.mode.default, "read-only");
    assert.deepEqual(visionTool.inputSchema.properties.mode.enum, ["read-only", "workspace-write"]);
    assert.equal(visionTool.annotations.readOnlyHint, false);
    assert.equal(visionTool.annotations.destructiveHint, true);
    assert.match(visionTool.description, /workspace-write only for an already approved visually relevant implementation/);
    assert.match(visionTool.description, /Source images are always read-only/);

    const getTool = listed.result.tools.find((tool) => tool.name === "get_deepseek_run");
    const waitTool = listed.result.tools.find((tool) => tool.name === "wait_deepseek_run");
    for (const tool of [getTool, waitTool]) {
      assert.equal(tool.inputSchema.properties.event_limit.default, 10);
      assert.equal(tool.inputSchema.properties.event_limit.minimum, 1);
      assert.equal(tool.inputSchema.properties.event_limit.maximum, 50);
      assert.equal(tool.inputSchema.properties.event_from.minimum, 1);
    }
    assert.match(getTool.description, /latest 10 retained events/);
    assert.match(getTool.description, /event_window/);

    const status = await client.request(3, "tools/call", {
      name: "deepseek_dispatcher_status",
      arguments: {}
    });
    assert.equal(status.result.isError, false);
    assert.equal(status.result.structuredContent.api_key_present, true);
    assert.equal(status.result.structuredContent.grant_support, true);
    assert.equal(status.result.structuredContent.cleanup_blocked, false);
    assert.equal(JSON.stringify(status).includes("mcp-test-secret"), false);

    const rejected = await client.request(4, "tools/call", {
      name: "run_deepseek_task",
      arguments: { prompt: "test", workspace_path: path.dirname(root) }
    });
    assert.equal(rejected.result.isError, true);
    assert.equal(rejected.result.structuredContent.error.code, "grant_required");

    const instructions = await client.request(5, "tools/call", {
      name: "deepseek_grant_instructions",
      arguments: { workspace_path: workspace, mode: "read-only", ttl_sec: 600 }
    });
    assert.equal(instructions.result.isError, false);
    assert.equal(instructions.result.structuredContent.grant_required, false);
    assert.equal(instructions.result.structuredContent.helper, null);
    assert.equal(instructions.result.structuredContent.workspace, path.resolve(workspace));

    // The async API returns a run id before deep validation finishes. This
    // outside-root request then becomes a queryable terminal failure without
    // spawning a real CLI process.
    const started = await client.request(6, "tools/call", {
      name: "start_deepseek_task",
      arguments: { prompt: "test", workspace_path: path.dirname(root) }
    });
    assert.equal(started.result.isError, false);
    const runId = started.result.structuredContent.run_id;
    assert.equal(typeof runId, "string");
    assert.equal(started.result.structuredContent.terminal, false);

    const waited = await client.request(7, "tools/call", {
      name: "wait_deepseek_run",
      arguments: {
        run_id: runId,
        after_revision: started.result.structuredContent.revision,
        timeout_ms: 5_000
      }
    });
    assert.equal(waited.result.isError, false);
    assert.equal(waited.result.structuredContent.state, "failed");
    assert.equal(waited.result.structuredContent.error.code, "grant_required");
    assert.equal(waited.result.structuredContent.error.details.run_id, runId);

    const fetched = await client.request(8, "tools/call", {
      name: "get_deepseek_run",
      arguments: { run_id: runId }
    });
    assert.equal(fetched.result.structuredContent.run_id, runId);
    assert.equal(fetched.result.structuredContent.terminal, true);

    const cancelled = await client.request(9, "tools/call", {
      name: "cancel_deepseek_run",
      arguments: { run_id: runId }
    });
    assert.equal(cancelled.result.isError, false);
    assert.equal(cancelled.result.structuredContent.already_terminal, true);

    const finalStatus = await client.request(10, "tools/call", {
      name: "deepseek_dispatcher_status",
      arguments: {}
    });
    assert.equal(finalStatus.result.structuredContent.busy, false);
    assert.equal(finalStatus.result.structuredContent.active_run, null);

    // The immediate snapshot returns a bounded, seq-tagged event window by
    // default (created + terminal for this failure), never the unbounded history.
    const windowed = await client.request(11, "tools/call", {
      name: "get_deepseek_run",
      arguments: { run_id: runId }
    });
    assert.equal(windowed.result.isError, false);
    const defaultWindow = windowed.result.structuredContent.event_window;
    assert.equal(defaultWindow.limit, 10);
    assert.equal(defaultWindow.requested_from, null);
    assert.equal(defaultWindow.retained_from, 1);
    assert.equal(defaultWindow.returned_from, 1);
    assert.equal(defaultWindow.returned_count, windowed.result.structuredContent.events.length);
    assert.equal(defaultWindow.truncated_before, false);
    for (const event of windowed.result.structuredContent.events) {
      assert.equal(Number.isSafeInteger(event.seq), true);
    }

    // A windowed get pages retained events by event_from plus event_limit.
    const paged = await client.request(12, "tools/call", {
      name: "get_deepseek_run",
      arguments: { run_id: runId, event_from: 1, event_limit: 1 }
    });
    assert.equal(paged.result.isError, false);
    assert.equal(paged.result.structuredContent.events.length, 1);
    assert.equal(paged.result.structuredContent.events[0].seq, 1);
    assert.equal(paged.result.structuredContent.event_window.limit, 1);
    assert.equal(paged.result.structuredContent.event_window.requested_from, 1);
    assert.equal(paged.result.structuredContent.event_window.next_from, 2);
    assert.equal(paged.result.structuredContent.event_window.has_more_after, true);

    // Invalid window arguments are rejected as a tool error, not a crash.
    const badLimit = await client.request(13, "tools/call", {
      name: "get_deepseek_run",
      arguments: { run_id: runId, event_limit: 0 }
    });
    assert.equal(badLimit.result.isError, true);
    assert.equal(badLimit.result.structuredContent.error.code, "invalid_argument");

    // wait_deepseek_run projects the identical window shape.
    const waitedWindow = await client.request(14, "tools/call", {
      name: "wait_deepseek_run",
      arguments: { run_id: runId, after_revision: 0, event_from: 2, event_limit: 5 }
    });
    assert.equal(waitedWindow.result.isError, false);
    assert.equal(waitedWindow.result.structuredContent.event_window.requested_from, 2);
    assert.equal(waitedWindow.result.structuredContent.terminal, true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
