import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSharp } from "../scripts/image_tools.mjs";

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

async function createFixture(directory) {
  const fixture = path.join(directory, "fixture.png");
  await loadSharp()({ create: { width: 1200, height: 600, channels: 3, background: "#225588" } }).png().toFile(fixture);
  return fixture;
}

test("stdio MCP server negotiates its protocol, lists tools, and returns a bounded overview", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-vision-mcp-test-"));
  const fixture = await createFixture(directory);
  const client = startServer({ DEEPSEEK_VISION_ALLOWED_ROOTS: directory });

  try {
    const initialized = await client.request(1, "initialize", { protocolVersion: "2099-01-01", capabilities: {} });
    assert.equal(initialized.result.protocolVersion, "2025-06-18");
    assert.equal(initialized.result.serverInfo.name, "deepseek-vision-tools");
    client.server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await client.request(2, "tools/list");
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["inspect_image", "get_image_tile", "crop_image"]);

    const inspected = await client.request(3, "tools/call", { name: "inspect_image", arguments: { path: fixture } });
    assert.equal(inspected.result.isError, false);
    assert.equal(inspected.result.content[1].type, "image");
    assert.equal(inspected.result.content[1].mimeType, "image/png");
    assert.ok(inspected.result.content[1].data.length > 100);
    assert.equal(inspected.result.content[0].text.includes(directory), false);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdio MCP server rejects encoded output above the configured safe limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-vision-mcp-test-"));
  const fixture = await createFixture(directory);
  const client = startServer({
    DEEPSEEK_VISION_ALLOWED_ROOTS: directory,
    DEEPSEEK_VISION_MAX_IMAGE_OUTPUT_BYTES: "16"
  });

  try {
    await client.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const inspected = await client.request(2, "tools/call", { name: "inspect_image", arguments: { path: fixture } });
    assert.equal(inspected.result.isError, true);
    assert.match(inspected.result.content[0].text, /output_too_large/);
    assert.equal(inspected.result.content.length, 1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
