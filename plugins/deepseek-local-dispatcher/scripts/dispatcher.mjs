import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
// A structurally complete codex exec turn publishes `turn.completed` plus the
// final `agent_message`. Once both are seen the worker has nothing left to
// report, so the process is allowed a short exit grace and then the process
// tree is cleaned up instead of waiting for a child that never exits.
const DEFAULT_FINALIZE_GRACE_MS = 10_000;
const DEFAULT_CLEANUP_WAIT_MS = 5_000;
const STDERR_TAIL_CHARS = 8_192;
const MAX_EVENT_TEXT_CHARS = 2_000;
const MAX_EVENT_MESSAGE_CHARS = 500;
const MAX_EVENT_IDENTIFIER_CHARS = 128;

const defaultTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle)
};

// The officially released DeepSeek Flash model is a single unified multimodal
// generator, so both entry points resolve to exactly one model ID. The coding
// and vision keys are kept because `kind` still selects the entry-point
// semantics (image validation, --image arguments, source-image protection,
// read-only defaults, and prompt specialization).
const MODELS = Object.freeze({
  coding: "deepseek-flash",
  vision: "deepseek-flash"
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

// Canonical writable temp roots a workspace-write child can reach. Source
// images must never live where the child could overwrite them, so
// workspace-write Vision rejects any image inside the writable workspace or
// inside any canonical writable temp root (TEMP, TMP, and Node's os.tmpdir()
// when they exist). Only directories that actually resolve are included.
async function writableTempRoots(environment) {
  const candidates = [];
  for (const name of ["TEMP", "TMP"]) {
    const value = environmentValue(environment, name);
    if (typeof value === "string" && value.trim() !== "") candidates.push(value.trim());
  }
  candidates.push(os.tmpdir());
  const roots = new Set();
  for (const candidate of candidates) {
    try {
      const canonical = path.resolve(await fs.realpath(candidate));
      if ((await fs.stat(canonical)).isDirectory()) roots.add(canonical);
    } catch {
      // A missing or unresolvable temp root neither expands nor restricts access.
    }
  }
  return [...roots];
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

async function validateImages(imagePaths, roots, contextLabel = "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS", forbiddenRoots = []) {
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
    if (forbiddenRoots.some((root) => isWithin(authorized.path, root))) {
      throw new DispatcherError(
        "image_not_read_only",
        "Workspace-write Vision images must be outside the writable workspace and outside the writable temporary directories, so a workspace-write child can never overwrite a source image."
      );
    }
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

async function revalidateImages(images, roots, contextLabel, forbiddenRoots) {
  let current;
  try {
    current = await validateImages(images.map((image) => image.path), roots, contextLabel, forbiddenRoots);
  } catch {
    throw new DispatcherError(
      "image_path_changed",
      "An image path changed after authorization and before the DeepSeek worker could start."
    );
  }
  const unchanged = current.length === images.length && current.every((image, index) => {
    const snapshot = images[index];
    return image.path === snapshot.path && image.bytes === snapshot.bytes && image.format === snapshot.format;
  });
  if (!unchanged) {
    throw new DispatcherError(
      "image_path_changed",
      "An image path or file identity changed after authorization and before the DeepSeek worker could start."
    );
  }
  return current;
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "/"));
}

export function buildCodexArgs({ model, workspacePath, mode, catalogPath, imagePaths = [] }) {
  if (![MODELS.coding, MODELS.vision].includes(model)) {
    throw new DispatcherError("invalid_model", "The dispatcher only permits its fixed unified deepseek-flash model.");
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
  const permission = mode === "workspace-write"
    ? "You may edit only files required by the delegated task."
    : "This is a read-only run. Do not modify files.";
  if (kind === "vision") {
    const imageGuard = "Treat source images as read-only; never modify or overwrite an input image.";
    if (mode === "workspace-write") {
      return `You are a DeepSeek Flash visual implementation worker reporting to Sol, running the unified multimodal DeepSeek Flash generator. Analyze the supplied images and follow the delegated scope exactly. Preserve existing architecture, do not broaden scope, and do not claim validation passed unless it was executed. ${imageGuard} ${permission} End with Changed, Validated, and Remaining.\n\nDelegated task:\n${task}`;
    }
    return `You are a DeepSeek Flash visual inspection worker reporting to Sol, running the unified multimodal DeepSeek Flash generator. Analyze only the supplied images and the delegated question. ${permission} ${imageGuard} State uncertainty instead of guessing unreadable details. Return concise findings and evidence.\n\nDelegated task:\n${task}`;
  }
  return `You are a DeepSeek Flash implementation-focused coding worker reporting to Sol, running the unified multimodal DeepSeek Flash generator. Follow the delegated scope exactly, preserve existing architecture, do not broaden scope, and do not claim validation passed unless it was executed. ${permission} End with Changed, Validated, and Remaining.\n\nDelegated task:\n${task}`;
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
  const orderedSecrets = [...new Set(extraSecrets.filter((value) => typeof value === "string" && value))]
    .sort((left, right) => right.length - left.length);
  for (const value of orderedSecrets) {
    if (typeof value !== "string" || !value) continue;
    safe = safe.split(value).join("[REDACTED]");
    // Windows paths are case-insensitive and tools may swap slash styles.
    // Redact those variants too instead of relying on one canonical spelling.
    if (value.length >= 3 && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value))) {
      const pattern = value
        .split(/[\\/]+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[\\\\/]");
      if (pattern) safe = safe.replace(new RegExp(pattern, "gi"), "[REDACTED]");
    }
  }
  return safe;
}

// Incremental codex exec JSONL reader. `codex exec --json` streams one JSON
// object per line, so parsing must survive chunk boundaries and a final line
// without a trailing newline. Only complete lines are decoded; unconsumed bytes
// stay buffered until the next chunk. Raw JSONL is never published: callers
// must normalize an event before it can reach a run history.
export function createCodexJsonlScanner() {
  let buffer = "";
  const parse = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  };
  return {
    push(text) {
      buffer += text;
      const events = [];
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const event = parse(buffer.slice(0, index));
        if (event) events.push(event);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      return events;
    },
    flush() {
      const event = parse(buffer);
      buffer = "";
      return event ? [event] : [];
    }
  };
}

// Folds one codex event into the run summary. Shared by the streaming executor
// and the batch parseCodexJsonl helper so both agree on what a completed turn,
// a final agent message, and a failure look like.
export function reduceCodexEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  if (event.type === "thread.started") {
    state.threadId = event.thread_id ?? null;
  } else if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
    state.response = event.item.text;
  } else if (event.type === "turn.completed") {
    state.usage = event.usage ?? null;
    state.terminalSeen = true;
  } else if (event.type === "turn.failed" || event.type === "error") {
    state.failures.push(event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event));
  }
  return state;
}

