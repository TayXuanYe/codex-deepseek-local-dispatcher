import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import {
  ImageToolError,
  cleanupCache,
  cropImage,
  getImageTile,
  inspectImage,
  loadSharp
} from "./image_tools.mjs";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAX_IMAGE_OUTPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 30 * 1024 * 1024;

const TOOL_DEFINITIONS = [
  {
    name: "inspect_image",
    description: "Read image metadata, create a bounded overview without upscaling, and return deterministic original-resolution tile coordinates. Use this first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Local image path." },
        thumbnail_max_width: { type: "integer", minimum: 1, maximum: 4096, default: 800 },
        thumbnail_max_height: { type: "integer", minimum: 1, maximum: 4096, default: 800 },
        tile_width: { type: "integer", minimum: 1, maximum: 8192, default: 800 },
        tile_height: { type: "integer", minimum: 1, maximum: 8192, default: 800 },
        overlap: { type: "integer", minimum: 0, default: 0 }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "get_image_tile",
    description: "Crop one deterministic high-resolution tile directly from the original image after inspect_image identifies a relevant region.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "column", "row"],
      properties: {
        path: { type: "string" },
        column: { type: "integer", minimum: 0 },
        row: { type: "integer", minimum: 0 },
        tile_width: { type: "integer", minimum: 1, maximum: 8192, default: 800 },
        tile_height: { type: "integer", minimum: 1, maximum: 8192, default: 800 },
        overlap: { type: "integer", minimum: 0, default: 0 }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "crop_image",
    description: "Crop an arbitrary region directly from the original image. Large regions are subdivided instead of downscaled so small details remain readable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "x", "y", "width", "height"],
      properties: {
        path: { type: "string" },
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        clamp: { type: "boolean", default: true },
        part_max_width: { type: "integer", minimum: 1, maximum: 8192, default: 800 },
        part_max_height: { type: "integer", minimum: 1, maximum: 8192, default: 800 }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function boundedOutputLimit(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ImageToolError("invalid_configuration", `${name} must be a positive integer.`);
  }
  return Math.min(parsed, fallback);
}

function publicMetadata(value) {
  if (Array.isArray(value)) return value.map(publicMetadata);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "path" || key === "output_path") continue;
    result[key] = publicMetadata(nested);
  }
  return result;
}

async function imageContent(filePath, maximumBytes) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maximumBytes) {
    throw new ImageToolError(
      "output_too_large",
      "Rendered image is too large for a safe Vision request. Request a smaller tile or crop."
    );
  }
  return { type: "image", data: (await fs.readFile(filePath)).toString("base64"), mimeType: "image/png" };
}

async function toolResult(name, args) {
  let metadata;
  let outputPaths;
  if (name === "inspect_image") {
    metadata = await inspectImage(args);
    outputPaths = [metadata.overview.path];
  } else if (name === "get_image_tile") {
    metadata = await getImageTile(args);
    outputPaths = [metadata.tile.output_path];
  } else if (name === "crop_image") {
    metadata = await cropImage(args);
    outputPaths = metadata.parts.map((part) => part.output_path);
  } else {
    throw new ImageToolError("unknown_tool", `Unknown tool: ${name}`);
  }
  const maximumImageBytes = boundedOutputLimit("DEEPSEEK_VISION_MAX_IMAGE_OUTPUT_BYTES", DEFAULT_MAX_IMAGE_OUTPUT_BYTES);
  const maximumToolBytes = boundedOutputLimit("DEEPSEEK_VISION_MAX_TOOL_OUTPUT_BYTES", DEFAULT_MAX_TOOL_OUTPUT_BYTES);
  const sizes = await Promise.all(outputPaths.map(async (outputPath) => (await fs.stat(outputPath)).size));
  if (sizes.some((size) => size > maximumImageBytes) || sizes.reduce((sum, size) => sum + size, 0) > maximumToolBytes) {
    throw new ImageToolError(
      "output_too_large",
      "Rendered output is too large for a safe Vision request. Request a smaller tile or crop."
    );
  }
  const safeMetadata = publicMetadata(metadata);
  const content = [{ type: "text", text: JSON.stringify(safeMetadata, null, 2) }];
  for (const outputPath of outputPaths) content.push(await imageContent(outputPath, maximumImageBytes));
  return { content, structuredContent: safeMetadata, isError: false };
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "deepseek-vision-tools", version: "0.1.0" }
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOL_DEFINITIONS });
    return;
  }
  if (method === "tools/call") {
    try {
      respond(id, await toolResult(params.name, params.arguments || {}));
    } catch (error) {
      const safeMessage = error instanceof ImageToolError ? `${error.code}: ${error.message}` : "internal_error: Image operation failed.";
      respond(id, { content: [{ type: "text", text: safeMessage }], isError: true });
    }
    return;
  }
  respondError(id ?? null, -32601, `Method not found: ${method}`);
}

try {
  loadSharp();
  await cleanupCache();
} catch (error) {
  process.stderr.write(`DeepSeek vision tools startup failed: ${error.message}\n`);
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    continue;
  }
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    respondError(message?.id ?? null, -32600, "Invalid Request");
    continue;
  }
  try {
    await handle(message);
  } catch {
    respondError(message.id ?? null, -32603, "Internal error");
  }
}
