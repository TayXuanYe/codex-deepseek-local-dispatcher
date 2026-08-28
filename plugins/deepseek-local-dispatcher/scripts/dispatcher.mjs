import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GrantError,
  boundedTtl,
  claimGrant,
  environmentValue,
  isWindowsNetworkPath,
  normalizeMode,
  validateWorkspaceTarget
} from "./grants.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1800;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024;

const MODELS = Object.freeze({
  coding: "deepseek-v4-flash",
  vision: "deepseek-v4-flash-vision-exp"
});

export class DispatcherError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DispatcherError";
    this.code = code;
    this.details = details;
  }
}

function wrapGrantError(error) {
  if (error instanceof GrantError) {
    return new DispatcherError(error.code, error.message, error.details);
  }
  return error;
}

function boundedInteger(raw, fallback, maximum) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DispatcherError("invalid_configuration", "Configured numeric limits must be positive integers.");
  }
  return Math.min(parsed, maximum);
}

function requirePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new DispatcherError("invalid_argument", "prompt must be a non-empty string.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new DispatcherError("invalid_argument", `prompt exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
  }
  return prompt.trim();
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function allowedRoots(environment) {
  const configured = environment.DEEPSEEK_DISPATCHER_ALLOWED_ROOTS;
  if (!configured) {
    throw new DispatcherError(
      "configuration_error",
      "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS is not set; no workspace or image path is authorized."
    );
  }
  const roots = [];
  for (const entry of configured.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
    let canonical;
    try {
      canonical = await fs.realpath(entry);
    } catch {
      throw new DispatcherError("configuration_error", "An allowed root does not exist or cannot be resolved.");
    }
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) {
      throw new DispatcherError("configuration_error", "Every allowed root must be a directory.");
    }
    roots.push(path.resolve(canonical));
  }
  if (roots.length === 0) {
    throw new DispatcherError("configuration_error", "At least one allowed root is required.");
  }
  return roots;
}

async function authorizePath(candidate, roots, expectedType, contextLabel = "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS") {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new DispatcherError("invalid_argument", "Paths must be absolute.");
  }
  let canonical;
  try {
    canonical = path.resolve(await fs.realpath(candidate));
  } catch {
    throw new DispatcherError("invalid_path", "The requested path does not exist or cannot be resolved.");
  }
  if (!roots.some((root) => isWithin(canonical, root))) {
    throw new DispatcherError("path_not_allowed", `The requested path is outside ${contextLabel}.`);
  }
  const stat = await fs.stat(canonical);
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new DispatcherError("invalid_path", "workspace_path must resolve to a directory.");
  }
  if (expectedType === "file" && !stat.isFile()) {
    throw new DispatcherError("invalid_path", "An image path must resolve to a regular file.");
  }
  return { path: canonical, stat };
}

// Closes the workspace TOCTOU between authorization and execution. The run is
// authorized against an exact canonical snapshot, so the workspace is re-resolved
// immediately before spawning and must resolve to exactly the same location. If
// it moved, was swapped, or became unresolvable, the run fails instead of
// spawning against a different path.
export async function verifyWorkspaceUnchanged(snapshotPath) {
  if (typeof snapshotPath !== "string" || !path.isAbsolute(snapshotPath)) {
    throw new DispatcherError(
      "invalid_argument",
      "The authorized workspace snapshot must be an absolute path."
    );
  }
  let current;
  try {
    current = path.resolve(await fs.realpath(snapshotPath));
  } catch (error) {
    throw new DispatcherError(
      "path_changed",
      "The authorized workspace is no longer accessible; refusing to start the run.",
      error.message
    );
  }
  if (current !== snapshotPath) {
    throw new DispatcherError(
      "path_changed",
      "The authorized workspace moved or changed; refusing to start the run."
    );
  }
  return current;
}

