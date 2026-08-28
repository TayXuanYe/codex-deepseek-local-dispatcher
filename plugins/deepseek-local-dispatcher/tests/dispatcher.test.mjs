import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DispatcherError,
  buildCodexArgs,
  deepseekGrantInstructions,
  dispatcherStatus,
  parseCodexJsonl,
  resolveCodexExecutable,
  runDeepSeek,
  verifyWorkspaceUnchanged
} from "../scripts/dispatcher.mjs";
import {
  GrantError,
  claimGrant,
  createGrant,
  hashToken,
  resolveGrantDirectory,
  validateWorkspaceTarget
} from "../scripts/grants.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeSpawn(events, capture = {}) {
  return (executable, args, options) => {
    capture.executable = executable;
    capture.args = args;
    capture.options = options;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      if (child.killed) return false;
      child.killed = true;
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1, "SIGTERM");
      });
      return true;
    };
    child.stdin.once("finish", () => events(child));
    return child;
  };
}

function successEvents(child) {
  child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-test" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "DONE" } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
  child.stdout.end();
  child.stderr.end();
  child.exitCode = 0;
  child.emit("close", 0, null);
}

function delayedSuccessEvents(delayMs) {
  return (child) => {
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-delayed" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "DONE" } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0, null);
    }, delayMs);
  };
}

async function fixtureEnvironment() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-test-"));
  const workspace = path.join(root, "repo");
  await mkdir(workspace);
  return {
    root,
    workspace,
    environment: {
      ...process.env,
      CODEX_CLI_PATH: process.execPath,
      DEEPSEEK_API_KEY: "test-secret-value",
      DEEPSEEK_DISPATCHER_ALLOWED_ROOTS: root
    }
  };
}

async function grantRunFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-grant-run-"));
  const staticRoot = path.join(root, "static-root");
  const outsideWorkspace = path.join(root, "outside-repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(staticRoot);
  await mkdir(outsideWorkspace);
  await mkdir(codexHome);
  const environment = {
    ...process.env,
    CODEX_CLI_PATH: process.execPath,
    DEEPSEEK_API_KEY: "grant-run-secret",
    DEEPSEEK_DISPATCHER_ALLOWED_ROOTS: staticRoot,
    CODEX_HOME: codexHome,
    USERPROFILE: root
  };
  return { root, staticRoot, outsideWorkspace, codexHome, environment };
}

const redPixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64"
);

test("buildCodexArgs fixes provider, model, sandbox, catalog, and stdin prompt input", () => {
  const args = buildCodexArgs({
    model: "deepseek-v4-flash",
    workspacePath: "C:\\repo",
    mode: "read-only",
    catalogPath: "C:\\plugin\\models.json"
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("deepseek-v4-flash"));
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("model_provider=\"deepseek\""));
  assert.ok(args.includes("approval_policy=\"never\""));
  assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=false"));
  assert.ok(args.includes("windows.sandbox=\"elevated\""));
  assert.equal(args.at(-1), "-");
  assert.equal(args.some((value) => value.includes("test-secret")), false);
});

test("parseCodexJsonl returns the final response and redacts an accidental key echo", () => {
  const output = [
    JSON.stringify({ type: "thread.started", thread_id: "abc" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "secret-123" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } })
  ].join("\n");
  const parsed = parseCodexJsonl(output, { DeepSeek_Api_Key: "secret-123" });
  assert.equal(parsed.thread_id, "abc");
  assert.equal(parsed.response, "[REDACTED]");
  assert.deepEqual(parsed.usage, { input_tokens: 1 });
});

