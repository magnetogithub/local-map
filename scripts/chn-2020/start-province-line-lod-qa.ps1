param([int]$Port = 3001)
$ErrorActionPreference = 'Stop'
if ($Port -ne 3001) { throw 'DEDICATED_QA_PORT_REQUIRED' }
$lodWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $lodWorkspace
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'QA_PORT_ALREADY_IN_USE' }
$env:PAX_BUILD_DIST_DIR = '.next-province-line-lod-qa'
$env:PAX_OPERATIONAL_SMOKE = '0'
$env:OPENAI_API_KEY = ' '
$env:NEXT_TELEMETRY_DISABLED = '1'
$lodNode = (Get-Command node).Source
$lodServer = Start-Process -FilePath $lodNode -ArgumentList @('node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',[string]$Port) -WorkingDirectory $lodWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $lodWorkspace '.tmp/province-line-lod-qa.out.log') -RedirectStandardError (Join-Path $lodWorkspace '.tmp/province-line-lod-qa.err.log') -PassThru
@{pid=$lodServer.Id;url="http://127.0.0.1:$Port";smoke=$false;externalAI='disabled; browser blocks turns';launchCode=@{path='scripts/chn-2020/start-province-line-lod-qa.ps1';sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();byteLength=(Get-Item -LiteralPath $PSCommandPath).Length}} |ConvertTo-Json -Depth 8|Set-Content 'reports/chn-render-lod-20261030/qa-launch.json' -Encoding utf8
Write-Output "PROVINCE_LINE_LOD_QA_PID=$($lodServer.Id)"
$lodServer.WaitForExit()
exit $lodServer.ExitCode
