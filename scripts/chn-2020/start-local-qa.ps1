param([int]$Port = 3001)
$ErrorActionPreference = 'Stop'
$chnWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $chnWorkspace
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "QA_PORT_ALREADY_IN_USE:$Port"
}
$chnPointer = Get-Content -LiteralPath 'data/runtime/operational-catalog/current.json' -Raw | ConvertFrom-Json
$env:PAX_BUILD_DIST_DIR = '.next-chn-2020-qa'
$env:PAX_OPERATIONAL_SMOKE = '1'
# A nonempty whitespace value survives dotenv loading but provider-config trims
# it to empty. If the scripted alias is missing, AI_NOT_CONFIGURED is thrown
# before any FetchOpenAIResponsesTransport can be constructed.
$env:OPENAI_API_KEY = ' '
$env:OPENAI_MODEL = 'disabled-for-local-qa'
$chnNode = (Get-Command node).Source
$chnOut = Join-Path $chnWorkspace '.tmp/chn-qa-server.out.log'
$chnErr = Join-Path $chnWorkspace '.tmp/chn-qa-server.err.log'
$chnServer = Start-Process -FilePath $chnNode -ArgumentList @('node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', [string]$Port) -WorkingDirectory $chnWorkspace -WindowStyle Hidden -RedirectStandardOutput $chnOut -RedirectStandardError $chnErr -PassThru
$chnLaunchFile = (Resolve-Path -LiteralPath $PSCommandPath).Path
$chnProof = [ordered]@{
  smoke = $true
  apiKeyPolicy = 'whitespace-trims-empty'
  disabledExternalAI = $true
  url = "http://127.0.0.1:$Port"
  pid = $chnServer.Id
  catalogVersion = $chnPointer.catalogVersion
  environment = [ordered]@{PAX_OPERATIONAL_SMOKE = '1'; OPENAI_API_KEY = ' '; OPENAI_MODEL = 'disabled-for-local-qa'}
  launchCodeArtifact = [ordered]@{path = 'scripts/chn-2020/start-local-qa.ps1'; sha256 = (Get-FileHash -LiteralPath $chnLaunchFile -Algorithm SHA256).Hash.ToLowerInvariant(); byteLength = (Get-Item -LiteralPath $chnLaunchFile).Length}
}
$chnProof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'reports/chn-2020/local-qa-launch.json' -Encoding utf8
Write-Output "QA_SERVER_PID=$($chnServer.Id) URL=$($chnProof.url)"
$chnServer.WaitForExit()
exit $chnServer.ExitCode