function boundedText(value, limit) {
  if (typeof value !== "string") return null;
  return value.length > limit ? `${value.slice(0, limit)}[truncated]` : value;
}

function safeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(usage)) {
    if (!/^[a-z0-9_.]{1,32}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

// Maps one raw codex exec event onto the bounded, redacted shape allowed to
// enter run history. Unknown event kinds return null instead of being copied, so
// no raw stdout, command output, prompt echo, or unparsed JSONL can leak through
// an unrecognized event type.
export function normalizeCodexEvent(event, { environment = process.env, secrets = [] } = {}) {
  if (!event || typeof event !== "object") return null;
  const clean = (value, limit) => boundedText(redact(value, environment, secrets), limit);
  switch (event.type) {
    case "thread.started":
      return { type: "thread_started", thread_id: clean(event.thread_id, MAX_EVENT_IDENTIFIER_CHARS) };
    case "item.completed":
      if (event.item?.type === "agent_message") {
        return { type: "agent_message", text: clean(event.item.text, MAX_EVENT_TEXT_CHARS) };
      }
      return { type: "item_completed", item_type: boundedText(event.item?.type, MAX_EVENT_IDENTIFIER_CHARS) };
    case "turn.completed":
      return { type: "turn_completed", usage: safeUsage(event.usage) };
    case "turn.failed":
      return {
        type: "turn_failed",
        message: clean(event.error?.message ?? event.message ?? "", MAX_EVENT_MESSAGE_CHARS)
      };
    case "error":
      return {
        type: "error",
        message: clean(event.error?.message ?? event.message ?? "", MAX_EVENT_MESSAGE_CHARS)
      };
    default:
      return null;
  }
}

export function parseCodexJsonl(output, environment = process.env, extraSecrets = []) {
  const scanner = createCodexJsonlScanner();
  const state = { threadId: null, response: null, usage: null, terminalSeen: false, failures: [] };
  for (const event of [...scanner.push(output), ...scanner.flush()]) {
    reduceCodexEvent(state, event);
  }
  return {
    thread_id: state.threadId,
    response: state.response ? redact(state.response, environment, extraSecrets) : null,
    usage: state.usage,
    failures: state.failures.map((value) => redact(value, environment, extraSecrets))
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

// Windows process cleanup for a stopped run. taskkill is awaited to completion
// (with a bounded fallback) instead of being fire-and-forget, so the caller
// knows the tree was actually asked to exit before it reports a terminal state.
async function defaultProcessCleanup(child, timers) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      let finished = false;
      let timeoutHandle = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (timeoutHandle !== null) timers.clearTimeout(timeoutHandle);
        resolve();
      };
      let killer;
      try {
        killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
      } catch {
        finish();
        return;
      }
      killer.once("error", finish);
      killer.once("close", finish);
      timeoutHandle = timers.setTimeout(finish, DEFAULT_CLEANUP_WAIT_MS);
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup; the caller's watchdog still bounds the run.
  }
}

async function executeCodex({
  executable,
  args,
  prompt,
  workspacePath,
  timeoutMs,
  outputLimit,
  environment,
  signal,
  spawnImpl,
  timers = defaultTimers,
  hooks = {},
  sanitizeEvent = null,
  finalizeGraceMs = DEFAULT_FINALIZE_GRACE_MS,
  cleanupWaitMs = DEFAULT_CLEANUP_WAIT_MS,
  processCleanup = null
}) {
  const cleanup = processCleanup ?? ((child) => defaultProcessCleanup(child, timers));
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd: workspacePath,
      env: controlledEnvironment(environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const scanner = createCodexJsonlScanner();
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const state = { threadId: null, response: null, usage: null, terminalSeen: false, failures: [] };
    let stderrTail = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopReason = null;
    let settled = false;
    let closing = false;
    let cleanupForced = false;
    let finalizing = false;
    let terminationStarted = false;
    let cleanupPromise = null;
    let closePayload = null;
    let hardTimer = null;
    let graceTimer = null;
    let watchdogTimer = null;

    const clearTimers = () => {
      for (const handle of [hardTimer, graceTimer, watchdogTimer]) {
        if (handle !== null) timers.clearTimeout(handle);
      }
    };
    const buildResult = (code, closeSignal) => ({
      code,
      signal: closeSignal,
      stopReason,
      cleanupForced,
      finalizeSeen: finalizing,
      threadId: state.threadId,
      response: state.response,
      usage: state.usage,
      terminalSeen: state.terminalSeen,
      failures: state.failures.slice(),
      stderrTail,
      stdoutBytes,
      stderrBytes
    });
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      resolve(payload);
    };

    // Bounded escalation: ask the tree to exit, then stop waiting on the child
    // even if it never reports close. The watchdog always settles the promise,
    // so a wedged process can never hold a run open forever.
    const beginTermination = () => {
      if (terminationStarted) return cleanupPromise;
      terminationStarted = true;
      cleanupPromise = Promise.resolve()
        .then(() => cleanup(child))
        .catch(() => {});
      void cleanupPromise.finally(() => {
        if (closePayload !== null) settle(closePayload);
      });
      watchdogTimer = timers.setTimeout(() => {
        cleanupForced = true;
        if (!stopReason) stopReason = "cleanup_failed";
        hooks.onCleanup?.({ forced: true });
        settle(buildResult(child.exitCode, null));
      }, cleanupWaitMs);
      return cleanupPromise;
    };

    function onAbort() {
      stop("cancelled");
    }

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      beginTermination();
    };

    const handleEvent = (event) => {
      hooks.onActivity?.();
      reduceCodexEvent(state, event);
      const safe = sanitizeEvent ? sanitizeEvent(event) : null;
      if (safe?.type === "thread_started" && safe.thread_id) hooks.onThread?.(safe.thread_id);
      if (safe) hooks.onEvent?.(safe);
      maybeFinalize();
    };

    // A complete turn is `turn.completed` plus the final `agent_message`. Once
    // both exist the run is finalizing, not finished: the process still has a
    // bounded grace to exit on its own before the tree is cleaned up.
    const maybeFinalize = () => {
      if (finalizing || settled || closing || stopReason) return;
      if (!state.terminalSeen || state.response === null) return;
      finalizing = true;
      hooks.onFinalizing?.({ graceMs: finalizeGraceMs });
      graceTimer = timers.setTimeout(() => {
        cleanupForced = true;
        hooks.onCleanup?.({ forced: true });
        hooks.onEvent?.({ type: "cleanup_forced", reason: "exit_grace_expired" });
        beginTermination();
      }, finalizeGraceMs);
    };

    hardTimer = timers.setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      hooks.onActivity?.();
      if (stdoutBytes > outputLimit) {
        stop("output_limit");
        return;
      }
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      for (const event of scanner.push(text)) handleEvent(event);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      hooks.onActivity?.();
      stderrTail = `${stderrTail}${stderrDecoder.write(chunk)}`.slice(-STDERR_TAIL_CHARS);
      if (stderrBytes > outputLimit) stop("output_limit");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      reject(new DispatcherError("cli_start_failed", "The local Codex CLI could not be started.", error.message));
    });
    child.once("close", (code, closeSignal) => {
      closing = true;
      const stdoutRemainder = stdoutDecoder.end();
      if (stdoutRemainder) {
        for (const event of scanner.push(stdoutRemainder)) handleEvent(event);
      }
      for (const event of scanner.flush()) handleEvent(event);
      const stderrRemainder = stderrDecoder.end();
      if (stderrRemainder) stderrTail = `${stderrTail}${stderrRemainder}`.slice(-STDERR_TAIL_CHARS);
      const payload = buildResult(code, closeSignal);
      if (terminationStarted && cleanupPromise !== null) {
        closePayload = payload;
        void cleanupPromise.finally(() => settle(closePayload));
        return;
      }
      settle(payload);
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
  const timers = options.timers ?? defaultTimers;
  const hooks = options.hooks ?? {};
  const startedAt = Date.now();
  const runId = typeof options.runId === "string" && options.runId ? options.runId : randomUUID();
  const task = requirePrompt(prompt);
  const throwIfCancelled = () => {
    if (!options.signal?.aborted) return;
    throw new DispatcherError("cancelled", "The DeepSeek run was cancelled.", {
      run_id: runId,
      elapsed_ms: Date.now() - startedAt
    });
  };
  throwIfCancelled();
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
  let normalizedMode;
  try {
    normalizedMode = normalizeMode(mode);
  } catch (error) {
    throw wrapGrantError(error);
  }
  if (kind !== "coding" && kind !== "vision") {
    throw new DispatcherError("invalid_argument", "kind must be coding or vision.");
  }
  throwIfCancelled();

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
    // A cancelled asynchronous run must not burn a one-time grant before a
    // child can be spawned.
    throwIfCancelled();
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
  throwIfCancelled();

  const extraSecrets = typeof grant_token === "string" && grant_token ? [grant_token] : [];
  // Image authorization depends on mode. A one-time grant authorizes only the
  // workspace, never a parent or sibling, so workspace-write images must come
  // from the already trusted static roots instead of the writable grant
  // workspace; read-only grant behavior is unchanged and stays inside the grant
  // workspace. Workspace-write additionally enforces source-image read-only at
  // the sandbox boundary: every image must be outside the writable workspace
  // and outside every writable temp root, because a prompt alone cannot stop a
  // workspace-write child from overwriting an input image.
  const imageRoots = grantSnapshot
    ? (normalizedMode === "workspace-write" ? roots : [grantSnapshot.workspace])
    : roots;
  const imageContext = grantSnapshot && normalizedMode !== "workspace-write"
    ? "the authorized grant workspace"
    : "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS";
  let validatedImages = [];
  if (kind === "vision") {
    const forbiddenRoots = normalizedMode === "workspace-write"
      ? [workspace.path, ...(await writableTempRoots(environment))]
      : [];
    validatedImages = await validateImages(images, imageRoots, imageContext, forbiddenRoots);
  }
  throwIfCancelled();

  if (typeof options.beforeFinalPathVerification === "function") {
    await options.beforeFinalPathVerification();
  }

  const catalogPath = path.join(pluginRoot, "config", "deepseek-models.json");
  const model = kind === "vision" ? MODELS.vision : MODELS.coding;
  // Immediately before spawning, re-resolve the workspace and require exact
  // equality with the authorization snapshot so a moved or swapped workspace
  // can never be executed against a different location.
  const verifiedWorkspace = await verifyWorkspaceUnchanged(workspace.path);
  if (kind === "vision") {
    const forbiddenRoots = normalizedMode === "workspace-write"
      ? [verifiedWorkspace, ...(await writableTempRoots(environment))]
      : [];
    validatedImages = await revalidateImages(validatedImages, imageRoots, imageContext, forbiddenRoots);
  }
  const args = buildCodexArgs({
    model,
    workspacePath: verifiedWorkspace,
    mode: normalizedMode,
    catalogPath,
    imagePaths: validatedImages.map((image) => image.path)
  });
  // Everything the child prints is untrusted. Secrets, the one-time grant
  // token, the authorized workspace, and every allowlist root are redacted
  // before a value can become a run event, a returned result, or an error
  // detail, so no published value can carry a raw secret or allowlist path.
  const promptForChild = workerPrompt(kind, task, normalizedMode);
  const inheritedValues = Object.values(controlledEnvironment(environment))
    .filter((value) => typeof value === "string" && value.length >= 3);
  const redactionValues = [...extraSecrets, task, promptForChild, verifiedWorkspace, ...roots, ...inheritedValues];
  const sanitizeEvent = (event) => normalizeCodexEvent(event, { environment, secrets: redactionValues });
  // A cancellation that arrived before the child existed must not spawn it.
  throwIfCancelled();
  hooks.onRunning?.({ model, mode: normalizedMode });
  const execution = await executeCodex({
    executable,
    args,
    prompt: promptForChild,
    workspacePath: verifiedWorkspace,
    timeoutMs: timeoutSeconds * 1000,
    outputLimit,
    environment,
    signal: options.signal,
    spawnImpl,
    timers,
    hooks,
    sanitizeEvent,
    finalizeGraceMs: options.finalizeGraceMs ?? DEFAULT_FINALIZE_GRACE_MS,
    cleanupWaitMs: options.cleanupWaitMs ?? DEFAULT_CLEANUP_WAIT_MS,
    processCleanup: options.processCleanup
  });
  hooks.onCleanup?.({ forced: execution.cleanupForced });
  const elapsedMs = Date.now() - startedAt;
  if (execution.stopReason) {
    const messages = {
      timeout: "The DeepSeek run exceeded its configured timeout.",
      cancelled: "The DeepSeek run was cancelled.",
      output_limit: "The DeepSeek run exceeded its configured output limit.",
      cleanup_failed: "The DeepSeek child process did not confirm exit after forced cleanup."
    };
    throw new DispatcherError(execution.stopReason, messages[execution.stopReason], {
      run_id: runId,
      elapsed_ms: elapsedMs,
      cleanup_forced: execution.cleanupForced
    });
  }
  const diagnostics = redact(
    [...execution.failures, execution.stderrTail].filter(Boolean).join("\n"),
    environment,
    redactionValues
  ).slice(-8000);
  if (execution.failures.length > 0) {
    throw new DispatcherError(
      classifyFailure(diagnostics),
      "The DeepSeek provider or local Codex CLI run failed.",
      { run_id: runId, exit_code: execution.code, diagnostics, cleanup_forced: execution.cleanupForced }
    );
  }
  // A terminal turn event is required for success: a clean exit without
  // `turn.completed` is an explicit incomplete run, not a silent success.
  if (!execution.terminalSeen) {
    if (execution.code !== 0) {
      throw new DispatcherError(
        classifyFailure(diagnostics),
        "The DeepSeek provider or local Codex CLI run failed.",
        { run_id: runId, exit_code: execution.code, diagnostics, cleanup_forced: execution.cleanupForced }
      );
    }
    throw new DispatcherError(
      "incomplete_run",
      "The DeepSeek run ended without a terminal turn event.",
      { run_id: runId, exit_code: execution.code, cleanup_forced: execution.cleanupForced }
    );
  }
  const response = execution.response === null
    ? null
    : redact(execution.response, environment, redactionValues);
  if (response === null) {
    throw new DispatcherError(
      "missing_final_response",
      "The DeepSeek run completed its turn without a final agent message.",
      { run_id: runId, cleanup_forced: execution.cleanupForced }
    );
  }
  if (execution.code !== 0 && !execution.cleanupForced) {
    throw new DispatcherError(
      classifyFailure(diagnostics),
      "The DeepSeek provider or local Codex CLI run failed.",
      { run_id: runId, exit_code: execution.code, diagnostics, cleanup_forced: execution.cleanupForced }
    );
  }
  const safeThreadId = execution.threadId === null
    ? null
    : boundedText(redact(execution.threadId, environment, redactionValues), MAX_EVENT_IDENTIFIER_CHARS);
  return {
    run_id: runId,
    status: "completed",
    model,
    mode: normalizedMode,
    elapsed_ms: elapsedMs,
    thread_id: safeThreadId,
    response,
    usage: safeUsage(execution.usage),
    images: validatedImages.map(({ format, bytes }) => ({ format, bytes })),
    cleanup_forced: execution.cleanupForced
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
