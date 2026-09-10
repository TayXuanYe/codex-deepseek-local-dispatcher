# Codex DeepSeek Routing

This repository contains the additive Codex configuration for:

```text
GPT-5.6 Sol
├── GPT-5.6 Luna                 discovery
├── DeepSeek Flash              unified multimodal implementation and visual work
└── GPT-5.6 Terra               difficult/high-risk escalation
```

OpenAI remains the default provider. The DeepSeek provider is selected only by
the explicit local dispatcher or by direct CLI-only custom agents. ChatGPT-account
sessions must use the dispatcher because the platform rejects external models in
native `spawn_agent` runs.

DeepSeek Flash is a single officially released, unified multimodal model
(`deepseek-flash`) that accepts text and image input. The coding and vision
entry points stay separate semantic roles — `deepseek`/`run_deepseek_task` and
`vision`/`run_deepseek_vision` — but both invoke that same model ID.

## Credential

Set the credential outside Codex configuration:

```text
DEEPSEEK_API_KEY=<set externally>
```

No key is stored in this repository, agent prompts, plugin configuration, or
`config.toml`.

## Components

- `config/deepseek-models.json`: agent-specific model metadata for the single
  unified `deepseek-flash` model.
- `config/agents/`: custom routing roles installed into `~/.codex/agents`.
- `plugins/deepseek-local-dispatcher/`: bounded STDIO MCP bridge that invokes
  local `codex exec` with the fixed unified DeepSeek Flash model. It defaults to
  read-only, requires explicit allowed roots, permits one run at a time, and does
  not expose arbitrary CLI arguments.
- `config/agents/vision.toml`: explicitly exposes only the local
  `inspect_image`, `get_image_tile`, and `crop_image` MCP tools to the Vision
  worker instead of relying on parent-task tool inheritance. The direct CLI
  Vision worker runs read-only for inspection; source images stay read-only.
- `plugins/deepseek-vision-tools/`: local thumbnail/tile/crop MCP plugin.
- `scripts/install-deepseek-routing.ps1`: additive, re-runnable provider/agent
  installer with staged writes, rollback, and timestamped backups under
  `~/.codex/backup-deepseek-routing`. It renders the current absolute model
  catalog path into the installed worker definitions and migrates legacy V4
  model labels in the user-level routing prompt to the unified DeepSeek Flash
  coding and vision roles.

After installing or updating the agent files, start a new Codex task (or
restart Codex) so the task's custom-agent registry is rebuilt from
`~/.codex/agents/`.

The dispatcher exposes:

```text
deepseek_dispatcher_status
run_deepseek_task
run_deepseek_vision
```

Sol should use these tools in ChatGPT-account sessions rather than spawning the
`deepseek` or `vision` custom agents. The direct `vision` agent remains
read-only; approved visual implementation uses `run_deepseek_vision` with an
explicit `workspace-write` mode. The returned result is not a native child
thread; Sol still owns diff review and final validation.

## Failure and rollback

Missing credentials, provider errors, rate limits, unsupported tools, context
limits, and image rejection must be returned to Sol. They are not reasoning
failures and do not automatically route to Terra.

To roll back, restore `config.toml` from the timestamped backup, restore any
backed-up agent files, and remove newly added `deepseek.toml`, `vision.toml`,
`luna.toml`, and `terra.toml`. Removing the DeepSeek
provider and agents does not affect the default OpenAI model or
authentication.

Generated thumbnails and crops live under the operating-system temporary
directory and are never committed.

The Vision tools accept task attachments by default. To inspect repository
images, set `DEEPSEEK_VISION_ALLOWED_ROOTS` externally to the allowed root (or
multiple roots separated by the operating system path separator) before
starting Codex.

`DEEPSEEK_DISPATCHER_ALLOWED_ROOTS` is also required. The installer adds this
repository and `~/.codex/attachments` without replacing any existing roots.
Restart Codex after installation so its MCP process receives the updated user
environment.

For `run_deepseek_vision` workspace-write runs, source images are
sandbox-enforced read-only: every image must be outside the writable workspace
and outside the writable temporary roots. When the workspace uses a one-time
grant, workspace-write images must come from the static
`DEEPSEEK_DISPATCHER_ALLOWED_ROOTS` (never the grant workspace). Read-only
inspection behavior is unchanged.