function imageFormat(header) {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpeg";
  if (header.length >= 6 && ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return "gif";
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

async function inspectExecutable(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  try {
    const canonical = path.resolve(await fs.realpath(candidate));
    const stat = await fs.stat(canonical);
    return stat.isFile() ? { path: canonical, modified: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function desktopBinRoot(environment) {
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  if (typeof localAppData !== "string" || !path.isAbsolute(localAppData) || isWindowsNetworkPath(localAppData)) return null;
  const candidate = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const canonical = path.resolve(await fs.realpath(candidate));
    if (isWindowsNetworkPath(canonical)) return null;
    return (await fs.stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

async function discoverDesktopCodex(environment) {
  const binDirectory = await desktopBinRoot(environment);
  if (!binDirectory) return null;
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const direct = await inspectExecutable(path.join(binDirectory, executableName));
  if (direct && isWithin(direct.path, binDirectory)) return direct.path;
  const candidates = [];
  try {
    const entries = await fs.readdir(binDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-f0-9]{16}$/i.test(entry.name)) {
        candidates.push(path.join(binDirectory, entry.name, executableName));
      }
    }
  } catch {
    return null;
  }
  const discovered = (await Promise.all(candidates.map(inspectExecutable)))
    .filter((candidate) => candidate && isWithin(candidate.path, binDirectory));
  discovered.sort((left, right) => (right.modified - left.modified) || left.path.localeCompare(right.path));
  return discovered[0]?.path ?? null;
}

async function discoverPathCodex(environment) {
  const configuredPath = environmentValue(environment, "PATH");
  if (typeof configuredPath !== "string" || !configuredPath.trim()) return null;
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const trustedWindowsRoot = process.platform === "win32" ? await desktopBinRoot(environment) : null;
  for (const entry of configuredPath.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    if (process.platform === "win32" && (isWindowsNetworkPath(directory) || !trustedWindowsRoot)) continue;
    const discovered = await inspectExecutable(path.join(directory, executableName));
    if (!discovered) continue;
    if (process.platform === "win32" &&
      (isWindowsNetworkPath(discovered.path) || !isWithin(discovered.path, trustedWindowsRoot))) continue;
    return discovered.path;
  }
  return null;
}

export async function resolveCodexExecutable(environment = process.env) {
  const explicit = environmentValue(environment, "CODEX_CLI_PATH");
  if (explicit) {
    const discovered = await inspectExecutable(explicit);
    if (discovered) return discovered.path;
    throw new DispatcherError("cli_not_found", "CODEX_CLI_PATH does not point to an existing file.");
  }
  const desktopExecutable = await discoverDesktopCodex(environment);
  if (desktopExecutable) return desktopExecutable;
  const pathExecutable = await discoverPathCodex(environment);
  if (pathExecutable) return pathExecutable;
  throw new DispatcherError(
    "cli_not_configured",
    "The Codex CLI could not be discovered from the Codex Desktop installation or PATH."
  );
}

async function validateImages(imagePaths, roots, contextLabel = "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS") {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new DispatcherError("invalid_argument", "images must contain at least one local image path.");
  }
  if (imagePaths.length > MAX_IMAGES) {
    throw new DispatcherError("invalid_argument", `At most ${MAX_IMAGES} images are allowed per dispatcher request.`);
  }
  const images = [];
  let totalBytes = 0;
  for (const candidate of imagePaths) {
    const authorized = await authorizePath(candidate, roots, "file", contextLabel);
    if (authorized.stat.size > MAX_IMAGE_BYTES) {
      throw new DispatcherError("image_too_large", "A local image exceeds DeepSeek's 32 MiB inline-image limit.");
    }
    totalBytes += authorized.stat.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new DispatcherError("images_too_large", "Images exceed DeepSeek's 48 MiB inline request-body limit.");
    }
    const handle = await fs.open(authorized.path, "r");
    let header;
    try {
      header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const format = imageFormat(header);
    if (!format) {
      throw new DispatcherError("unsupported_image", "Only JPEG, PNG, GIF, and WebP image content is supported.");
    }
    images.push({ path: authorized.path, bytes: authorized.stat.size, format });
  }
  return images;
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "/"));
}

export function buildCodexArgs({ model, workspacePath, mode, catalogPath, imagePaths = [] }) {
  if (![MODELS.coding, MODELS.vision].includes(model)) {
    throw new DispatcherError("invalid_model", "The dispatcher only permits its fixed DeepSeek coding and vision models.");
  }
  if (!["read-only", "workspace-write"].includes(mode)) {
    throw new DispatcherError("invalid_argument", "mode must be read-only or workspace-write.");
  }
  const provider = "model_providers.deepseek={ name = \"DeepSeek\", base_url = \"https://api.deepseek.com/\", wire_api = \"responses\", env_key = \"DEEPSEEK_API_KEY\", env_key_instructions = \"Set DEEPSEEK_API_KEY externally.\" }";
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--color",
    "never",
    "--ignore-user-config",
    "-c",
    provider,
    "-c",
    "model_provider=\"deepseek\"",
    "-c",
    `model_catalog_json=${tomlString(catalogPath)}`,
    "-c",
    "model_reasoning_effort=\"high\"",
    "-c",
    "approval_policy=\"never\"",
    "-c",
    "shell_environment_policy.inherit=\"core\"",
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "-c",
    "windows.sandbox=\"elevated\"",
    "--sandbox",
    mode,
    "--cd",
    workspacePath,
    "--model",
    model
  ];
  for (const imagePath of imagePaths) args.push("--image", imagePath);
  args.push("-");
  return args;
}

function workerPrompt(kind, task, mode) {
  if (kind === "vision") {
    return `You are a visual inspection worker reporting to Sol. Analyze only the supplied images and the delegated question. Do not edit files. State uncertainty instead of guessing unreadable details. Return concise findings and evidence.\n\nDelegated task:\n${task}`;
  }
  const permission = mode === "workspace-write"
    ? "You may edit only files required by the delegated task."
    : "This is a read-only run. Do not modify files.";
  return `You are an implementation-focused coding worker reporting to Sol. Follow the delegated scope exactly, preserve existing architecture, do not broaden scope, and do not claim validation passed unless it was executed. ${permission} End with Changed, Validated, and Remaining.\n\nDelegated task:\n${task}`;
}

function controlledEnvironment(environment) {
  const names = [
    "APPDATA", "CODEX_HOME", "COMSPEC", "DEEPSEEK_API_KEY", "HOMEDRIVE", "HOMEPATH",
    "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"
  ];
  const result = {};
  for (const name of names) {
    const value = environmentValue(environment, name);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function redact(text, environment, extraSecrets = []) {
  let safe = String(text ?? "");
  const secret = environmentValue(environment, "DEEPSEEK_API_KEY");
  if (secret) safe = safe.split(secret).join("[REDACTED]");
  for (const value of extraSecrets) {
    if (typeof value === "string" && value) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
}

export function parseCodexJsonl(output, environment = process.env, extraSecrets = []) {
  let threadId = null;
  let response = null;
  let usage = null;
  const failures = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") threadId = event.thread_id ?? null;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      response = event.item.text;
    }
    if (event.type === "turn.completed") usage = event.usage ?? null;
    if (event.type === "turn.failed" || event.type === "error") {
      failures.push(event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event));
    }
  }
  return {
    thread_id: threadId,
    response: response ? redact(response, environment, extraSecrets) : null,
    usage,
    failures: failures.map((value) => redact(value, environment, extraSecrets))
  };
}

function classifyFailure(text) {
  const normalized = text.toLowerCase();
  if (/\b401\b|invalid api key|authentication|unauthorized/.test(normalized)) return "authentication_error";
  if (/\b429\b|rate limit|too many requests/.test(normalized)) return "rate_limited";
  if (/model.*not supported|unsupported model|does not support image/.test(normalized)) return "unsupported_model";
  if (/context length|context window|too many tokens/.test(normalized)) return "context_limit";
  if (/approval|permission denied|read-only sandbox|writing is blocked|outside.*writable/.test(normalized)) return "permission_denied";
  return "provider_or_cli_error";
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
}

async function executeCodex({ executable, args, prompt, workspacePath, timeoutMs, outputLimit, environment, signal, spawnImpl }) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd: workspacePath,
      env: controlledEnvironment(environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopReason = null;
    let settled = false;

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      terminateProcessTree(child);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) return stop("output_limit");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > outputLimit) return stop("output_limit");
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DispatcherError("cli_start_failed", "The local Codex CLI could not be started.", error.message));
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: closeSignal,
        stopReason,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

