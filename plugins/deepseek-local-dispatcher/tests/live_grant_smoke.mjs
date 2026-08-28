import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runDeepSeek } from "../scripts/dispatcher.mjs";
import { createGrant, GrantError } from "../scripts/grants.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptedWrites = new Set(["DEEPSEEK_GRANT_WRITE_OK\n", "DEEPSEEK_GRANT_WRITE_OK\r\n"]);

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required.");

const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-grant-live-"));
const codexHome = path.join(root, "codex-home");
const workspace = path.join(root, "outside-static-root");
const environment = {
  ...process.env,
  CODEX_HOME: codexHome,
  DEEPSEEK_DISPATCHER_ALLOWED_ROOTS: pluginRoot
};
delete environment.CODEX_CLI_PATH;

try {
  await mkdir(codexHome);
  await execFileAsync(process.env.DEEPSEEK_DISPATCHER_GIT_PATH || "git", ["init", workspace]);
  const grant = await createGrant({
    workspacePath: workspace,
    mode: "workspace-write",
    ttlSec: 60,
    environment
  });
  const result = await runDeepSeek(
    {
      kind: "coding",
      prompt: "Create result.txt containing exactly DEEPSEEK_GRANT_WRITE_OK followed by one newline. Do not modify any other file. Then reply with DISPATCH_GRANT_OK.",
      workspace_path: workspace,
      mode: "workspace-write",
      grant_token: grant.grant_token,
      timeout_sec: 300
    },
    { environment }
  );
  const written = await readFile(path.join(workspace, "result.txt"), "utf8");
  assert.ok(acceptedWrites.has(written), "The granted write produced unexpected content.");

  let replayError;
  try {
    await runDeepSeek(
      {
        kind: "coding",
        prompt: "This replay must not start.",
        workspace_path: workspace,
        mode: "workspace-write",
        grant_token: grant.grant_token,
        timeout_sec: 60
      },
      { environment }
    );
  } catch (error) {
    replayError = error;
  }
  assert.ok(replayError instanceof GrantError || replayError?.code === "grant_consumed");
  assert.equal(replayError.code, "grant_consumed");

  process.stdout.write(`${JSON.stringify({
    status: result.status,
    model: result.model,
    mode: result.mode,
    response_contains_marker: result.response.includes("DISPATCH_GRANT_OK"),
    file_verified: true,
    replay_rejected: replayError.code
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
