// One-time path grant store for the DeepSeek local dispatcher.
//
// A grant authorizes a single run against an exact canonical workspace path
// and mode when that workspace lies outside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS.
// Only the SHA-256 digest of the plaintext token is ever stored. The helper
// prints the token exactly once; its stdout and the later MCP input may be
// retained by host/session audit logs, so the token is a short-lived secret.
// Claims are atomic (rename), so concurrent or replayed attempts cannot both
// succeed.
//
// The grant store lives under:
//   $CODEX_HOME/deepseek-dispatcher-grants
// or, only when CODEX_HOME is unset:
//   $USERPROFILE/.codex/deepseek-dispatcher-grants
//
// The store path is resolved through a validated trust boundary. The trusted
// base (CODEX_HOME, or USERPROFILE/.codex) must be an absolute local,
// non-drive-root, non-UNC directory that is not a symlink/junction/reparse
// point, and the grant directory is created or checked without following a
// symlink/junction and must remain inside the canonical trusted base. Claims
// never create a missing store; they fail with grant_invalid instead.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const GRANT_SCHEMA_VERSION = 1;
export const DEFAULT_TTL_SEC = 600;
export const MIN_TTL_SEC = 60;
export const MAX_TTL_SEC = 3600;
const GRANT_DIRECTORY_NAME = "deepseek-dispatcher-grants";
// 32 random bytes encoded as base64url produce exactly 43 unpadded characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class GrantError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "GrantError";
    this.code = code;
    this.details = details;
  }
}

export function environmentValue(environment, name) {
  if (environment[name] !== undefined) return environment[name];
  const matchingName = Object.keys(environment).find((key) => key.toUpperCase() === name);
  return matchingName ? environment[matchingName] : undefined;
}

export function isWindowsNetworkPath(candidate) {
  if (process.platform !== "win32" || typeof candidate !== "string") return false;
  const normalized = candidate.replaceAll("/", "\\").toLowerCase();
  return (
    normalized.startsWith("\\\\?\\unc\\") ||
    (normalized.startsWith("\\\\") && !normalized.startsWith("\\\\?\\"))
  );
}

export function isDriveRoot(candidate) {
  if (typeof candidate !== "string") return false;
  return path.parse(candidate).root === candidate;
}

export function isRejectedPath(candidate) {
  return isDriveRoot(candidate) || isWindowsNetworkPath(candidate);
}

function isSamePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithinDirectory(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeMode(mode) {
  if (mode !== "read-only" && mode !== "workspace-write") {
    throw new GrantError("invalid_argument", "mode must be read-only or workspace-write.");
  }
  return mode;
}

export function boundedTtl(raw) {
  let value = DEFAULT_TTL_SEC;
  if (raw !== undefined && raw !== null && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new GrantError("invalid_argument", "ttl_sec must be an integer number of seconds.");
    }
    value = parsed;
  }
  if (value < MIN_TTL_SEC || value > MAX_TTL_SEC) {
    throw new GrantError(
      "invalid_argument",
      `ttl_sec must be between ${MIN_TTL_SEC} and ${MAX_TTL_SEC} seconds.`
    );
  }
  return value;
}

function validateTrustedBaseValue(candidate, label) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new GrantError("configuration_error", `${label} is not available for the grant store.`);
  }
  const value = candidate.trim();
  if (!path.isAbsolute(value)) {
    throw new GrantError("configuration_error", `${label} must be an absolute local path for the grant store.`);
  }
  if (isRejectedPath(value)) {
    throw new GrantError(
      "configuration_error",
      `${label} must not be a drive root or a network/UNC path for the grant store.`
    );
  }
  if (process.platform === "win32" && value.startsWith("\\\\?\\")) {
    throw new GrantError(
      "configuration_error",
      `${label} must be a normal absolute local path for the grant store.`
    );
  }
  return value;
}

async function canonicalizeTrustedBase(rawBase) {
  let info;
  try {
    info = await fs.lstat(rawBase);
  } catch (error) {
    throw new GrantError(
      "configuration_error",
      "The grant store base does not exist or cannot be accessed.",
      error.message
    );
  }
  if (info.isSymbolicLink()) {
    throw new GrantError(
      "configuration_error",
      "The grant store base must not be a symbolic link, junction, or reparse point."
    );
  }
  let canonical;
  try {
    canonical = path.resolve(await fs.realpath(rawBase));
  } catch (error) {
    throw new GrantError("configuration_error", "The grant store base could not be resolved.", error.message);
  }
  // realpath resolving to a different location means the base traversed a
  // symlink/junction/reparse point that lstat did not surface; reject it.
  if (!isSamePath(canonical, rawBase)) {
    throw new GrantError(
      "configuration_error",
      "The grant store base must not resolve through a symbolic link, junction, or reparse point."
    );
  }
  if (isRejectedPath(canonical)) {
    throw new GrantError(
      "configuration_error",
      "The grant store base must not be a drive root or a network/UNC path."
    );
  }
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) {
    throw new GrantError("configuration_error", "The grant store base must be an existing directory.");
  }
  return canonical;
}