export async function dispatcherStatus(environment = process.env) {
  let cliPresent = false;
  try {
    await resolveCodexExecutable(environment);
    cliPresent = true;
  } catch {
    cliPresent = false;
  }
  let rootCount = 0;
  let rootsConfigured = false;
  try {
    rootCount = (await allowedRoots(environment)).length;
    rootsConfigured = true;
  } catch {
    rootsConfigured = false;
  }
  return {
    codex_cli_present: cliPresent,
    api_key_present: Boolean(environmentValue(environment, "DEEPSEEK_API_KEY")),
    allowed_roots_configured: rootsConfigured,
    allowed_roots_count: rootCount,
    grant_support: true,
    coding_model: MODELS.coding,
    vision_model: MODELS.vision
  };
}

export async function runDeepSeek({ kind, prompt, workspace_path, mode = "read-only", images, timeout_sec, grant_token }, options = {}) {
  const environment = options.environment ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  const startedAt = Date.now();
  const runId = randomUUID();
  const task = requirePrompt(prompt);
  if (!environmentValue(environment, "DEEPSEEK_API_KEY")) {
    throw new DispatcherError("missing_api_key", "DEEPSEEK_API_KEY is not available to the dispatcher.");
  }
  const executable = await resolveCodexExecutable(environment);
  const roots = await allowedRoots(environment);
  const timeoutSeconds = boundedInteger(timeout_sec, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const outputLimit = boundedInteger(
    environmentValue(environment, "DEEPSEEK_DISPATCHER_MAX_OUTPUT_BYTES"),
    DEFAULT_MAX_OUTPUT_BYTES,
    HARD_MAX_OUTPUT_BYTES
  );
  if (kind === "vision") mode = "read-only";
  let normalizedMode;
  try {
    normalizedMode = normalizeMode(mode);
  } catch (error) {
    throw wrapGrantError(error);
  }
  if (kind !== "coding" && kind !== "vision") {
    throw new DispatcherError("invalid_argument", "kind must be coding or vision.");
  }

  // Authorization snapshot. A workspace already inside the static roots needs
  // no grant (an extra grant_token is intentionally ignored and left
  // unconsumed). An outside-root workspace requires a one-time path grant that
  // is claimed atomically here, before image validation for Vision. Claiming
  // first is required by the path boundary: images are read only after the
  // grant owns the workspace, so reading an external image before owning the
  // grant would violate that boundary. Invalid images therefore consume the
  // grant and require a new human-approved grant. The returned snapshot, not
  // the on-disk grant, authorizes the entire run: an expiring token never
  // revokes an in-flight run, which may continue for its full timeout even
  // after grant expiry.
  let workspace;
  let grantSnapshot = null;
  try {
    workspace = await authorizePath(workspace_path, roots, "directory");
  } catch (error) {
    if (!(error instanceof DispatcherError) || error.code !== "path_not_allowed") throw error;
    try {
      grantSnapshot = await claimGrant({
        token: grant_token,
        workspacePath: workspace_path,
        mode: normalizedMode,
        environment
      });
    } catch (grantError) {
      throw wrapGrantError(grantError);
    }
    workspace = { path: grantSnapshot.workspace, stat: await fs.stat(grantSnapshot.workspace) };
  }

  const extraSecrets = typeof grant_token === "string" && grant_token ? [grant_token] : [];
  const imageRoots = grantSnapshot ? [grantSnapshot.workspace] : roots;
  const imageContext = grantSnapshot
    ? "the authorized grant workspace"
    : "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS";
  const validatedImages = kind === "vision" ? await validateImages(images, imageRoots, imageContext) : [];

  const catalogPath = path.join(pluginRoot, "config", "deepseek-models.json");
  const model = kind === "vision" ? MODELS.vision : MODELS.coding;
  // Immediately before spawning, re-resolve the workspace and require exact
  // equality with the authorization snapshot so a moved or swapped workspace
  // can never be executed against a different location.
  const verifiedWorkspace = await verifyWorkspaceUnchanged(workspace.path);
  const args = buildCodexArgs({
    model,
    workspacePath: verifiedWorkspace,
    mode: normalizedMode,
    catalogPath,
    imagePaths: validatedImages.map((image) => image.path)
  });
  const execution = await executeCodex({
    executable,
    args,
    prompt: workerPrompt(kind, task, normalizedMode),
    workspacePath: verifiedWorkspace,
    timeoutMs: timeoutSeconds * 1000,
    outputLimit,
    environment,
    signal: options.signal,
    spawnImpl
  });
  const parsed = parseCodexJsonl(execution.stdout, environment, extraSecrets);
  const elapsedMs = Date.now() - startedAt;
  if (execution.stopReason) {
    const messages = {
      timeout: "The DeepSeek run exceeded its configured timeout.",
      cancelled: "The DeepSeek run was cancelled.",
      output_limit: "The DeepSeek run exceeded its configured output limit."
    };
    throw new DispatcherError(execution.stopReason, messages[execution.stopReason], { run_id: runId, elapsed_ms: elapsedMs });
  }
  if (execution.code !== 0 || parsed.failures.length > 0 || !parsed.response) {
    const diagnostics = redact(
      [...parsed.failures, execution.stderr].filter(Boolean).join("\n"),
      environment,
      extraSecrets
    ).slice(-8000);
    throw new DispatcherError(
      classifyFailure(diagnostics),
      "The DeepSeek provider or local Codex CLI run failed.",
      { run_id: runId, exit_code: execution.code, diagnostics }
    );
  }
  return {
    run_id: runId,
    status: "completed",
    model,
    mode: normalizedMode,
    elapsed_ms: elapsedMs,
    thread_id: parsed.thread_id,
    response: parsed.response,
    usage: parsed.usage,
    images: validatedImages.map(({ format, bytes }) => ({ format, bytes }))
  };
}

export async function deepseekGrantInstructions(args = {}, environment = process.env) {
  let mode;
  let ttl;
  try {
    mode = normalizeMode(args.mode ?? "read-only");
    ttl = boundedTtl(args.ttl_sec);
  } catch (error) {
    throw wrapGrantError(error);
  }
  const roots = await allowedRoots(environment);
  let workspace;
  let grantRequired = false;
  try {
    workspace = await authorizePath(args.workspace_path, roots, "directory");
  } catch (error) {
    if (!(error instanceof DispatcherError) || error.code !== "path_not_allowed") throw error;
    grantRequired = true;
    try {
      workspace = { path: await validateWorkspaceTarget(args.workspace_path) };
    } catch (grantError) {
      throw wrapGrantError(grantError);
    }
  }
  const grantScript = path.join(pluginRoot, "scripts", "grant.mjs");
  const helper = grantRequired
    ? {
        executable: process.execPath,
        argv: [
          grantScript,
          "--workspace-path",
          workspace.path,
          "--mode",
          mode,
          "--ttl-sec",
          String(ttl)
        ],
        cwd: pluginRoot,
        env: ["CODEX_HOME", "USERPROFILE"]
      }
    : null;
  const instructions = grantRequired
    ? "This workspace is outside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS, so a one-time path grant is required. Run the helper exactly once through a separate human-approved Codex exec (argv, no shell). Human approval is the external Codex exec approval policy: this plugin does not cryptographically or OS-prove approval, and MCP annotations never enforce it, so never rely on them. Do not request or reuse a persistent approval prefix or rule for the grant helper. The helper prints the one-time token exactly once as JSON on stdout; that stdout may be retained in Codex host or session audit logs, so treat the token as a short-lived secret. Pass it as grant_token to run_deepseek_task or run_deepseek_vision without echoing it elsewhere. The token TTL only gates the atomic claim at run start: once claimed, the run may continue for its full timeout_sec (up to 1800) even if the grant expires mid-run. The token is never stored with the grant, never passed to the child process, and never returned or logged by the dispatcher."
    : "This workspace is inside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS, so no grant is required. An extra grant_token, if provided, is ignored and left unconsumed.";
  return {
    grant_support: true,
    grant_required: grantRequired,
    workspace: workspace.path,
    mode,
    ttl_sec: ttl,
    helper,
    instructions
  };
}

export const dispatcherLimits = Object.freeze({
  max_prompt_chars: MAX_PROMPT_CHARS,
  max_images: MAX_IMAGES,
  max_image_bytes: MAX_IMAGE_BYTES,
  max_total_image_bytes: MAX_TOTAL_IMAGE_BYTES,
  max_timeout_seconds: MAX_TIMEOUT_SECONDS
});
