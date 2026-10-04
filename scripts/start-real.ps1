param([switch]$ReuseExisting, [switch]$OpenBrowser)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot

# Explicit caller overrides permit an isolated data root and a free port.
$taskDataOverride = $env:DATA_ROOT
$taskPortOverride = $env:PORT
$taskEnvFile = Join-Path $taskRoot 'real-connection.env'
$taskLegacyFile = Join-Path $taskRoot '.local-validation\connectivity-env.ps1'
try {
  if (Test-Path -LiteralPath $taskEnvFile) {
    foreach ($taskLine in Get-Content -LiteralPath $taskEnvFile) {
      if ($taskLine -match '^\s*(#|$)') { continue }
      if ($taskLine -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
        throw 'Invalid real-connection.env entry; use NAME=value without shell expressions.'
      }
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
    Write-Host 'Using real-connection.env'
  } elseif (Test-Path -LiteralPath $taskLegacyFile) {
    . $taskLegacyFile
    Write-Host 'Using .local-validation\connectivity-env.ps1'
  } else {
    throw 'No real connection settings. Copy real-connection.env.example and fill in confirmed values.'
  }
  if ($taskDataOverride) { $env:DATA_ROOT = $taskDataOverride }
  if ($taskPortOverride) { $env:PORT = $taskPortOverride }
  $env:MOCK_MODE = 'false'
  if (!$env:DATA_ROOT) { $env:DATA_ROOT = 'data-real' }
  if (!$env:PORT) { $env:PORT = '4173' }
  if ($env:GEAP_ENVIRONMENT_CONFIRMED -cne 'true') {
    throw 'GEAP_ENVIRONMENT_CONFIRMED must be true after authentication, project, permissions and consent are confirmed.'
  }
  $taskPort = 0
  if (![int]::TryParse($env:PORT, [ref]$taskPort) -or $taskPort -lt 1 -or $taskPort -gt 65535) {
    throw 'PORT must be an integer between 1 and 65535.'
  }
  $taskNode = (Get-Command node -ErrorAction Stop).Source
  if ($env:GEAP_AUTH_MODE -ne 'service_account') {
    Get-Command gcloud.cmd -ErrorAction Stop | Out-Null
  }
  $taskHash = [System.Security.Cryptography.SHA256]::Create()
  try {
    $taskRootHash = ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant()
    $taskDataPath = [IO.Path]::GetFullPath($env:DATA_ROOT).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $taskDataHash = ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskDataPath.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant()
  } finally { $taskHash.Dispose() }
  $taskProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $taskPort)
  $taskAlreadyRunning = $false
  try {
    $taskProbe.Server.ExclusiveAddressUse = $true
    $taskProbe.Start()
  } catch {
    if ($ReuseExisting) {
      try {
        $taskHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$taskPort/api/health" -TimeoutSec 3
        $taskLock = Get-Content -Raw -LiteralPath (Join-Path $env:DATA_ROOT 'worker.lock') | ConvertFrom-Json
        $taskAlreadyRunning = $taskHealth.mode -eq 'geap' -and $taskHealth.launcher.pid -eq $taskLock.pid -and $taskHealth.launcher.workspace_sha256 -ceq $taskRootHash -and $taskHealth.launcher.data_root_sha256 -ceq $taskDataHash
      } catch { $taskAlreadyRunning = $false }
    }
    if (!$taskAlreadyRunning) {
      throw "Port $taskPort is unavailable. Leave the existing process running and choose another PORT."
    }
  } finally {
    $taskProbe.Stop()
  }
  if ($taskAlreadyRunning) {
    Write-Host "Using the existing REAL server for this workspace and data root: http://127.0.0.1:$taskPort/"
    if ($OpenBrowser) { Start-Process "http://127.0.0.1:$taskPort/analysis.html?new=1" }
    exit 0
  }
  Write-Host "Starting REAL mode on http://127.0.0.1:$taskPort/"
  Write-Host "Project: $env:GEAP_PROJECT / Location: $env:GEAP_LOCATION / Data: $env:DATA_ROOT"
  Write-Host 'Videos are sent to Google Cloud when an analysis starts.'
  $taskBrowserJob = $null
  if ($OpenBrowser) {
    # Open only after this server is listening; never open an old page or a
    # connection-error page while authentication/tool checks are still running.
    $taskBrowserJob = Start-Job -ArgumentList $taskPort,$taskRootHash,$taskDataHash -ScriptBlock {
      param($taskBrowserPort,$taskBrowserRootHash,$taskBrowserDataHash)
      $taskDeadline = [DateTime]::UtcNow.AddSeconds(45)
      while ([DateTime]::UtcNow -lt $taskDeadline) {
        try {
          $taskReady = Invoke-RestMethod "http://127.0.0.1:$taskBrowserPort/api/health" -TimeoutSec 1
          if ($taskReady.mode -eq 'geap' -and $taskReady.launcher.workspace_sha256 -ceq $taskBrowserRootHash -and $taskReady.launcher.data_root_sha256 -ceq $taskBrowserDataHash) {
            Start-Process "http://127.0.0.1:$taskBrowserPort/analysis.html?new=1"
            return
          }
        } catch {}
        Start-Sleep -Milliseconds 250
      }
    }
  }
  try {
    & $taskNode (Join-Path $taskRoot 'server.js')
    $taskExitCode = $LASTEXITCODE
  } finally {
    if ($taskBrowserJob) { Stop-Job $taskBrowserJob; Remove-Job $taskBrowserJob }
  }
  exit $taskExitCode
} catch {
  Write-Error $_.Exception.Message -ErrorAction Continue
  exit 1
}
