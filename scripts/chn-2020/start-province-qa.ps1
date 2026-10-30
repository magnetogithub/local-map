param([int]$Port = 3001)
$ErrorActionPreference = 'Stop'
if ($Port -ne 3001) { throw 'DEDICATED_QA_PORT_REQUIRED' }
$provinceWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $provinceWorkspace
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'QA_PORT_ALREADY_IN_USE' }
$env:PAX_BUILD_DIST_DIR = '.next-chn-province-qa'
$env:PAX_OPERATIONAL_SMOKE = '0'
$env:OPENAI_API_KEY = ' '
$env:NEXT_TELEMETRY_DISABLED = '1'
$provinceNode = (Get-Command node).Source
$provinceServer = Start-Process -FilePath $provinceNode -ArgumentList @('node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',[string]$Port) -WorkingDirectory $provinceWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $provinceWorkspace '.tmp/chn-province-qa.out.log') -RedirectStandardError (Join-Path $provinceWorkspace '.tmp/chn-province-qa.err.log') -PassThru
@{pid=$provinceServer.Id;url="http://127.0.0.1:$Port";smoke=$false;externalAI='disabled; browser also blocks turn endpoint';launchCode=@{path='scripts/chn-2020/start-province-qa.ps1';sha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();byteLength=(Get-Item -LiteralPath $PSCommandPath).Length}} |ConvertTo-Json -Depth 8|Set-Content 'reports/chn-province-20261030/qa-launch.json' -Encoding utf8
Write-Output "PROVINCE_QA_PID=$($provinceServer.Id)"
$provinceServer.WaitForExit()
exit $provinceServer.ExitCode
