# Configure only the five local-inference settings below; keep every other Ollama setting.
# Run on the Windows machine that owns the installed Ollama and GPU.
[CmdletBinding(DefaultParameterSetName = 'Measure')]
param(
    [Parameter(ParameterSetName = 'Measure')]
    [string] $Model = 'qwen38-27b-ctx8k:latest',

    [Parameter(ParameterSetName = 'Measure')]
    [int[]] $Contexts = @(16384, 32768, 65536),

    [Parameter(ParameterSetName = 'Measure')]
    [string] $Output,

    [Parameter(ParameterSetName = 'Measure')]
    [ValidateRange(1000, 1800000)]
    [int] $TimeoutMs = 300000,

    [Parameter(Mandatory = $true, ParameterSetName = 'Restore')]
    [string] $RestoreSettings,

    [string] $Endpoint = 'http://127.0.0.1:11434',

    [switch] $RestartOllama
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This wrapper configures Windows user environment settings. Use school:context directly on other platforms.'
}

$targetSettings = [ordered]@{
    OLLAMA_FLASH_ATTENTION = '1'
    OLLAMA_KV_CACHE_TYPE = 'q8_0'
    OLLAMA_NUM_PARALLEL = '1'
    OLLAMA_MAX_LOADED_MODELS = '1'
    OLLAMA_NO_CLOUD = '1'
}
$endpointUri = [Uri] $Endpoint
if ($endpointUri.Scheme -ne 'http' -or $endpointUri.Host -notin @('localhost', '127.0.0.1', '[::1]', '::1') -or
    $endpointUri.UserInfo -or $endpointUri.Query -or $endpointUri.Fragment -or $endpointUri.AbsolutePath -ne '/') {
    throw 'Endpoint must be an HTTP loopback Ollama root without credentials, path, query, or fragment.'
}
if ($endpointUri.Host -eq 'localhost') {
    $endpointUri = [Uri] ('http://127.0.0.1:' + $endpointUri.Port)
}
$Endpoint = $endpointUri.GetLeftPart([UriPartial]::Authority)
if ($RestartOllama) {
    if ($Endpoint -ne 'http://127.0.0.1:11434') {
        throw 'Automatic restart supports only http://127.0.0.1:11434. Restart a custom endpoint yourself and use school:context directly.'
    }
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $configuredAddress = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', $scope)
        if ($configuredAddress) {
            $address = $configuredAddress.Trim().TrimEnd('/')
            if ($address -notin @('127.0.0.1:11434', 'localhost:11434', '0.0.0.0:11434', 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://0.0.0.0:11434')) {
                throw ('An existing OLLAMA_HOST in ' + $scope + ' does not match the supported restart endpoint. No settings were changed; use the CLI after restarting that server yourself.')
            }
        }
    }
    $endpointHasher = [Security.Cryptography.SHA256]::Create()
    try { $endpointHash = ([BitConverter]::ToString($endpointHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Endpoint)))).Replace('-', '').ToLowerInvariant() }
    finally { $endpointHasher.Dispose() }
    $probeLockPath = Join-Path ([IO.Path]::GetTempPath()) ('school-ollama-context-' + $endpointHash + '.lock')
    if (Test-Path -LiteralPath $probeLockPath) { throw ('A context probe lock exists: ' + $probeLockPath + '. Do not restart while a probe is running.') }
}

$ollamaExecutable = $null
$desktopExecutable = $null
$allowedExecutables = @()
if ($RestartOllama -or $PSCmdlet.ParameterSetName -eq 'Measure') {
    $ollamaCommand = Get-Command 'ollama.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $ollamaExecutable = (Get-Item -LiteralPath $ollamaCommand.Source -ErrorAction Stop).FullName
    $installDirectory = Split-Path -Parent $ollamaExecutable
    $desktopCandidate = Join-Path $installDirectory 'ollama app.exe'
    if (Test-Path -LiteralPath $desktopCandidate -PathType Leaf) {
        $desktopExecutable = (Get-Item -LiteralPath $desktopCandidate).FullName
    }
    $allowedExecutables = @($ollamaExecutable)
    if ($desktopExecutable) { $allowedExecutables += $desktopExecutable }
}

function Get-ObservedOllamaProcesses {
    @(Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Where-Object {
        $candidatePath = $_.Path
        $candidatePath -and $candidatePath -in $allowedExecutables
    })
}

function Restart-ObservedOllama {
    # Refuse to terminate a listener owned by another executable or installation.
    if (Get-Command 'Get-NetTCPConnection' -ErrorAction SilentlyContinue) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $endpointUri.Port -ErrorAction SilentlyContinue)
        foreach ($listener in $listeners) {
            $ownerProcess = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
            if (-not $ownerProcess.Path -or $ownerProcess.Path -notin $allowedExecutables) {
                throw ('Port ' + $endpointUri.Port + ' is owned by an unrecognized executable; no process was stopped.')
            }
        }
    }
    Write-Host 'Restarting the observed Ollama installation. Other Ollama requests should be idle.'
    $observed = @(Get-ObservedOllamaProcesses | Sort-Object @{ Expression = { if ($_.ProcessName -eq 'ollama app') { 0 } else { 1 } } })
    foreach ($ollamaProcess in $observed) {
        if (-not $ollamaProcess.HasExited) { Stop-Process -Id $ollamaProcess.Id -ErrorAction Stop }
    }
    foreach ($ollamaProcess in $observed) {
        if (-not $ollamaProcess.WaitForExit(10000)) { throw 'An observed Ollama process did not exit; no replacement was started.' }
    }
    if ($desktopExecutable) {
        $startedProcess = Start-Process -FilePath $desktopExecutable -PassThru
    } else {
        $startedProcess = Start-Process -FilePath $ollamaExecutable -ArgumentList @('serve') -WindowStyle Hidden -PassThru
    }
    Write-Host ('Started installed Ollama executable; process ' + $startedProcess.Id + '. Waiting for local health response.')
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            # WebRequest bypasses any system HTTP proxy and never follows redirects.
            $request = [Net.HttpWebRequest] [Net.WebRequest]::Create($Endpoint + '/api/version')
            $request.Proxy = $null
            $request.AllowAutoRedirect = $false
            $request.Timeout = 2000
            $response = $request.GetResponse()
            try { $healthy = ([int] $response.StatusCode -eq 200) } finally { $response.Close() }
        } catch { $healthy = $false }
        if ($healthy) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) { throw 'The restarted local Ollama did not become ready. Settings were saved, but no model probe ran.' }
}

