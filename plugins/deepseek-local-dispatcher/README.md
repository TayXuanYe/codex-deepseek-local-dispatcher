# DeepSeek Local Dispatcher

This local STDIO MCP plugin invokes the fixed unified DeepSeek Flash model
(`deepseek-flash`, a single officially released multimodal generator that
accepts text and image input) through `codex exec`:

- `run_deepseek_task` → `deepseek-flash` (coding entry point)
- `run_deepseek_vision` → `deepseek-flash` (vision entry point)
- `start_deepseek_task` / `start_deepseek_vision` → start a run and return its
  `run_id` without waiting for completion
- `get_deepseek_run` / `wait_deepseek_run` → inspect a safe run snapshot or
  wait for its revision to change
- `cancel_deepseek_run` → idempotently cancel and clean up a run
- `deepseek_dispatcher_status` → configuration health without secret values
- `deepseek_grant_instructions` → read-only two-step flow for one-time path grants

Both entry points use the same model ID. The coding/vision split is a semantic
role split only: `run_deepseek_vision` controls image validation, `--image`
arguments, source-image protection, read-only defaults, workspace-write
boundaries, and visual prompt specialization.

It is a compatibility bridge for environments where ChatGPT-account subagent execution rejects external models. It is not a native subagent thread and does not provide native follow-up or thread UI.

## Asynchronous run lifecycle

Use the blocking `run_deepseek_task` and `run_deepseek_vision` tools for short
calls where intermediate visibility is unnecessary. For longer work, use:

1. `start_deepseek_task` or `start_deepseek_vision` to obtain a `run_id`.
2. `get_deepseek_run` for an immediate snapshot, or `wait_deepseek_run` with
   `after_revision` to wait up to 60 seconds for a change without polling.
3. `cancel_deepseek_run` when the run should stop.

Run state is separate from health. State progresses through `starting`,
`running`, and `finalizing` before one terminal state: `completed`, `failed`,
`cancelled`, or `timed_out`. Health becomes `quiet` after 60 seconds without
activity and `suspected_stalled` after 300 seconds, but inactivity never ends or
kills a run. The existing hard timeout remains authoritative.

A complete child turn requires both a final agent message and
`turn.completed`. The child then receives a 10-second normal-exit grace. If it
does not exit, the dispatcher cleans the process tree and reports
`cleanup_forced: true` only after exit is confirmed. An unconfirmed cleanup is
a `cleanup_failed` terminal error and blocks new runs in that dispatcher
process instead of claiming success.

Run history is memory-only: at most 200 normalized events per run and 20
completed runs retained for at most one hour. Concurrent long-poll waiters are
bounded. Published events are normalized and redacted before storage; raw
JSONL, raw command output, environment data, grant tokens, allowlist paths, and
input prompts are not stored in run history. Restarting the MCP process clears
history.

### Event window

Every retained event carries a monotonic, stable `seq`. `get_deepseek_run` and
`wait_deepseek_run` return only a bounded window of retained events, ascending
by `seq`; both project the window identically:

- The default window is the latest 10 events.
- `event_from` (inclusive) plus `event_limit` (1..50, default 10) pages a
  retained range. Without `event_from`, the latest `event_limit` events are
  returned.
- Each snapshot includes `event_window`: `limit` and `requested_from`; the
  retained range as `retained_from`/`retained_to`/`retained_count`; the
  returned range as `returned_from`/`returned_to`/`returned_count`; the
  `next_from` cursor plus `has_more_after` for forward paging; and
  `truncated_before`/`dropped_events`, which are set when the oldest events were
  evicted and are no longer available.

`revision` remains the only wakeup signal for `wait_deepseek_run` and is never
conflated with the event `seq`. Terminal `result` and `error` are returned in
full and are never windowed.

## Required environment

```text
DEEPSEEK_API_KEY=<set externally>
DEEPSEEK_DISPATCHER_ALLOWED_ROOTS=C:\path\to\project;C:\path\to\attachments
```

`DEEPSEEK_DISPATCHER_ALLOWED_ROOTS` is mandatory. Every workspace and image path is resolved through the filesystem and must remain inside one of these roots. Keep the roots narrow.

`CODEX_CLI_PATH` is an optional explicit override. When it is absent, the dispatcher discovers `codex.exe` from the normal Codex Desktop installation under `LOCALAPPDATA` and then from `PATH`; on Windows, a PATH result is accepted only when its canonical path remains inside that trusted Codex installation root. Every result is canonicalized and verified as a regular file before use. The API key is never returned by the status tool or written to configuration. Child `codex exec` runs exclude secret-named variables from model-generated shell commands.

## One-time path grants

Every workspace and image path must normally stay inside
`DEEPSEEK_DISPATCHER_ALLOWED_ROOTS`. When a workspace is genuinely outside the
static roots, the dispatcher requires a **one-time path grant**. The grant flow
is intentionally two-step so a human explicitly approves every grant:

