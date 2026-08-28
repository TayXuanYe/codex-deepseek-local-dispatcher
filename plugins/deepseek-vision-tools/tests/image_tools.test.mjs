import assert from "node:assert/strict";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupCache, cropImage, getImageTile, inspectImage, loadSharp, sharpCandidates } from "../scripts/image_tools.mjs";

async function withFixture(width, height, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-vision-test-"));
  const file = path.join(directory, "fixture.png");
  const sharp = loadSharp();
  await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } } })
    .png()
    .toFile(file);
  try {
    await callback(file, sharp, { allowedRoots: [directory] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("inspect_image preserves aspect ratio, does not upscale, and maps tiles", async () => {
  await withFixture(1600, 900, async (file, _sharp, access) => {
    const result = await inspectImage({ path: file, ...access });
    assert.deepEqual([result.overview.width, result.overview.height], [800, 450]);
    assert.deepEqual([result.tile_grid.columns, result.tile_grid.rows], [2, 2]);
    assert.deepEqual(result.regions.at(-1).source_bounds, { x: 800, y: 800, width: 800, height: 100 });
  });
  await withFixture(320, 200, async (file, _sharp, access) => {
    const result = await inspectImage({ path: file, ...access });
    assert.deepEqual([result.overview.width, result.overview.height], [320, 200]);
  });
});

test("inspect_image rejects tile grids that would create excessive metadata", async () => {
  await withFixture(100, 100, async (file, _sharp, access) => {
    await assert.rejects(
      () => inspectImage({ path: file, tile_width: 1, tile_height: 1, ...access }),
      /maximum 1024/
    );
  });
});

test("get_image_tile crops partial edge tiles from the original", async () => {
  await withFixture(1600, 900, async (file, sharp, access) => {
    const result = await getImageTile({ path: file, column: 1, row: 1, ...access });
    assert.deepEqual(result.tile.source_bounds, { x: 800, y: 800, width: 800, height: 100 });
    const metadata = await sharp(result.tile.output_path).metadata();
    assert.deepEqual([metadata.width, metadata.height], [800, 100]);
    await assert.rejects(() => getImageTile({ path: file, column: 2, row: 0, ...access }), /outside/);
  });
});

test("crop_image clamps edges and subdivides large regions without resizing", async () => {
  await withFixture(1600, 900, async (file, sharp, access) => {
    const clamped = await cropImage({ path: file, x: 1500, y: 850, width: 400, height: 400, ...access });
    assert.equal(clamped.clamped, true);
    assert.deepEqual(clamped.actual_bounds, { x: 1500, y: 850, width: 100, height: 50 });

    const subdivided = await cropImage({ path: file, x: 0, y: 0, width: 1600, height: 900, ...access });
    assert.equal(subdivided.parts.length, 4);
    const dimensions = [];
    for (const part of subdivided.parts) {
      const metadata = await sharp(part.output_path).metadata();
      dimensions.push([metadata.width, metadata.height]);
    }
    assert.deepEqual(dimensions, [[800, 800], [800, 800], [800, 100], [800, 100]]);
    await assert.rejects(
      () => cropImage({ path: file, x: 1500, y: 850, width: 400, height: 400, clamp: false, ...access }),
      /exceeds/
    );
  });
});

test("file validation rejects missing, corrupt, and over-limit images", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-vision-test-"));
  const corrupt = path.join(directory, "corrupt.png");
  await writeFile(corrupt, "not an image");
  try {
    const access = { allowedRoots: [directory] };
    await assert.rejects(() => inspectImage({ path: path.join(directory, "missing.png"), ...access }), /does not exist/);
    await assert.rejects(() => inspectImage({ path: corrupt, ...access }), /decode/);
    await withFixture(100, 100, async (file, _sharp, fixtureAccess) => {
      await assert.rejects(() => inspectImage({ path: file, maxSourcePixels: 5000, ...fixtureAccess }), /decode|safety limits/);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path policy rejects files outside configured roots without disclosing the path", async () => {
  await withFixture(32, 32, async (file) => {
    let error;
    try {
      await inspectImage({ path: file, allowedRoots: [path.dirname(file) + "-other"] });
      assert.fail("Expected the path policy to reject the image.");
    } catch (caught) {
      error = caught;
    }
    assert.equal(error.code, "path_not_allowed");
    assert.equal(error.message.includes(file), false);
  });
});

test("Sharp discovery derives a module path from the selected MCP Node runtime", () => {
  const previous = process.env.CODEX_MCP_NODE_PATH;
  process.env.CODEX_MCP_NODE_PATH = path.join("C:\\", "runtime", "bin", "node.exe");
  try {
    assert.equal(sharpCandidates()[0], path.join("C:\\", "runtime", "bin", "node_modules", "sharp"));
  } finally {
    if (previous === undefined) delete process.env.CODEX_MCP_NODE_PATH;
    else process.env.CODEX_MCP_NODE_PATH = previous;
  }
});

test("cache cleanup removes only stale plugin artifacts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepseek-vision-cache-test-"));
  const artifact = path.join(directory, `overview-${"a".repeat(32)}.png`);
  const unrelated = path.join(directory, "unrelated.png");
  await writeFile(artifact, "plugin");
  await writeFile(unrelated, "user");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(artifact, old, old);
  await utimes(unrelated, old, old);
  try {
    await cleanupCache({ cacheRoot: directory, maxAgeHours: 1 });
    await assert.rejects(() => access(artifact));
    await access(unrelated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
