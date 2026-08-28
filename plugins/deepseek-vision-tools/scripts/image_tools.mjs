import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORTED_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);
const DEFAULT_MAX_SOURCE_PIXELS = 100_000_000;
const DEFAULT_MAX_SOURCE_DIMENSION = 32_768;
const DEFAULT_CACHE_MAX_AGE_HOURS = 24;
const MAX_TOOL_OUTPUT_PARTS = 16;
const MAX_INSPECTION_REGIONS = 1024;

export class ImageToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImageToolError";
    this.code = code;
  }
}

function positiveInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const candidate = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new ImageToolError("invalid_argument", `${name} must be a positive integer no greater than ${maximum}.`);
  }
  return candidate;
}

function nonNegativeInteger(value, name, fallback = 0) {
  const candidate = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 0) {
    throw new ImageToolError("invalid_argument", `${name} must be a non-negative integer.`);
  }
  return candidate;
}

function envPositiveInteger(name, fallback) {
  const value = process.env[name];
  return value ? positiveInteger(value, name, fallback) : fallback;
}

export function sharpCandidates() {
  const candidates = [];
  for (const variable of ["CODEX_MCP_NODE_PATH", "CODEX_BROWSER_USE_NODE_PATH"]) {
    const nodePath = process.env[variable];
    if (nodePath) {
      const nodeDirectory = path.dirname(path.resolve(nodePath));
      candidates.push(path.join(nodeDirectory, "node_modules", "sharp"));
      candidates.push(path.join(nodeDirectory, "..", "node_modules", "sharp"));
    }
  }
  const profile = process.env.USERPROFILE;
  if (profile) {
    candidates.push(path.join(profile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "sharp"));
  }
  const electronResources = process.env.CODEX_ELECTRON_RESOURCES_PATH;
  if (electronResources) {
    candidates.push(path.join(electronResources, "cua_node", "bin", "node_modules", "sharp"));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
    if (existsSync(runtimeRoot)) {
      for (const version of readdirSync(runtimeRoot)) {
        candidates.push(path.join(runtimeRoot, version, "bin", "node_modules", "sharp"));
      }
    }
  }
  return candidates;
}

let sharpModule;
export function loadSharp() {
  if (sharpModule) return sharpModule;
  const require = createRequire(import.meta.url);
  try {
    sharpModule = require("sharp");
    return sharpModule;
  } catch {
    for (const candidate of sharpCandidates()) {
      if (!existsSync(candidate)) continue;
      try {
        sharpModule = require(candidate);
        return sharpModule;
      } catch {
        // Continue to the next bundled runtime.
      }
    }
  }
  throw new ImageToolError(
    "runtime_unavailable",
    "The bundled Sharp image runtime could not be loaded. Update or reinstall Codex; no package installation is required."
  );
}

function cacheDirectory() {
  const configured = process.env.DEEPSEEK_VISION_CACHE_DIR;
  return path.resolve(configured || path.join(os.tmpdir(), "codex-deepseek-vision-tools"));
}

function allowedRoots(overrides) {
  const explicit = Array.isArray(overrides.allowedRoots)
    ? overrides.allowedRoots
    : String(process.env.DEEPSEEK_VISION_ALLOWED_ROOTS || "")
      .split(path.delimiter)
      .filter(Boolean);
  const roots = explicit.length > 0 ? explicit : [
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex", "attachments") : null
  ];
  return roots.filter(Boolean).map((root) => path.resolve(String(root)));
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function validateSource(sourcePath, overrides = {}) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new ImageToolError("invalid_path", "path must be a non-empty local filesystem path.");
  }
  const requestedPath = path.resolve(sourcePath);
  let resolvedPath;
  try {
    resolvedPath = await fs.realpath(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ImageToolError("missing_file", "Image file does not exist.");
    throw new ImageToolError("file_access", "Unable to resolve the image file.");
  }
  const permittedRoots = [];
  for (const root of allowedRoots(overrides)) {
    try {
      permittedRoots.push(await fs.realpath(root));
    } catch {
      // Missing configured roots do not expand access.
    }
  }
  if (!permittedRoots.some((root) => isWithinRoot(resolvedPath, root))) {
    throw new ImageToolError(
      "path_not_allowed",
      "Image is outside the allowed roots. Attach it to the task or configure DEEPSEEK_VISION_ALLOWED_ROOTS before starting Codex."
    );
  }
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ImageToolError("missing_file", "Image file does not exist.");
    throw new ImageToolError("file_access", "Unable to access the image file.");
  }
  if (!stat.isFile()) {
    throw new ImageToolError("invalid_path", "Image path is not a regular file.");
  }

  const maxSourcePixels = positiveInteger(
    overrides.maxSourcePixels,
    "max_source_pixels",
    envPositiveInteger("DEEPSEEK_VISION_MAX_SOURCE_PIXELS", DEFAULT_MAX_SOURCE_PIXELS)
  );
  const maxSourceDimension = positiveInteger(
    overrides.maxSourceDimension,
    "max_source_dimension",
    envPositiveInteger("DEEPSEEK_VISION_MAX_SOURCE_DIMENSION", DEFAULT_MAX_SOURCE_DIMENSION)
  );
  const sharp = loadSharp();
  let metadata;
  try {
    metadata = await sharp(resolvedPath, {
      animated: false,
      failOn: "warning",
      limitInputPixels: maxSourcePixels,
      sequentialRead: true
    }).metadata();
  } catch (error) {
    throw new ImageToolError("decode_failed", `Unable to safely decode image: ${error.message}`);
  }
  const format = String(metadata.format || "").toLowerCase();
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new ImageToolError("unsupported_format", "Supported image formats are JPEG, PNG, GIF, and WebP.");
  }
  const width = metadata.width;
  const height = metadata.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ImageToolError("invalid_dimensions", "The decoded image has invalid dimensions.");
  }
  if (width > maxSourceDimension || height > maxSourceDimension || width * height > maxSourcePixels) {
    throw new ImageToolError(
      "source_too_large",
      `Image dimensions ${width}x${height} exceed the configured safety limits.`
    );
  }
  return { resolvedPath, stat, metadata, format, width, height, maxSourcePixels };
}