1. **Instructions (read-only, never grants).** Call `deepseek_grant_instructions`
   with `workspace_path`, `mode`, and `ttl_sec`. It validates that the path is a
   local absolute existing directory (rejecting drive roots and Windows
   UNC/network paths), reports whether a grant is required, and returns a
   structured `executable`/`argv`/`cwd` payload — never a shell command string —
   for the separate helper. This tool does not create, claim, or touch any
   grant. MCP `readOnlyHint` annotations do not enforce approval; the separate
   user-approved exec is the approval.
2. **Helper (the approval).** After explicit user approval, execute the returned
   helper exactly once with argv (no shell), e.g.:

   ```text
   node .../plugins/deepseek-local-dispatcher/scripts/grant.mjs --workspace-path <path> --mode <read-only|workspace-write> [--ttl-sec <60..3600>]
   ```

   Human approval is the external Codex exec approval policy. This plugin does
   not cryptographically or OS-prove approval, and MCP `readOnlyHint`
   annotations never enforce it, so never rely on them. Do not request or reuse
   a persistent approval prefix or rule for the grant helper. The helper prints
   the plaintext token exactly once as structured JSON under the field
   `grant_token`; that stdout may be retained in Codex host or session audit
   logs, so treat the token as a short-lived secret. The stored grant file
   contains only the SHA-256 digest of the token plus the exact canonical
   workspace, mode, and issued/expiry timestamps. The token is never written to
   disk, never passed to the child `codex exec` environment, argv, or prompt,
   and never returned or logged by the dispatcher.
3. **Use.** Pass the token as `grant_token` to `run_deepseek_task` or
   `run_deepseek_vision`. The claim is atomic (a rename), so concurrent or
   replayed calls cannot both succeed; a second use reports `grant_consumed`.

Grant timeout semantics: `ttl_sec` (default 600, bounded 60..3600) gates only
the atomic claim at run start. Once claimed, an in-memory authorization
snapshot is used for the entire run, and the run may continue for its full
`timeout_sec` (capped at 1800) even if the grant expires mid-run. A grant binds
the exact canonical workspace path and exact mode: requesting a parent, sibling,
or differently-cased path, or a different mode, reports `grant_mismatch` and
burns the grant. For Vision runs the grant is claimed before image validation,
which is required by the path boundary: images are read only after the grant
owns the workspace, so reading an external image before owning the grant would
violate that boundary, and invalid images therefore consume the grant and
require a new human-approved grant. For a workspace already inside the static
roots no grant is needed, and an extra `grant_token` is ignored and left
unconsumed. Read-only Vision images must stay inside the static roots
(inside-root case) or inside the authorized grant workspace (grant case); a
grant never authorizes a parent or sibling path. Workspace-write Vision images
must always come from the static allowed roots — never the grant workspace —
and must also be outside the writable workspace and the writable temporary
roots (canonical `TEMP`, `TMP`, and Node's `os.tmpdir()`), so a workspace-write
child can never overwrite a source image.

Grant files live under `$CODEX_HOME/deepseek-dispatcher-grants`, or
`$USERPROFILE/.codex/deepseek-dispatcher-grants` only when `CODEX_HOME` is
unset. The store path is resolved through a validated trust boundary: the
trusted base must be an absolute local, non-drive-root, non-UNC directory that
is not a symlink/junction/reparse point, and the grant directory is created or
checked without following a symlink/junction and must remain inside the
canonical trusted base. Claims never create a missing store; they report the
token as invalid instead. Expired grant files are cleaned opportunistically
without following symlinks.

## Safety boundaries

- The provider and the single `deepseek-flash` model ID are fixed.
- The tool never accepts an executable, provider, model, or raw CLI argument.
- The grant store never persists the plaintext token, only its SHA-256 digest.
- The helper stdout contains the plaintext token once; it may be retained in
  Codex host or session audit logs, so it is a short-lived secret. The
  dispatcher and child never return or log it.
- `deepseek_grant_instructions` is read-only and never grants access itself.
- Coding runs default to `read-only`; `workspace-write` must be explicit.
- Vision runs default to `read-only`; `workspace-write` is permitted only for an
  approved visually relevant implementation. Source images are
  sandbox-enforced read-only: workspace-write runs reject any image inside the
  writable workspace or the writable temporary roots, and with a one-time grant
  they must come from the static allowed roots rather than the grant workspace.
- Only one DeepSeek run is active at a time.
- Run-management calls remain available while that run is active.
- Timeouts are capped at 30 minutes and captured output is bounded.
- The child uses `--ignore-user-config` so it does not recursively load this dispatcher.
- The child fixes `approval_policy="never"`; work requiring additional approval is denied and returned to Sol rather than prompting inside a non-interactive run.
- Vision accepts actual JPEG, PNG, GIF, or WebP content, at most five images, 32 MiB per image, and 48 MiB total.

Sol remains responsible for reviewing diffs and running final validation.
