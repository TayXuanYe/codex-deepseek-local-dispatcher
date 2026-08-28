import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDeepSeek } from "../scripts/dispatcher.mjs";

const execFileAsync = promisify(execFile);
const expectedWrites = new Set(["DEEPSEEK_DISPATCH_WRITE_OK\n", "DEEPSEEK_DISPATCH_WRITE_OK\r\n"]);
const redPixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64"
);

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required.");

const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-live-"));
const repo = path.join(root, "synthetic-repo");
const fixture = path.join(repo, "fixture.txt");
const image = path.join(repo, "red.png");

try {
  await execFileAsync(process.env.DEEPSEEK_DISPATCHER_GIT_PATH || "git", ["init", repo]);
  await writeFile(fixture, "SYNTHETIC_TEST_DATA_ONLY\n", "utf8");
  await writeFile(image, redPixelPng);
  process.env.DEEPSEEK_DISPATCHER_ALLOWED_ROOTS = root;

  const readOnly = await runDeepSeek({
    kind: "coding",
    prompt: "Do not read files or run commands. Reply exactly DISPATCH_READ_OK.",
    workspace_path: repo,
    mode: "read-only",
    timeout_sec: 300
  });

  const write = await runDeepSeek({
    kind: "coding",
    prompt: "Create result.txt containing exactly DEEPSEEK_DISPATCH_WRITE_OK followed by one newline. Do not modify any other file. Then reply exactly DISPATCH_WRITE_OK.",
    workspace_path: repo,
    mode: "workspace-write",
    timeout_sec: 300
  });
  let written;
  try {
    written = await readFile(path.join(repo, "result.txt"), "utf8");
  } catch (error) {
    console.error(JSON.stringify({ write_response: write.response, write_status: write.status }));
    throw error;
  }
  if (!expectedWrites.has(written)) {
    throw new Error(`The write smoke test produced unexpected file content: ${JSON.stringify(written)}`);
  }

  const vision = await runDeepSeek({
    kind: "vision",
    prompt: "Confirm that an image was attached, then reply exactly DISPATCH_VISION_OK.",
    workspace_path: repo,
    images: [image],
    timeout_sec: 300
  });

  console.log(JSON.stringify({
    read_only: { status: readOnly.status, model: readOnly.model, response: readOnly.response },
    write: { status: write.status, model: write.model, response: write.response, file_verified: true },
    vision: { status: vision.status, model: vision.model, response: vision.response, images: vision.images }
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
