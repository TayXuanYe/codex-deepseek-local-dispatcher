param(
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex")
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$sourceAgents = Join-Path $workspaceRoot "config\agents"
$catalogSource = Join-Path $workspaceRoot "config\deepseek-models.json"
$visionPluginSource = Join-Path $workspaceRoot "plugins\deepseek-vision-tools"
$dispatcherPluginSource = Join-Path $workspaceRoot "plugins\deepseek-local-dispatcher"
$configPath = Join-Path $CodexHome "config.toml"
$globalAgentsPath = Join-Path $CodexHome "AGENTS.md"
$agentsPath = Join-Path $CodexHome "agents"
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$backupPath = Join-Path $CodexHome "backup-deepseek-routing\$timestamp"
$stagePath = Join-Path $CodexHome ".deepseek-routing-stage-$timestamp"
$beginMarker = "# BEGIN CODEX DEEPSEEK ROUTING"
$endMarker = "# END CODEX DEEPSEEK ROUTING"
$agentsBeginMarker = "<!-- BEGIN CODEX DEEPSEEK LOCAL DISPATCHER ROUTING -->"
$agentsEndMarker = "<!-- END CODEX DEEPSEEK LOCAL DISPATCHER ROUTING -->"
$agentNames = @("deepseek.toml", "vision.toml", "luna.toml", "terra.toml")
$utf8NoBom = [Text.UTF8Encoding]::new($false)

$codexHomeFull = [IO.Path]::GetFullPath($CodexHome).TrimEnd([IO.Path]::DirectorySeparatorChar)
$stagePath = [IO.Path]::GetFullPath($stagePath)
if (-not $stagePath.StartsWith($codexHomeFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe staging path outside Codex home."
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Codex config does not exist: $configPath"
}
if (-not (Test-Path -LiteralPath $sourceAgents -PathType Container)) {
  throw "Staged agent configuration is missing: $sourceAgents"
}
if (-not (Test-Path -LiteralPath $catalogSource -PathType Leaf)) {
  throw "DeepSeek model catalog is missing: $catalogSource"
}
if (-not (Test-Path -LiteralPath $visionPluginSource -PathType Container)) {
  throw "DeepSeek Vision plugin source is missing: $visionPluginSource"
}
if (-not (Test-Path -LiteralPath $dispatcherPluginSource -PathType Container)) {
  throw "DeepSeek dispatcher plugin source is missing: $dispatcherPluginSource"
}
foreach ($visionPluginFile in @("scripts\launch_image_tools_mcp.cmd", "scripts\server.mjs")) {
  if (-not (Test-Path -LiteralPath (Join-Path $visionPluginSource $visionPluginFile) -PathType Leaf)) {
    throw "DeepSeek Vision plugin file is missing: $visionPluginFile"
  }
}
foreach ($dispatcherPluginFile in @(".codex-plugin\plugin.json", ".mcp.json", "scripts\launch_dispatcher.cmd", "scripts\server.mjs", "scripts\dispatcher.mjs", "config\deepseek-models.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $dispatcherPluginSource $dispatcherPluginFile) -PathType Leaf)) {
    throw "DeepSeek dispatcher plugin file is missing: $dispatcherPluginFile"
  }
}
foreach ($agentName in $agentNames) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceAgents $agentName) -PathType Leaf)) {
    throw "Staged agent configuration is missing: $agentName"
  }
}