function tileLayout(width, height, tileWidth, tileHeight, overlap) {
  if (overlap >= tileWidth || overlap >= tileHeight) {
    throw new ImageToolError("invalid_overlap", "overlap must be smaller than both tile dimensions.");
  }
  const strideX = tileWidth - overlap;
  const strideY = tileHeight - overlap;
  const columns = Math.max(1, Math.ceil(Math.max(1, width - overlap) / strideX));
  const rows = Math.max(1, Math.ceil(Math.max(1, height - overlap) / strideY));
  return { tileWidth, tileHeight, overlap, strideX, strideY, columns, rows };
}

function tileBounds(layout, width, height, column, row) {
  if (column >= layout.columns || row >= layout.rows) {
    throw new ImageToolError(
      "invalid_tile",
      `Tile (${column},${row}) is outside the ${layout.columns}x${layout.rows} grid.`
    );
  }
  const x = column * layout.strideX;
  const y = row * layout.strideY;
  return {
    x,
    y,
    width: Math.min(layout.tileWidth, width - x),
    height: Math.min(layout.tileHeight, height - y)
  };
}

function digestFor(source, kind, parameters) {
  return createHash("sha256")
    .update(source.resolvedPath)
    .update(String(source.stat.size))
    .update(String(source.stat.mtimeMs))
    .update(kind)
    .update(JSON.stringify(parameters))
    .digest("hex")
    .slice(0, 32);
}

