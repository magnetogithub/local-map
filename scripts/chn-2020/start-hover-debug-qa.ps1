param([int]$Port = 3001)
$ErrorActionPreference = 'Stop'
if ($Port -ne 3001) { throw 'DEDICATED_QA_PORT_REQUIRED' }
$hoverDebugWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $hoverDebugWorkspace
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'QA_PORT_ALREADY_IN_USE' }
$env:PAX_BUILD_DIST_DIR = '.next-chn-hover-debug-qa'
$env:PAX_OPERATIONAL_SMOKE = '0'
$env:OPENAI_API_KEY = ' '
$env:NEXT_TELEMETRY_DISABLED = '1'
$hoverDebugNode = (Get-Command node).Source
$hoverDebugServer = Start-Process -FilePath $hoverDebugNode -ArgumentList @('node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',[string]$Port) -WorkingDirectory $hoverDebugWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $hoverDebugWorkspace '.tmp/chn-hover-debug-qa.out.log') -RedirectStandardError (Join-Path $hoverDebugWorkspace '.tmp/chn-hover-debug-qa.err.log') -PassThru
@{pid=$hoverDebugServer.Id;url="http://127.0.0.1:$Port";smoke=$false;externalAI='disabled; browser also blocks turn endpoint';launchCode=@{path='scripts/chn-2020/start-hover-debug-qa.ps1';sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();byteLength=(Get-Item -LiteralPath $PSCommandPath).Length}} |ConvertTo-Json -Depth 8|Set-Content 'reports/hover-debug-20261030/qa-launch.json' -Encoding utf8
Write-Output "HOVER_DEBUG_QA_PID=$($hoverDebugServer.Id)"
$hoverDebugServer.WaitForExit()
exit $hoverDebugServer.ExitCode