$catalogPath = (Resolve-Path -LiteralPath $catalogSource).Path.Replace("\", "/")
$visionPluginPath = (Resolve-Path -LiteralPath $visionPluginSource).Path.Replace("\", "/")
$config = [IO.File]::ReadAllText($configPath)
$globalAgentsExisted = Test-Path -LiteralPath $globalAgentsPath -PathType Leaf
$globalAgents = if ($globalAgentsExisted) { [IO.File]::ReadAllText($globalAgentsPath) } else { "" }
$legacyPromptReplacements = [ordered]@{
  '## DeepSeek V4 Flash — Coding Worker' = '## DeepSeek Flash — Unified Coding Role'
  'Use DeepSeek V4 Flash as the default implementation worker for tasks that do not materially benefit from visual input.' = 'Use the unified multimodal DeepSeek Flash model through the coding role as the default implementation worker for tasks that do not materially benefit from visual input.'
  'use V4 Flash for non-visual work and V4 Flash Vision for visually relevant work.' = 'use the DeepSeek coding role for non-visual work and the DeepSeek vision role for visually relevant work; both roles run the unified deepseek-flash model.'
  '## DeepSeek Vision — Multimodal Coding Worker' = '## DeepSeek Flash — Unified Vision Role'
  'Use DeepSeek V4 Flash Vision as the preferred implementation worker when' = 'Use the unified multimodal DeepSeek Flash model through the Vision role when'
  'to DeepSeek V4 Flash Vision rather than splitting visual inspection and' = 'to the DeepSeek Vision role rather than splitting visual inspection and'
}
foreach ($replacement in $legacyPromptReplacements.GetEnumerator()) {
  $globalAgents = $globalAgents.Replace($replacement.Key, $replacement.Value)
}
$providerBlock = @"
$beginMarker
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
env_key_instructions = "Set DEEPSEEK_API_KEY externally; never store the key in Codex configuration."
$endMarker
"@
$agentsRoutingBody = @'
## Local DeepSeek dispatcher override

When the current session uses a ChatGPT account, do not call spawn_agent for the deepseek or vision custom agents. The platform rejects those external models even though the same provider works through the local CLI.

Both custom agents and both MCP entry points run the single officially released model `deepseek-flash`, a unified multimodal generator that handles text and image input in one model. The `deepseek` / `run_deepseek_task` coding entry point and the `vision` / `run_deepseek_vision` vision entry point stay separate semantic roles: the vision role controls image validation, `--image` arguments, source-image protection, read-only defaults, workspace-write boundaries, and visual prompt specialization.

Use the local MCP tools instead:

* run_deepseek_task for approved, clearly scoped implementation. It defaults to read-only; request workspace-write only when the user has approved implementation.
* run_deepseek_vision for work where supplied images materially help. It defaults to read-only visual inspection; request workspace-write only when the user has approved a visually relevant implementation. Workspace-write images must come from the static allowed roots and stay outside the writable workspace and the writable temporary roots, so source images remain sandbox-enforced read-only.
* deepseek_dispatcher_status for configuration diagnostics without exposing secrets.

In direct CLI-only sessions, `vision` remains read-only. Approved visually relevant implementation must use the mode-gated local dispatcher so its workspace, grant, and source-image boundaries are enforced at runtime.

Sol remains responsible for reviewing the returned result and diff, running validation, and deciding whether the work is accepted. Dispatcher failures are provider or execution failures, not automatic reasons to escalate to Terra.
'@
$agentsRoutingBlock = @(
  $agentsBeginMarker
  $agentsRoutingBody.TrimEnd()
  $agentsEndMarker
) -join [Environment]::NewLine

$hasBegin = $config.Contains($beginMarker)
$hasEnd = $config.Contains($endMarker)
if ($hasBegin -xor $hasEnd) {
  throw "DeepSeek routing markers are incomplete; restore or repair config.toml before installation."
}
if ($hasBegin) {
  $pattern = "(?ms)^$([regex]::Escape($beginMarker))\r?\n.*?^$([regex]::Escape($endMarker))\r?\n?"
  $updatedConfig = ([regex]::new($pattern)).Replace($config, $providerBlock + [Environment]::NewLine, 1)
} else {
  if ($config -match '(?m)^\s*\[model_providers\.deepseek\]\s*$') {
    throw "An unmanaged [model_providers.deepseek] section already exists; review it manually before installation."
  }
  $updatedConfig = $config.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $providerBlock + [Environment]::NewLine
}

$hasAgentsBegin = $globalAgents.Contains($agentsBeginMarker)
$hasAgentsEnd = $globalAgents.Contains($agentsEndMarker)
if ($hasAgentsBegin -xor $hasAgentsEnd) {
  throw "DeepSeek dispatcher routing markers are incomplete in AGENTS.md; restore or repair it before installation."
}
if ($hasAgentsBegin) {
  $agentsPattern = "(?ms)^$([regex]::Escape($agentsBeginMarker))\r?\n.*?^$([regex]::Escape($agentsEndMarker))\r?\n?"
  $updatedGlobalAgents = ([regex]::new($agentsPattern)).Replace($globalAgents, $agentsRoutingBlock + [Environment]::NewLine, 1)
} else {
  $updatedGlobalAgents = $globalAgents.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $agentsRoutingBlock + [Environment]::NewLine
}
foreach ($legacyModelLabel in @('DeepSeek V4 Flash', 'V4 Flash Vision')) {
  if ($updatedGlobalAgents.Contains($legacyModelLabel)) {
    throw "Legacy DeepSeek model label remains in AGENTS.md after prompt migration: $legacyModelLabel"
  }
}
if ($updatedGlobalAgents -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') {
  throw "Unsupported control character remains in AGENTS.md after prompt generation."
}

$allowedRoots = @($workspaceRoot, (Join-Path $CodexHome "attachments"))
$existingAllowedRoots = [Environment]::GetEnvironmentVariable("DEEPSEEK_DISPATCHER_ALLOWED_ROOTS", "User")
if ($existingAllowedRoots) {
  $allowedRoots += $existingAllowedRoots.Split([IO.Path]::PathSeparator, [StringSplitOptions]::RemoveEmptyEntries)
}
$normalizedAllowedRoots = @(
  $allowedRoots |
    ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd([IO.Path]::DirectorySeparatorChar) } |
    Select-Object -Unique
)

New-Item -ItemType Directory -Force -Path $stagePath | Out-Null
try {
  [IO.File]::WriteAllText((Join-Path $stagePath "config.toml"), $updatedConfig, $utf8NoBom)
  [IO.File]::WriteAllText((Join-Path $stagePath "AGENTS.md"), $updatedGlobalAgents, $utf8NoBom)
  foreach ($agentName in $agentNames) {
    $agentContent = [IO.File]::ReadAllText((Join-Path $sourceAgents $agentName))
    $agentContent = $agentContent.Replace("__DEEPSEEK_MODEL_CATALOG__", $catalogPath)
    $agentContent = $agentContent.Replace("__DEEPSEEK_VISION_PLUGIN_ROOT__", $visionPluginPath)
    if ($agentContent.Contains("__DEEPSEEK_MODEL_CATALOG__") -or $agentContent.Contains("__DEEPSEEK_VISION_PLUGIN_ROOT__")) {
      throw "Unresolved installation placeholder in agent configuration: $agentName"
    }
    [IO.File]::WriteAllText((Join-Path $stagePath $agentName), $agentContent, $utf8NoBom)
  }

  New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
  Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupPath "config.toml")
  if ($globalAgentsExisted) {
    Copy-Item -LiteralPath $globalAgentsPath -Destination (Join-Path $backupPath "AGENTS.md")
  }
  $existingAgents = @{}
  foreach ($agentName in $agentNames) {
    $target = Join-Path $agentsPath $agentName
    $existingAgents[$agentName] = Test-Path -LiteralPath $target -PathType Leaf
    if ($existingAgents[$agentName]) {
      Copy-Item -LiteralPath $target -Destination (Join-Path $backupPath $agentName)
    }
  }

  try {
    New-Item -ItemType Directory -Force -Path $agentsPath | Out-Null
    foreach ($agentName in $agentNames) {
      Copy-Item -Force -LiteralPath (Join-Path $stagePath $agentName) -Destination (Join-Path $agentsPath $agentName)
    }
    Copy-Item -Force -LiteralPath (Join-Path $stagePath "config.toml") -Destination $configPath
    Copy-Item -Force -LiteralPath (Join-Path $stagePath "AGENTS.md") -Destination $globalAgentsPath
    [Environment]::SetEnvironmentVariable(
      "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS",
      ($normalizedAllowedRoots -join [IO.Path]::PathSeparator),
      "User"
    )
  } catch {
    Copy-Item -Force -LiteralPath (Join-Path $backupPath "config.toml") -Destination $configPath
    if (Test-Path -LiteralPath (Join-Path $backupPath "AGENTS.md") -PathType Leaf) {
      Copy-Item -Force -LiteralPath (Join-Path $backupPath "AGENTS.md") -Destination $globalAgentsPath
    } elseif (-not $globalAgentsExisted -and (Test-Path -LiteralPath $globalAgentsPath -PathType Leaf)) {
      Remove-Item -Force -LiteralPath $globalAgentsPath
    }
    foreach ($agentName in $agentNames) {
      $target = Join-Path $agentsPath $agentName
      if ($existingAgents[$agentName]) {
        Copy-Item -Force -LiteralPath (Join-Path $backupPath $agentName) -Destination $target
      } elseif (Test-Path -LiteralPath $target) {
        Remove-Item -Force -LiteralPath $target
      }
    }
    [Environment]::SetEnvironmentVariable("DEEPSEEK_DISPATCHER_ALLOWED_ROOTS", $existingAllowedRoots, "User")
    throw
  }
} finally {
  if (Test-Path -LiteralPath $stagePath) {
    Remove-Item -Recurse -Force -LiteralPath $stagePath
  }
}

Write-Output "Installed DeepSeek provider and agent definitions."
Write-Output "Backup: $backupPath"
$processApiKey = $env:DEEPSEEK_API_KEY
$userApiKey = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
Write-Output "DEEPSEEK_API_KEY_PRESENT=$(-not [string]::IsNullOrWhiteSpace($processApiKey) -or -not [string]::IsNullOrWhiteSpace($userApiKey))"
Write-Output "DEEPSEEK_DISPATCHER_ALLOWED_ROOTS_COUNT=$($normalizedAllowedRoots.Count)"
Write-Output "Restart Codex after installing or updating the deepseek-local-dispatcher plugin."