if ($PSCmdlet.ParameterSetName -eq 'Restore') {
    $backupPath = (Get-Item -LiteralPath $RestoreSettings -ErrorAction Stop).FullName
    $backup = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
    if ($backup.kind -ne 'school-local-ollama-environment' -or $backup.version -ne 1 -or -not $backup.values) {
        throw 'The file is not a supported local Ollama environment backup.'
    }
    $providedNames = @($backup.values.PSObject.Properties.Name)
    if ($providedNames.Count -ne $targetSettings.Count -or @($providedNames | Where-Object { $_ -notin $targetSettings.Keys }).Count -gt 0) {
        throw 'The backup must contain exactly the five supported environment settings.'
    }
    foreach ($settingName in $targetSettings.Keys) {
        $savedValue = $backup.values.$settingName
        foreach ($scope in @('User', 'Process')) {
            $value = $savedValue.$scope
            if ($null -ne $value -and $value -isnot [string]) { throw 'Backup values must be strings or null.' }
        }
    }
    foreach ($settingName in $targetSettings.Keys) {
        $savedValue = $backup.values.$settingName
        [Environment]::SetEnvironmentVariable($settingName, $savedValue.User, 'User')
        [Environment]::SetEnvironmentVariable($settingName, $savedValue.Process, 'Process')
    }
    Write-Host ('Restored only the five saved environment settings from ' + $backupPath)
    if ($RestartOllama) { Restart-ObservedOllama }
    else { Write-Host 'Quit Ollama from its tray icon and start it again to apply the restored server settings.' }
    return
}

if ($Contexts.Count -lt 1 -or $Contexts.Count -gt 8 -or @($Contexts | Where-Object { $_ -lt 2048 -or $_ -gt 1048576 }).Count -gt 0) {
    throw 'Choose one through eight context sizes from 2048 through 1048576.'
}
$repository = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $PSScriptRoot 'school-context.ts'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'The School context CLI is missing beside this wrapper.' }
$nodeCommand = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeExecutable = (Get-Item -LiteralPath $nodeCommand.Source -ErrorAction Stop).FullName
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
if (-not $Output) { $Output = Join-Path (Get-Location).Path ('local-context-' + $timestamp + '.json') }
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path -LiteralPath $outputPath) { throw 'The output filename already exists; choose a new filename.' }
$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) { throw 'The output directory must already exist.' }
$backupPath = Join-Path $outputDirectory ('local-ollama-settings-' + $timestamp + '.json')
$oldValues = [ordered]@{}
foreach ($settingName in $targetSettings.Keys) {
    $oldValues[$settingName] = [ordered]@{
        User = [Environment]::GetEnvironmentVariable($settingName, 'User')
        Process = [Environment]::GetEnvironmentVariable($settingName, 'Process')
    }
}
$backup = [ordered]@{ version = 1; kind = 'school-local-ollama-environment'; createdAt = [DateTime]::UtcNow.ToString('o'); values = $oldValues }
$backupBytes = [Text.UTF8Encoding]::new($false).GetBytes(($backup | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
$backupStream = [IO.File]::Open($backupPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $backupStream.Write($backupBytes, 0, $backupBytes.Length); $backupStream.Flush($true) } finally { $backupStream.Dispose() }
Write-Host ('Saved rollback values: ' + $backupPath)
foreach ($settingName in $targetSettings.Keys) {
    [Environment]::SetEnvironmentVariable($settingName, $targetSettings[$settingName], 'User')
    [Environment]::SetEnvironmentVariable($settingName, $targetSettings[$settingName], 'Process')
}
Write-Host 'Set local-only Ollama, q8_0 cache, Flash Attention, one loaded model and one parallel request.'
if (-not $RestartOllama) {
    Write-Host 'Ollama has not been restarted and no inference has run. Quit it from the tray and start it again, then run:'
    Write-Host ('npm run school:context -- --model "' + $Model + '" --run --contexts ' + ($Contexts -join ',') + ' --endpoint ' + $Endpoint + ' --output "' + $outputPath + '"')
    return
}
Restart-ObservedOllama
$cliArguments = @('--import', 'tsx', $cli, '--model', $Model, '--run', '--contexts', ($Contexts -join ','), '--endpoint', $Endpoint, '--output', $outputPath, '--timeout-ms', [string] $TimeoutMs)
Push-Location -LiteralPath $repository
try {
    & $nodeExecutable @cliArguments
    $probeExitCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host ('Context report: ' + $outputPath)
Write-Host ('Rollback settings with: powershell -File "' + $PSCommandPath + '" -RestoreSettings "' + $backupPath + '" -RestartOllama')
exit $probeExitCode
