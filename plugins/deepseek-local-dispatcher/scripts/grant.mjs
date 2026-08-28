#!/usr/bin/env node
// One-time path grant helper for the DeepSeek local dispatcher.
//
// Invoked with argv (no shell) after explicit user approval as instructed by
// the read-only deepseek_grant_instructions MCP tool:
//
//   node grant.mjs --workspace-path <absolute-path> --mode <read-only|workspace-write> [--ttl-sec <60..3600>]
//
// Prints the plaintext token exactly once as structured JSON on stdout. The
// stored grant file contains only the SHA-256 digest of the token plus the
// exact canonical workspace, mode, and timestamps; the token itself is never
// written to disk.

import { createGrant } from "./grants.mjs";

function usage() {
  return [
    "Usage: node grant.mjs --workspace-path <absolute-path> --mode <read-only|workspace-write> [--ttl-sec <60..3600>]",
    "",
    "Creates a one-time path grant and prints the plaintext token once as JSON on stdout.",
    "Grant files are stored under $CODEX_HOME/deepseek-dispatcher-grants",
    "(or $USERPROFILE/.codex/deepseek-dispatcher-grants only when CODEX_HOME is unset)."
  ].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--workspace-path") {
      args.workspacePath = value;
    } else if (flag === "--mode") {
      args.mode = value;
    } else if (flag === "--ttl-sec") {
      args.ttlSec = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.workspacePath || !args.mode) {
    throw new Error("--workspace-path and --mode are required.");
  }
  const result = await createGrant({
    workspacePath: args.workspacePath,
    mode: args.mode,
    ttlSec: args.ttlSec,
    environment: process.env
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    error: { code: error?.code ?? "invalid_request", message: error?.message ?? String(error) }
  })}\n`);
  process.exitCode = 1;
});
