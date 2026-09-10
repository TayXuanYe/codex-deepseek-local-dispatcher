import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runDeepSeek } from "../scripts/dispatcher.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedCodingWrites = new Set(["DEEPSEEK_DISPATCH_WRITE_OK\n", "DEEPSEEK_DISPATCH_WRITE_OK\r\n"]);
const expectedVisionWrites = new Set(["DEEPSEEK_VISION_WRITE_OK\n", "DEEPSEEK_VISION_WRITE_OK\r\n"]);
const redPixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64"
);

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required.");

const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-dispatcher-live-"));
const repo = path.join(root, "synthetic-repo");
const fixture = path.join(repo, "fixture.txt");
// The source image must be outside the writable workspace (the synthetic repo)
// and outside every writable temp root, so it lives in a unique directory under
// the plugin repository that is added to the allowed roots and removed exactly
// in finally.
const imageRoot = await mkdtemp(path.join(pluginRoot, ".deepseek-dispatcher-live-"));
const image = path.join(imageRoot, "red.png");

try {
  await execFileAsync(process.env.DEEPSEEK_DISPATCHER_GIT_PATH || "git", ["init", repo]);
  await writeFile(fixture, "SYNTHETIC_TEST_DATA_ONLY\n", "utf8");
  await writeFile(image, redPixelPng);
  process.env.DEEPSEEK_DISPATCHER_ALLOWED_ROOTS = [root, imageRoot].join(path.delimiter);

  const readOnly = await runDeepSeek({
    kind: "coding",
    prompt: "Do not read files or run commands. Reply exactly DISPATCH_READ_OK.",
    workspace_path: repo,
    mode: "read-only",
    timeout_sec: 300
  });
  if (readOnly.model !== "deepseek-flash") {
    throw new Error(`The coding entry point must use the unified deepseek-flash model, got ${readOnly.model}`);
  }

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
  if (!expectedCodingWrites.has(written)) {
    throw new Error(`The write smoke test produced unexpected file content: ${JSON.stringify(written)}`);
  }
  if (write.model !== "deepseek-flash") {
    throw new Error(`The coding entry point must use the unified deepseek-flash model, got ${write.model}`);
  }

  const imageBefore = await readFile(image);
  const visionWrite = await runDeepSeek({
    kind: "vision",
    prompt: "Confirm that an image was attached. Create vision-result.txt containing exactly DEEPSEEK_VISION_WRITE_OK followed by one newline. Do not modify any other file. Then reply exactly DISPATCH_VISION_WRITE_OK.",
    workspace_path: repo,
    images: [image],
    mode: "workspace-write",
    timeout_sec: 300
  });
  let visionWritten;
  try {
    visionWritten = await readFile(path.join(repo, "vision-result.txt"), "utf8");
  } catch (error) {
    console.error(JSON.stringify({ vision_write_response: visionWrite.response, vision_write_status: visionWrite.status }));
    throw error;
  }
  if (!expectedVisionWrites.has(visionWritten)) {
    throw new Error(`The vision write smoke test produced unexpected file content: ${JSON.stringify(visionWritten)}`);
  }
  if (visionWrite.model !== "deepseek-flash") {
    throw new Error(`The vision entry point must use the unified deepseek-flash model, got ${visionWrite.model}`);
  }
  const imageAfter = await readFile(image);
  if (!imageBefore.equals(imageAfter)) {
    throw new Error("The source image changed after a workspace-write Vision run; source images must stay read-only.");
  }

  console.log(JSON.stringify({
    read_only: { status: readOnly.status, model: readOnly.model, response: readOnly.response },
    write: { status: write.status, model: write.model, response: write.response, file_verified: true },
    vision_write: { status: visionWrite.status, model: visionWrite.model, mode: visionWrite.mode, response: visionWrite.response, images: visionWrite.images, file_verified: true, source_image_unchanged: true }
  }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(imageRoot, { recursive: true, force: true });
}