async function renderArtifact(source, kind, parameters, buildPipeline) {
  const cacheRoot = cacheDirectory();
  await fs.mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, `${kind}-${digestFor(source, kind, parameters)}.png`);
  try {
    await fs.access(target);
    return target;
  } catch {
    // Generate the missing artifact.
  }
  const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp.png`;
  try {
    await buildPipeline().png({ compressionLevel: 6 }).toFile(temporary);
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await fs.rm(temporary, { force: true });
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw new ImageToolError("render_failed", `Unable to create cached image artifact: ${error.message}`);
  }
  return target;
}

export async function cleanupCache(overrides = {}) {
  const root = overrides.cacheRoot ? path.resolve(overrides.cacheRoot) : cacheDirectory();
  const maxAgeHours = positiveInteger(
    overrides.maxAgeHours,
    "max_cache_age_hours",
    envPositiveInteger("DEEPSEEK_VISION_CACHE_MAX_AGE_HOURS", DEFAULT_CACHE_MAX_AGE_HOURS)
  );
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!/^(overview|tile|crop)-[0-9a-f]{32}\.png$/.test(entry.name)) return;
    const candidate = path.join(root, entry.name);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      if (stat.mtimeMs < cutoff) await fs.rm(candidate, { force: true });
    } catch {
      // Cache cleanup is best effort and must not block inspection.
    }
  }));
}

export async function inspectImage(args) {
  const source = await validateSource(args.path, args);
  const thumbnailMaxWidth = positiveInteger(args.thumbnail_max_width, "thumbnail_max_width", 800, 4096);
  const thumbnailMaxHeight = positiveInteger(args.thumbnail_max_height, "thumbnail_max_height", 800, 4096);
  const tileWidth = positiveInteger(args.tile_width, "tile_width", 800, 8192);
  const tileHeight = positiveInteger(args.tile_height, "tile_height", 800, 8192);
  const overlap = nonNegativeInteger(args.overlap, "overlap", 0);
  const layout = tileLayout(source.width, source.height, tileWidth, tileHeight, overlap);
  const regionCount = layout.columns * layout.rows;
  if (!Number.isSafeInteger(regionCount) || regionCount > MAX_INSPECTION_REGIONS) {
    throw new ImageToolError(
      "too_many_regions",
      `Tile settings require ${regionCount} regions; increase tile dimensions or reduce overlap (maximum ${MAX_INSPECTION_REGIONS}).`
    );
  }
  const sharp = loadSharp();
  const thumbnailPath = await renderArtifact(
    source,
    "overview",
    { thumbnailMaxWidth, thumbnailMaxHeight },
    () => sharp(source.resolvedPath, { animated: false, limitInputPixels: source.maxSourcePixels })
      .resize({ width: thumbnailMaxWidth, height: thumbnailMaxHeight, fit: "inside", withoutEnlargement: true })
  );
  const thumbnailMetadata = await sharp(thumbnailPath).metadata();
  const regions = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      regions.push({ column, row, source_bounds: tileBounds(layout, source.width, source.height, column, row) });
    }
  }
  return {
    image: {
      path: source.resolvedPath,
      width: source.width,
      height: source.height,
      format: source.format.toUpperCase()
    },
    overview: {
      path: thumbnailPath,
      width: thumbnailMetadata.width,
      height: thumbnailMetadata.height,
      scale_x: thumbnailMetadata.width / source.width,
      scale_y: thumbnailMetadata.height / source.height
    },
    tile_grid: layout,
    regions,
    guidance: "Use the overview only to choose a region. Request one tile or crop from the original for fine detail."
  };
}

export async function getImageTile(args) {
  const source = await validateSource(args.path, args);
  const tileWidth = positiveInteger(args.tile_width, "tile_width", 800, 8192);
  const tileHeight = positiveInteger(args.tile_height, "tile_height", 800, 8192);
  const overlap = nonNegativeInteger(args.overlap, "overlap", 0);
  const column = nonNegativeInteger(args.column, "column");
  const row = nonNegativeInteger(args.row, "row");
  const layout = tileLayout(source.width, source.height, tileWidth, tileHeight, overlap);
  const bounds = tileBounds(layout, source.width, source.height, column, row);
  const sharp = loadSharp();
  const artifactPath = await renderArtifact(
    source,
    "tile",
    { column, row, tileWidth, tileHeight, overlap, bounds },
    () => sharp(source.resolvedPath, { animated: false, limitInputPixels: source.maxSourcePixels }).extract({
      left: bounds.x,
      top: bounds.y,
      width: bounds.width,
      height: bounds.height
    })
  );
  return {
    image: { path: source.resolvedPath, width: source.width, height: source.height },
    tile: { column, row, source_bounds: bounds, output_path: artifactPath },
    tile_grid: layout
  };
}

export async function cropImage(args) {
  const source = await validateSource(args.path, args);
  const x = nonNegativeInteger(args.x, "x");
  const y = nonNegativeInteger(args.y, "y");
  const requestedWidth = positiveInteger(args.width, "width", undefined);
  const requestedHeight = positiveInteger(args.height, "height", undefined);
  const clamp = args.clamp === undefined ? true : Boolean(args.clamp);
  if (x >= source.width || y >= source.height) {
    throw new ImageToolError("invalid_crop", "Crop origin lies outside the source image.");
  }
  const requestedRight = x + requestedWidth;
  const requestedBottom = y + requestedHeight;
  if (!clamp && (requestedRight > source.width || requestedBottom > source.height)) {
    throw new ImageToolError("invalid_crop", "Crop exceeds the source bounds and clamp is false.");
  }
  const right = Math.min(source.width, requestedRight);
  const bottom = Math.min(source.height, requestedBottom);
  const actualWidth = right - x;
  const actualHeight = bottom - y;
  const partMaxWidth = positiveInteger(args.part_max_width, "part_max_width", 800, 8192);
  const partMaxHeight = positiveInteger(args.part_max_height, "part_max_height", 800, 8192);
  const columns = Math.ceil(actualWidth / partMaxWidth);
  const rows = Math.ceil(actualHeight / partMaxHeight);
  if (columns * rows > MAX_TOOL_OUTPUT_PARTS) {
    throw new ImageToolError(
      "crop_too_large",
      `Crop requires ${columns * rows} detail parts; request a smaller region or use get_image_tile (maximum ${MAX_TOOL_OUTPUT_PARTS}).`
    );
  }
  const sharp = loadSharp();
  const parts = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const bounds = {
        x: x + column * partMaxWidth,
        y: y + row * partMaxHeight,
        width: Math.min(partMaxWidth, actualWidth - column * partMaxWidth),
        height: Math.min(partMaxHeight, actualHeight - row * partMaxHeight)
      };
      const outputPath = await renderArtifact(
        source,
        "crop",
        { requested: { x, y, width: requestedWidth, height: requestedHeight }, bounds, partMaxWidth, partMaxHeight },
        () => sharp(source.resolvedPath, { animated: false, limitInputPixels: source.maxSourcePixels }).extract({
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
      );
      parts.push({ column, row, source_bounds: bounds, output_path: outputPath });
    }
  }
  return {
    image: { path: source.resolvedPath, width: source.width, height: source.height },
    requested_bounds: { x, y, width: requestedWidth, height: requestedHeight },
    actual_bounds: { x, y, width: actualWidth, height: actualHeight },
    clamped: requestedRight !== right || requestedBottom !== bottom,
    parts,
    guidance: parts.length > 1 ? "The crop was subdivided to preserve original detail; inspect only the needed parts." : undefined
  };
}