test("resolveCodexExecutable keeps a valid explicit override ahead of Desktop and PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-explicit-"));
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const explicit = path.join(root, "explicit", executableName);
  const desktop = path.join(root, "OpenAI", "Codex", "bin", "1111111111111111", executableName);
  try {
    await mkdir(path.dirname(explicit), { recursive: true });
    await mkdir(path.dirname(desktop), { recursive: true });
    await writeFile(explicit, "explicit");
    await writeFile(desktop, "desktop");
    const resolved = await resolveCodexExecutable({
      CODEX_CLI_PATH: explicit,
      LOCALAPPDATA: root,
      PATH: path.dirname(desktop)
    });
    assert.equal(resolved, path.resolve(explicit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable falls back to the newest Codex Desktop executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-desktop-"));
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const older = path.join(root, "OpenAI", "Codex", "bin", "1111111111111111", executableName);
  const newer = path.join(root, "OpenAI", "Codex", "bin", "2222222222222222", executableName);
  try {
    await mkdir(path.dirname(older), { recursive: true });
    await mkdir(path.dirname(newer), { recursive: true });
    await writeFile(older, "older");
    await writeFile(newer, "newer");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));
    const resolved = await resolveCodexExecutable({ LOCALAPPDATA: root, PATH: "" });
    assert.equal(resolved, path.resolve(newer));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable falls back to PATH when CODEX_CLI_PATH is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-path-"));
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const executable = process.platform === "win32"
    ? path.join(root, "OpenAI", "Codex", "bin", "path-alias", executableName)
    : path.join(root, executableName);
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "test");
    const resolved = await resolveCodexExecutable({ LOCALAPPDATA: root, PATH: path.dirname(executable) });
    assert.equal(resolved, path.resolve(executable));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable rejects an untrusted PATH candidate on Windows", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows trust-boundary test");
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-untrusted-path-"));
  const trustedBin = path.join(root, "OpenAI", "Codex", "bin");
  const untrustedBin = path.join(root, "untrusted");
  try {
    await mkdir(trustedBin, { recursive: true });
    await mkdir(untrustedBin);
    await writeFile(path.join(untrustedBin, "codex.exe"), "test");
    await assert.rejects(
      resolveCodexExecutable({ LOCALAPPDATA: root, PATH: untrustedBin }),
      (error) => error instanceof DispatcherError && error.code === "cli_not_configured"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDeepSeek normalizes mixed-case Windows environment keys for the child", async () => {
  const fixture = await fixtureEnvironment();
  const capture = {};
  try {
    const environment = { ...fixture.environment };
    environment.Path = environment.PATH;
    environment.LocalAppData = environment.LOCALAPPDATA;
    environment.DeepSeek_Api_Key = environment.DEEPSEEK_API_KEY;
    delete environment.PATH;
    delete environment.LOCALAPPDATA;
    delete environment.DEEPSEEK_API_KEY;
    await runDeepSeek(
      { kind: "coding", prompt: "test", workspace_path: fixture.workspace },
      { environment, spawnImpl: fakeSpawn(successEvents, capture) }
    );
    assert.equal(capture.options.env.PATH, environment.Path);
    assert.equal(capture.options.env.LOCALAPPDATA, environment.LocalAppData);
    assert.equal(capture.options.env.DEEPSEEK_API_KEY, environment.DeepSeek_Api_Key);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resolveCodexExecutable rejects an invalid explicit override and an undiscoverable CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-missing-cli-"));
  try {
    await assert.rejects(
      resolveCodexExecutable({ CODEX_CLI_PATH: path.join(root, "missing"), LOCALAPPDATA: root, PATH: "" }),
      (error) => error instanceof DispatcherError && error.code === "cli_not_found"
    );
    await assert.rejects(
      resolveCodexExecutable({ LOCALAPPDATA: root, PATH: "" }),
      (error) => error instanceof DispatcherError && error.code === "cli_not_configured"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDeepSeek executes the fixed coding model with a controlled child environment", async () => {
  const fixture = await fixtureEnvironment();
  const capture = {};
  try {
    const result = await runDeepSeek(
      {
        kind: "coding",
        prompt: "Return a test marker without editing files.",
        workspace_path: fixture.workspace
      },
      { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents, capture) }
    );
    assert.equal(result.status, "completed");
    assert.equal(result.model, "deepseek-v4-flash");
    assert.equal(result.mode, "read-only");
    assert.equal(result.response, "DONE");
    assert.equal(capture.options.shell, false);
    assert.equal(capture.options.env.DEEPSEEK_API_KEY, "test-secret-value");
    assert.equal(capture.args.includes("workspace-write"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek forces Vision to read-only and validates actual PNG content", async () => {
  const fixture = await fixtureEnvironment();
  const image = path.join(fixture.root, "image.bin");
  const capture = {};
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  try {
    const result = await runDeepSeek(
      {
        kind: "vision",
        prompt: "Describe the image.",
        workspace_path: fixture.workspace,
        mode: "workspace-write",
        images: [image]
      },
      { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents, capture) }
    );
    assert.equal(result.model, "deepseek-v4-flash-vision-exp");
    assert.equal(result.mode, "read-only");
    assert.deepEqual(result.images, [{ format: "png", bytes: 9 }]);
    assert.ok(capture.args.includes(image));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek requires a one-time grant for a workspace outside the explicit allowlist", async () => {
  const fixture = await fixtureEnvironment();
  const outside = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-outside-"));
  try {
    await assert.rejects(
      runDeepSeek(
        { kind: "coding", prompt: "test", workspace_path: outside },
        { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents) }
      ),
      (error) => error instanceof DispatcherError && error.code === "grant_required"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("dispatcherStatus reports presence booleans without returning secret or root values", async () => {
  const fixture = await fixtureEnvironment();
  try {
    const status = await dispatcherStatus(fixture.environment);
    assert.equal(status.codex_cli_present, true);
    assert.equal(status.api_key_present, true);
    assert.equal(status.allowed_roots_count, 1);
    assert.equal(status.grant_support, true);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("test-secret-value"), false);
    assert.equal(serialized.includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek cancels the active child without returning provider output", async () => {
  const fixture = await fixtureEnvironment();
  const controller = new AbortController();
  try {
    const pending = runDeepSeek(
      { kind: "coding", prompt: "wait", workspace_path: fixture.workspace },
      {
        environment: fixture.environment,
        signal: controller.signal,
        spawnImpl: fakeSpawn(() => {})
      }
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      (error) => error instanceof DispatcherError && error.code === "cancelled"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek stops a child that exceeds the configured output cap", async () => {
  const fixture = await fixtureEnvironment();
  fixture.environment.DEEPSEEK_DISPATCHER_MAX_OUTPUT_BYTES = "32";
  try {
    await assert.rejects(
      runDeepSeek(
        { kind: "coding", prompt: "test", workspace_path: fixture.workspace },
        {
          environment: fixture.environment,
          spawnImpl: fakeSpawn((child) => child.stdout.write("x".repeat(64)))
        }
      ),
      (error) => error instanceof DispatcherError && error.code === "output_limit"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("grant helper creates a one-time grant without storing the plaintext token", async () => {
  const fixture = await grantRunFixture();
  const execFileAsync = promisify(execFile);
  try {
    const script = path.join(pluginRoot, "scripts", "grant.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--workspace-path", fixture.outsideWorkspace, "--mode", "read-only", "--ttl-sec", "300"],
      { env: fixture.environment }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.status, "created");
    assert.equal(result.workspace, path.resolve(fixture.outsideWorkspace));
    assert.equal(result.mode, "read-only");
    assert.equal(result.ttl_sec, 300);
    assert.equal(result.schema_version, 1);
    assert.match(result.grant_token, /^[A-Za-z0-9_-]{43}$/);

    const grantDir = path.join(fixture.codexHome, "deepseek-dispatcher-grants");
    const files = (await readdir(grantDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const stored = await readFile(path.join(grantDir, files[0]), "utf8");
    assert.equal(stored.includes(result.grant_token), false);
    const record = JSON.parse(stored);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.workspace, result.workspace);
    assert.equal(record.mode, "read-only");
    assert.ok(Date.parse(record.expiresAt) > Date.parse(record.issuedAt));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek succeeds for an outside-root workspace with a valid one-time grant", async () => {
  const fixture = await grantRunFixture();
  const capture = {};
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "workspace-write",
      ttlSec: 600,
      environment: fixture.environment
    });
    const result = await runDeepSeek(
      {
        kind: "coding",
        prompt: "Return a test marker without editing files.",
        workspace_path: fixture.outsideWorkspace,
        mode: "workspace-write",
        grant_token: grant.grant_token
      },
      { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents, capture) }
    );
    assert.equal(result.status, "completed");
    assert.equal(result.model, "deepseek-v4-flash");
    assert.equal(result.mode, "workspace-write");
    assert.equal(capture.options.shell, false);
    assert.equal(capture.options.cwd, path.resolve(fixture.outsideWorkspace));
    assert.equal(capture.options.env.DEEPSEEK_API_KEY, "grant-run-secret");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek rejects a grant used for a different exact workspace", async () => {
  const fixture = await grantRunFixture();
  const other = path.join(fixture.root, "other-repo");
  await mkdir(other);
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    await assert.rejects(
      runDeepSeek(
        { kind: "coding", prompt: "test", workspace_path: other, grant_token: grant.grant_token },
        { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents) }
      ),
      (error) => error instanceof DispatcherError && error.code === "grant_mismatch"
    );
    const grantDir = path.join(fixture.codexHome, "deepseek-dispatcher-grants");
    assert.deepEqual(await readdir(grantDir), []); // failed claim leaves no artifact
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runDeepSeek rejects a grant used with a different exact mode", async () => {
  const fixture = await grantRunFixture();
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    await assert.rejects(
      runDeepSeek(
        {
          kind: "coding",
          prompt: "test",
          workspace_path: fixture.outsideWorkspace,
          mode: "workspace-write",
          grant_token: grant.grant_token
        },
        { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents) }
      ),
      (error) => error instanceof DispatcherError && error.code === "grant_mismatch"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("claimGrant rejects an expired grant and removes the claimed artifact", async () => {
  const fixture = await grantRunFixture();
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 60,
      environment: fixture.environment,
      now: Date.now() - 120_000
    });
    await assert.rejects(
      claimGrant({
        token: grant.grant_token,
        workspacePath: fixture.outsideWorkspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_expired"
    );
    const grantDir = path.join(fixture.codexHome, "deepseek-dispatcher-grants");
    assert.deepEqual(await readdir(grantDir), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent claims of one grant allow exactly one success", async () => {
  const fixture = await grantRunFixture();
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    const results = await Promise.allSettled([
      claimGrant({ token: grant.grant_token, workspacePath: fixture.outsideWorkspace, mode: "read-only", environment: fixture.environment }),
      claimGrant({ token: grant.grant_token, workspacePath: fixture.outsideWorkspace, mode: "read-only", environment: fixture.environment })
    ]);
    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry) => entry.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, "grant_consumed");
    assert.equal(fulfilled[0].value.workspace, path.resolve(fixture.outsideWorkspace));
    assert.equal(fulfilled[0].value.mode, "read-only");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replaying an already claimed grant reports grant_consumed", async () => {
  const fixture = await grantRunFixture();
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    const snapshot = await claimGrant({
      token: grant.grant_token,
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      environment: fixture.environment
    });
    assert.equal(snapshot.workspace, path.resolve(fixture.outsideWorkspace));
    await assert.rejects(
      claimGrant({
        token: grant.grant_token,
        workspacePath: fixture.outsideWorkspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_consumed"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("claimGrant rejects malformed and unknown tokens", async () => {
  const fixture = await grantRunFixture();
  try {
    await assert.rejects(
      claimGrant({
        token: "not-a-valid-token-format!",
        workspacePath: fixture.outsideWorkspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_invalid"
    );
    await assert.rejects(
      claimGrant({
        token: "A".repeat(43),
        workspacePath: fixture.outsideWorkspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_invalid"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("claimGrant rejects an invalid schema record and removes the artifact", async () => {
  const fixture = await grantRunFixture();
  try {
    const token = "C".repeat(43);
    const grantDir = path.join(fixture.codexHome, "deepseek-dispatcher-grants");
    await mkdir(grantDir, { recursive: true });
    const id = hashToken(token);
    const now = Date.now();
    await writeFile(
      path.join(grantDir, `${id}.json`),
      JSON.stringify({
        schemaVersion: 999,
        workspace: path.resolve(fixture.outsideWorkspace),
        mode: "read-only",
        issuedAt: new Date(now - 10_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString()
      })
    );
    await assert.rejects(
      claimGrant({
        token,
        workspacePath: fixture.outsideWorkspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_invalid"
    );
    assert.deepEqual(await readdir(grantDir), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("grant path validation rejects drive roots and UNC/network paths", async (context) => {
  if (process.platform === "win32") {
    await assert.rejects(
      validateWorkspaceTarget("C:\\"),
      (error) => error instanceof GrantError && error.code === "invalid_argument"
    );
    await assert.rejects(
      validateWorkspaceTarget("\\\\server\\share\\folder"),
      (error) => error instanceof GrantError && error.code === "invalid_argument"
    );
    await assert.rejects(
      validateWorkspaceTarget("\\\\?\\UNC\\server\\share"),
      (error) => error instanceof GrantError && error.code === "invalid_argument"
    );
    await assert.rejects(
      validateWorkspaceTarget("relative/path"),
      (error) => error instanceof GrantError && error.code === "invalid_argument"
    );
  } else {
    await assert.rejects(
      validateWorkspaceTarget("/"),
      (error) => error instanceof GrantError && error.code === "invalid_argument"
    );
  }
  const fixture = await grantRunFixture();
  try {
    assert.equal(await validateWorkspaceTarget(fixture.outsideWorkspace), path.resolve(fixture.outsideWorkspace));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a grant token never reaches the child env, argv, prompt, or returned output", async () => {
  const fixture = await grantRunFixture();
  const capture = { args: [], env: null, prompt: "" };
  const wrappedSpawn = (executable, args, options) => {
    capture.args = args;
    capture.env = options.env;
    const child = fakeSpawn(successEvents)(executable, args, options);
    child.stdin.on("data", (chunk) => { capture.prompt += chunk.toString("utf8"); });
    return child;
  };
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    const leakEvents = (child) => {
      child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `finished ${grant.grant_token}` } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0, null);
    };
    const result = await runDeepSeek(
      { kind: "coding", prompt: "test", workspace_path: fixture.outsideWorkspace, grant_token: grant.grant_token },
      { environment: fixture.environment, spawnImpl: fakeSpawn(leakEvents, capture) }
    );
    assert.equal(result.response, "finished [REDACTED]");
    assert.equal(JSON.stringify(capture.env).includes(grant.grant_token), false);
    assert.equal(JSON.stringify(capture.args).includes(grant.grant_token), false);
    assert.equal(capture.prompt.includes(grant.grant_token), false);
    assert.equal(JSON.stringify(result).includes(grant.grant_token), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an extra grant token is ignored and left unconsumed for an inside-root workspace", async () => {
  const fixture = await fixtureEnvironment();
  const unusedToken = "U".repeat(43);
  try {
    await runDeepSeek(
      { kind: "coding", prompt: "test", workspace_path: fixture.workspace, grant_token: unusedToken },
      { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents) }
    );
    await assert.rejects(
      claimGrant({
        token: unusedToken,
        workspacePath: fixture.workspace,
        mode: "read-only",
        environment: fixture.environment
      }),
      (error) => error instanceof GrantError && error.code === "grant_invalid"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Vision images stay inside the authorized grant workspace", async () => {
  const fixture = await grantRunFixture();
  const imageInside = path.join(fixture.outsideWorkspace, "img.png");
  const imageOutside = path.join(fixture.root, "sibling.png");
  const capture = {};
  await writeFile(imageInside, redPixelPng);
  await writeFile(imageOutside, redPixelPng);
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    const result = await runDeepSeek(
      {
        kind: "vision",
        prompt: "Describe the image.",
        workspace_path: fixture.outsideWorkspace,
        images: [imageInside],
        grant_token: grant.grant_token
      },
      { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents, capture) }
    );
    assert.equal(result.model, "deepseek-v4-flash-vision-exp");
    assert.equal(result.mode, "read-only");

    const secondGrant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 600,
      environment: fixture.environment
    });
    await assert.rejects(
      runDeepSeek(
        {
          kind: "vision",
          prompt: "Describe the image.",
          workspace_path: fixture.outsideWorkspace,
          images: [imageOutside],
          grant_token: secondGrant.grant_token
        },
        { environment: fixture.environment, spawnImpl: fakeSpawn(successEvents) }
      ),
      (error) => error instanceof DispatcherError && error.code === "path_not_allowed"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a grant that expires during a run does not revoke the in-flight run", async () => {
  const fixture = await grantRunFixture();
  const capture = {};
  try {
    const grant = await createGrant({
      workspacePath: fixture.outsideWorkspace,
      mode: "read-only",
      ttlSec: 60,
      environment: fixture.environment,
      now: Date.now() - 58_000
    });
    // The grant expires ~2s after creation; the fake child completes ~2.5s in.
    const result = await runDeepSeek(
      { kind: "coding", prompt: "test", workspace_path: fixture.outsideWorkspace, grant_token: grant.grant_token, timeout_sec: 30 },
      { environment: fixture.environment, spawnImpl: fakeSpawn(delayedSuccessEvents(2_500), capture) }
    );
    assert.equal(result.status, "completed");
    assert.ok(Date.now() > Date.parse(grant.expires_at), "the grant should have expired before the run completed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deepseekGrantInstructions returns a directly spawnable helper payload without creating a grant", async () => {
  const fixture = await grantRunFixture();
  const execFileAsync = promisify(execFile);
  const grantScript = path.join(pluginRoot, "scripts", "grant.mjs");
  try {
    const instructions = await deepseekGrantInstructions(
      { workspace_path: fixture.outsideWorkspace, mode: "workspace-write", ttl_sec: 300 },
      fixture.environment
    );
    assert.equal(instructions.grant_support, true);
    assert.equal(instructions.grant_required, true);
    assert.equal(instructions.workspace, path.resolve(fixture.outsideWorkspace));
    assert.equal(instructions.mode, "workspace-write");
    assert.equal(instructions.ttl_sec, 300);
    assert.equal(instructions.helper.executable, process.execPath);
    // executable + argv are directly usable as spawn(executable, argv, { shell: false }):
    // argv begins with the grant script path and never duplicates the executable.
    assert.equal(instructions.helper.argv[0], grantScript);
    assert.equal(instructions.helper.argv.includes(process.execPath), false);
    assert.ok(instructions.helper.argv.includes("--workspace-path"));
    assert.ok(instructions.helper.argv.includes(fixture.outsideWorkspace));
    assert.equal(instructions.helper.argv.includes("--"), false);
    assert.ok(instructions.instructions.includes("grant_token"));
    assert.ok(instructions.instructions.includes("short-lived secret"));
    assert.ok(instructions.instructions.includes("approval prefix"));
    // The read-only tool never creates the grant store.
    const grantDir = path.join(fixture.codexHome, "deepseek-dispatcher-grants");
    await assert.rejects(readdir(grantDir), (error) => error.code === "ENOENT");
    // The returned payload is directly spawnable with shell:false and names the
    // plaintext field grant_token (never a second copy under token).
    const { stdout } = await execFileAsync(instructions.helper.executable, instructions.helper.argv, {
      cwd: instructions.helper.cwd,
      env: { ...process.env, CODEX_HOME: fixture.codexHome, USERPROFILE: fixture.root }
    });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "created");
    assert.match(result.grant_token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal("token" in result, false);
    const files = (await readdir(grantDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const stored = await readFile(path.join(grantDir, files[0]), "utf8");
    assert.equal(stored.includes(result.grant_token), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deepseekGrantInstructions reports no grant needed for an inside-root workspace", async () => {
  const fixture = await grantRunFixture();
  try {
    const instructions = await deepseekGrantInstructions(
      { workspace_path: fixture.staticRoot, mode: "read-only" },
      fixture.environment
    );
    assert.equal(instructions.grant_required, false);
    assert.equal(instructions.helper, null);
    assert.ok(instructions.instructions.includes("no grant is required"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("grant store resolution rejects relative, drive-root, and UNC bases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-base-"));
  const validHome = path.join(root, "valid-home");
  await mkdir(validHome);
  try {
    await assert.rejects(
      resolveGrantDirectory({ CODEX_HOME: "relative/grants" }),
      (error) => error instanceof GrantError && error.code === "configuration_error"
    );
    await assert.rejects(
      resolveGrantDirectory({ CODEX_HOME: "", USERPROFILE: "relative/profile" }),
      (error) => error instanceof GrantError && error.code === "configuration_error"
    );
    await assert.rejects(
      resolveGrantDirectory({ CODEX_HOME: "", USERPROFILE: "" }),
      (error) => error instanceof GrantError && error.code === "configuration_error"
    );
    if (process.platform === "win32") {
      await assert.rejects(
        resolveGrantDirectory({ CODEX_HOME: "C:\\" }),
        (error) => error instanceof GrantError && error.code === "configuration_error"
      );
      await assert.rejects(
        resolveGrantDirectory({ CODEX_HOME: "\\\\server\\share\\grants" }),
        (error) => error instanceof GrantError && error.code === "configuration_error"
      );
      await assert.rejects(
        resolveGrantDirectory({ CODEX_HOME: "\\\\?\\UNC\\server\\share" }),
        (error) => error instanceof GrantError && error.code === "configuration_error"
      );
      await assert.rejects(
        resolveGrantDirectory({ CODEX_HOME: "", USERPROFILE: "C:\\" }),
        (error) => error instanceof GrantError && error.code === "configuration_error"
      );
    } else {
      await assert.rejects(
        resolveGrantDirectory({ CODEX_HOME: "/" }),
        (error) => error instanceof GrantError && error.code === "configuration_error"
      );
    }
    // A valid absolute local base resolves to the canonical store path and
    // creates it on demand only for creation.
    const resolved = await resolveGrantDirectory({ CODEX_HOME: validHome });
    assert.equal(resolved, path.join(path.resolve(validHome), "deepseek-dispatcher-grants"));
    assert.equal((await stat(resolved)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant store rejects symlinked or junctioned bases and grant directories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-links-"));
  const target = path.join(root, "target");
  await mkdir(target);
  try {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    // A symlink/junction trusted base is rejected outright.
    const linkBase = path.join(root, "linked-base");
    try {
      await symlink(target, linkBase, linkType);
    } catch (error) {
      return context.skip(`link creation unsupported here: ${error.code ?? error.message}`);
    }
    await assert.rejects(
      resolveGrantDirectory({ CODEX_HOME: linkBase }),
      (error) => error instanceof GrantError && error.code === "configuration_error"
    );

    // A symlinked/junctioned grant directory is rejected and never followed.
    const realBase = path.join(root, "real-base");
    await mkdir(realBase);
    const escaped = path.join(target, "deepseek-dispatcher-grants");
    await mkdir(escaped);
    await symlink(escaped, path.join(realBase, "deepseek-dispatcher-grants"), linkType);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await assert.rejects(
      createGrant({
        workspacePath: workspace,
        mode: "read-only",
        ttlSec: 600,
        environment: { CODEX_HOME: realBase }
      }),
      (error) => error instanceof GrantError && error.code === "grant_store_error"
    );
    // The link target must never have received a grant file.
    assert.deepEqual(await readdir(escaped), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claiming a grant never creates a missing store and reports grant_invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-missing-store-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "repo");
  await mkdir(codexHome);
  await mkdir(workspace);
  try {
    await assert.rejects(
      claimGrant({
        token: "A".repeat(43),
        workspacePath: workspace,
        mode: "read-only",
        environment: { CODEX_HOME: codexHome }
      }),
      (error) => error instanceof GrantError && error.code === "grant_invalid"
    );
    const grantDir = path.join(codexHome, "deepseek-dispatcher-grants");
    await assert.rejects(stat(grantDir), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyWorkspaceUnchanged re-resolves the workspace and fails when it moved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-moved-ws-"));
  const workspace = path.join(root, "repo");
  const moved = path.join(root, "repo-moved");
  await mkdir(workspace);
  try {
    assert.equal(await verifyWorkspaceUnchanged(workspace), path.resolve(workspace));
    await rename(workspace, moved);
    await assert.rejects(
      verifyWorkspaceUnchanged(workspace),
      (error) => error instanceof DispatcherError && error.code === "path_changed"
    );
    await assert.rejects(
      verifyWorkspaceUnchanged(path.join(root, "missing")),
      (error) => error instanceof DispatcherError && error.code === "path_changed"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