export async function resolveGrantDirectory(environment = process.env, { create = true } = {}) {
  const codexHome = environmentValue(environment, "CODEX_HOME");
  let rawBase;
  if (typeof codexHome === "string" && codexHome.trim() !== "") {
    rawBase = validateTrustedBaseValue(codexHome, "CODEX_HOME");
  } else {
    const profile = environmentValue(environment, "USERPROFILE");
    if (typeof profile === "string" && profile.trim() !== "") {
      rawBase = validateTrustedBaseValue(path.join(profile.trim(), ".codex"), "USERPROFILE/.codex");
    } else {
      throw new GrantError(
        "configuration_error",
        "Neither CODEX_HOME nor USERPROFILE is available for the grant store."
      );
    }
  }
  const canonicalBase = await canonicalizeTrustedBase(rawBase);
  const grantPath = path.join(canonicalBase, GRANT_DIRECTORY_NAME);
  let info;
  try {
    info = await fs.lstat(grantPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new GrantError("grant_store_error", "The grant store could not be inspected.", error.message);
    }
    info = null;
  }
  if (!info) {
    if (!create) return null;
    try {
      await fs.mkdir(grantPath, { recursive: true });
    } catch (error) {
      throw new GrantError("grant_store_error", "The grant store could not be created.", error.message);
    }
    try {
      info = await fs.lstat(grantPath);
    } catch (error) {
      throw new GrantError("grant_store_error", "The grant store could not be created.", error.message);
    }
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GrantError("grant_store_error", "The grant store must be a real directory, not a symlink or junction.");
  }
  let canonicalGrant;
  try {
    canonicalGrant = path.resolve(await fs.realpath(grantPath));
  } catch (error) {
    throw new GrantError("grant_store_error", "The grant store could not be resolved.", error.message);
  }
  if (!isSamePath(canonicalGrant, grantPath)) {
    throw new GrantError("grant_store_error", "The grant store must not be a symlink or junction.");
  }
  if (!isWithinDirectory(canonicalGrant, canonicalBase)) {
    throw new GrantError("grant_store_error", "The grant store must remain inside the trusted base directory.");
  }
  return canonicalGrant;
}

export async function validateWorkspaceTarget(workspacePath) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new GrantError("invalid_argument", "workspace_path must be a non-empty absolute path.");
  }
  const candidate = workspacePath.trim();
  if (!path.isAbsolute(candidate)) {
    throw new GrantError("invalid_argument", "workspace_path must be an absolute local path.");
  }
  if (isRejectedPath(candidate)) {
    throw new GrantError(
      "invalid_argument",
      "workspace_path must not be a drive root or a network/UNC path."
    );
  }
  let canonical;
  try {
    canonical = path.resolve(await fs.realpath(candidate));
  } catch {
    throw new GrantError("invalid_path", "workspace_path does not exist or cannot be resolved.");
  }
  if (isRejectedPath(canonical)) {
    throw new GrantError(
      "invalid_argument",
      "workspace_path must not be a drive root or a network/UNC path."
    );
  }
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) {
    throw new GrantError("invalid_path", "workspace_path must resolve to an existing directory.");
  }
  return canonical;
}

export async function cleanExpiredGrants(directory, now = Date.now()) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    // Symlinks are never followed: entry.isFile() is already false for
    // symlinks, and lstat guards against TOCTOU swaps.
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    let info;
    try {
      info = await fs.lstat(file);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      const expiresAt = Date.parse(record?.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        await fs.unlink(file);
        removed += 1;
      }
    } catch {
      // Unparseable grant files are left for claim to reject rather than removed.
    }
  }
  return removed;
}

function grantRecord({ workspace, mode, now, ttlSec }) {
  return {
    schemaVersion: GRANT_SCHEMA_VERSION,
    workspace,
    mode,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString()
  };
}

export async function createGrant({
  workspacePath,
  mode,
  ttlSec,
  environment = process.env,
  now = Date.now()
}) {
  const workspace = await validateWorkspaceTarget(workspacePath);
  const normalizedMode = normalizeMode(mode);
  const ttl = boundedTtl(ttlSec);
  const directory = await resolveGrantDirectory(environment);
  await cleanExpiredGrants(directory, now);
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  const record = grantRecord({ workspace, mode: normalizedMode, now, ttlSec: ttl });
  const file = path.join(directory, `${id}.json`);
  const staging = path.join(directory, `${id}.staging-${randomUUID()}.json`);
  await fs.writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  try {
    await fs.rename(staging, file);
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw error;
  }
  return {
    status: "created",
    grant_token: token,
    grant_id: id,
    grant_dir: directory,
    schema_version: GRANT_SCHEMA_VERSION,
    workspace,
    mode: normalizedMode,
    ttl_sec: ttl,
    issued_at: record.issuedAt,
    expires_at: record.expiresAt
  };
}

function validateGrantRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new GrantError("grant_invalid", "The grant record is malformed.");
  }
  if (record.schemaVersion !== GRANT_SCHEMA_VERSION) {
    throw new GrantError("grant_invalid", "The grant record schema version is unsupported.");
  }
  if (
    typeof record.workspace !== "string" ||
    !path.isAbsolute(record.workspace) ||
    isRejectedPath(record.workspace)
  ) {
    throw new GrantError("grant_invalid", "The grant record workspace is invalid.");
  }
  if (record.mode !== "read-only" && record.mode !== "workspace-write") {
    throw new GrantError("grant_invalid", "The grant record mode is invalid.");
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new GrantError("grant_invalid", "The grant record timestamps are invalid.");
  }
  if (expiresAt <= issuedAt) {
    throw new GrantError("grant_invalid", "The grant record expiry precedes its issue time.");
  }
}

async function safeUnlink(file) {
  try {
    await fs.unlink(file);
  } catch {
    // Best-effort removal of a claimed artifact.
  }
}

async function claimedArtifactExists(directory, id) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch {
    return false;
  }
  const prefix = `${id}.claimed-`;
  return entries.some((name) => name.startsWith(prefix));
}

async function grantAvailability(directory, id, grantFile) {
  let grantExists = true;
  try {
    await fs.access(grantFile);
  } catch {
    grantExists = false;
  }
  if (grantExists) return "available";
  return (await claimedArtifactExists(directory, id)) ? "consumed" : "missing";
}

export async function claimGrant({
  token,
  workspacePath,
  mode,
  environment = process.env,
  now = Date.now()
}) {
  if (typeof token !== "string" || !token.trim()) {
    throw new GrantError(
      "grant_required",
      "A one-time path grant token is required for a workspace outside DEEPSEEK_DISPATCHER_ALLOWED_ROOTS."
    );
  }
  const normalizedToken = token.trim();
  if (!TOKEN_PATTERN.test(normalizedToken)) {
    throw new GrantError("grant_invalid", "The grant token is malformed.");
  }
  const normalizedMode = normalizeMode(mode);
  const workspace = await validateWorkspaceTarget(workspacePath);
  if (isRejectedPath(workspace)) {
    throw new GrantError(
      "invalid_argument",
      "workspace_path must not be a drive root or a network/UNC path."
    );
  }
  const directory = await resolveGrantDirectory(environment, { create: false });
  if (!directory) {
    // A missing store means no grant could have been issued or claimed here;
    // never create the store from a claim path.
    throw new GrantError(
      "grant_invalid",
      "The grant token does not match an issued one-time grant."
    );
  }
  const id = hashToken(normalizedToken);
  const grantFile = path.join(directory, `${id}.json`);
  const claimedFile = path.join(directory, `${id}.claimed-${randomUUID()}.json`);
  try {
    await fs.rename(grantFile, claimedFile);
    // Windows can report a successful rename that did not actually move the
    // file when two claims race for the same source; the claimed file must
    // really exist for this claim to own the grant.
    await fs.access(claimedFile);
  } catch (error) {
    await safeUnlink(claimedFile);
    const state = await grantAvailability(directory, id, grantFile);
    if (state === "consumed") {
      throw new GrantError(
        "grant_consumed",
        "The grant was already used."
      );
    }
    if (error?.code === "ENOENT" || state === "missing") {
      throw new GrantError(
        "grant_invalid",
        "The grant token does not match an issued one-time grant."
      );
    }
    throw new GrantError("grant_invalid", "The grant could not be claimed.", error.message);
  }
  let record;
  try {
    record = JSON.parse(await fs.readFile(claimedFile, "utf8"));
  } catch (error) {
    await safeUnlink(claimedFile);
    throw new GrantError("grant_invalid", "The grant record is unreadable or malformed.", error.message);
  }
  try {
    validateGrantRecord(record);
    if (record.workspace !== workspace) {
      throw new GrantError("grant_mismatch", "The grant does not authorize this exact workspace path.");
    }
    if (record.mode !== normalizedMode) {
      throw new GrantError("grant_mismatch", "The grant does not authorize this exact mode.");
    }
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new GrantError("grant_expired", "The grant has expired.");
    }
  } catch (error) {
    // A failed claim never leaves a claimed artifact behind.
    await safeUnlink(claimedFile);
    if (error instanceof GrantError) throw error;
    throw new GrantError("grant_invalid", "The grant record is invalid.", error.message);
  }
  // The renamed claimed file doubles as the consumed marker so replay and
  // concurrent attempts report grant_consumed; expired claimed files are
  // removed opportunistically by cleanExpiredGrants.
  return {
    workspace,
    mode: normalizedMode,
    claimedAt: new Date(now).toISOString(),
    expiresAt: record.expiresAt,
    schemaVersion: record.schemaVersion
  };
}
