# DeepSeek Local Dispatcher

This local STDIO MCP plugin invokes fixed DeepSeek models through `codex exec`:

- `run_deepseek_task` → `deepseek-v4-flash`
- `run_deepseek_vision` → `deepseek-v4-flash-vision-exp`
- `deepseek_dispatcher_status` → configuration health without secret values
- `deepseek_grant_instructions` → read-only two-step flow for one-time path grants

It is a compatibility bridge for environments where ChatGPT-account subagent execution rejects external models. It is not a native subagent thread and does not provide native follow-up or thread UI.

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
unconsumed. Images must always stay inside the static roots (inside-root case)
or inside the authorized grant workspace (grant case); a grant never authorizes
a parent or sibling path.

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

- The provider and both model IDs are fixed.
- The tool never accepts an executable, provider, model, or raw CLI argument.
- The grant store never persists the plaintext token, only its SHA-256 digest.
- The helper stdout contains the plaintext token once; it may be retained in
  Codex host or session audit logs, so it is a short-lived secret. The
  dispatcher and child never return or log it.
- `deepseek_grant_instructions` is read-only and never grants access itself.
- Coding runs default to `read-only`; `workspace-write` must be explicit.
- Vision runs are always read-only.
- Only one DeepSeek run is active at a time.
- Timeouts are capped at 30 minutes and captured output is bounded.
- The child uses `--ignore-user-config` so it does not recursively load this dispatcher.
- The child fixes `approval_policy="never"`; work requiring additional approval is denied and returned to Sol rather than prompting inside a non-interactive run.
- Vision accepts actual JPEG, PNG, GIF, or WebP content, at most five images, 32 MiB per image, and 48 MiB total.

Sol remains responsible for reviewing diffs and running final validation.
