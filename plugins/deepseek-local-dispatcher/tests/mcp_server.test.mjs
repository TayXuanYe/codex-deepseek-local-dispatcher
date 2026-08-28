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
    server.stdin.end();
    await new Promise((resolve) => server.once("exit", resolve));
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

    const listed = await client.request(2, "tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["deepseek_dispatcher_status", "run_deepseek_task", "run_deepseek_vision", "deepseek_grant_instructions"]
    );

    const status = await client.request(3, "tools/call", {
      name: "deepseek_dispatcher_status",
      arguments: {}
    });
    assert.equal(status.result.isError, false);
    assert.equal(status.result.structuredContent.api_key_present, true);
    assert.equal(status.result.structuredContent.grant_support, true);
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
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
