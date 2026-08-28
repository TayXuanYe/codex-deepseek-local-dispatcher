# DeepSeek Vision Tools

Local, read-only MCP tools for progressive inspection of large screenshots with
`deepseek-v4-flash-vision-exp`.

## Workflow

1. Call `inspect_image` to get original metadata, an overview capped at 800x800,
   and deterministic tile coordinates.
2. Select one relevant region from the overview.
3. Call `get_image_tile` or `crop_image` for original-resolution detail.
4. Do not request every tile unless the task genuinely requires it.

Generated PNG artifacts are cached under the operating-system temporary
directory, not in the repository. Files older than 24 hours are removed on
server startup; cleanup only targets plugin-generated artifact names. The
source image is never modified.

## Safety defaults

- Formats: JPEG, PNG, GIF, WebP (detected from decoded content).
- Maximum decoded pixels: 100,000,000.
- Maximum source dimension: 32,768 pixels per side.
- Overview and default detail parts: 800x800 maximum.
- Arbitrary crops are subdivided into at most 16 parts instead of downscaled.
- Inspection grids are limited to 1,024 metadata regions.
- One encoded output is limited to 20 MiB and all images from one tool call to
  30 MiB, leaving room for base64 encoding under the API request limit.
- Edge crops clamp by default; set `clamp=false` to reject them.
- Paths are resolved through real paths and limited to allowed roots. The
  default root is `%USERPROFILE%\.codex\attachments`.

The limits can be tightened with `DEEPSEEK_VISION_MAX_SOURCE_PIXELS`,
`DEEPSEEK_VISION_MAX_SOURCE_DIMENSION`, and
`DEEPSEEK_VISION_CACHE_MAX_AGE_HOURS`,
`DEEPSEEK_VISION_MAX_IMAGE_OUTPUT_BYTES`, and
`DEEPSEEK_VISION_MAX_TOOL_OUTPUT_BYTES`. `DEEPSEEK_VISION_CACHE_DIR` overrides
the cache location. Configure `DEEPSEEK_VISION_ALLOWED_ROOTS` externally before
starting Codex to allow repository image directories; separate multiple roots
with the operating system path separator (`;` on Windows).

The launcher uses a bundled Codex Node runtime and bundled Sharp library; it
does not install packages.
