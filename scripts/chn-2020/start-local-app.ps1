param([int]$Port = 3002)
$ErrorActionPreference = 'Stop'
$chnWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $chnWorkspace
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "APP_PORT_ALREADY_IN_USE:$Port"
}
$chnPointer = Get-Content -LiteralPath 'data/runtime/operational-catalog/current.json' -Raw | ConvertFrom-Json
$env:PAX_BUILD_DIST_DIR = '.next-chn-2020-app'
$env:PAX_OPERATIONAL_SMOKE = '0'
$env:NEXT_TELEMETRY_DISABLED = '1'
$chnNode = (Get-Command node).Source
$chnOut = Join-Path $chnWorkspace '.tmp/chn-app-server.out.log'
$chnErr = Join-Path $chnWorkspace '.tmp/chn-app-server.err.log'
$chnServer = Start-Process -FilePath $chnNode -ArgumentList @('node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', [string]$Port) -WorkingDirectory $chnWorkspace -WindowStyle Hidden -RedirectStandardOutput $chnOut -RedirectStandardError $chnErr -PassThru
$chnProof = [ordered]@{
  smoke = $false
  url = "http://127.0.0.1:$Port"
  pid = $chnServer.Id
  catalogVersion = $chnPointer.catalogVersion
  environment = [ordered]@{PAX_OPERATIONAL_SMOKE = '0'; NEXT_TELEMETRY_DISABLED = '1'}
  launchCodeArtifact = [ordered]@{path = 'scripts/chn-2020/start-local-app.ps1'; sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); byteLength = (Get-Item -LiteralPath $PSCommandPath).Length}
}
$chnProof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'reports/chn-2020/local-app-launch.json' -Encoding utf8
Write-Output "APP_SERVER_PID=$($chnServer.Id) URL=$($chnProof.url)"
$chnServer.WaitForExit()
exit $chnServer.ExitCode
