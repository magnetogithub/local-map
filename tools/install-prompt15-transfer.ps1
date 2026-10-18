param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [string]$Destination='D:\gen',
  [switch]$ExistingCheckout,
  [switch]$Resume
)
$ErrorActionPreference='Stop'
$repository='magnetogithub/local-map'
if($Tag -notmatch '^prompt15-transfer-[A-Za-z0-9.-]+$'){throw 'Use the exact published Prompt15 transfer release tag.'}
$destinationPath=[System.IO.Path]::GetFullPath($Destination)
if($destinationPath.TrimEnd('\') -ne 'D:\gen'){throw 'This transfer preserves immutable absolute paths. Use D:\gen on Windows.'}
if(-not (Get-Command git -ErrorAction SilentlyContinue)){throw 'Install Git for Windows first.'}
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Install Node.js 24.18.0 x64 at C:\Program Files\nodejs first.'}
$nodeVersion=(& node --version).Trim()
if($nodeVersion -ne 'v24.18.0'){throw ('Install Node.js 24.18.0 x64 first. Current version: '+$nodeVersion)}
if(Test-Path -LiteralPath (Join-Path $destinationPath 'reports\prompt15\orchestration\latest.json')){throw 'An orchestration run already exists. Do not restore over the original PC or an existing run.'}
if($ExistingCheckout){
  if(-not (Test-Path -LiteralPath (Join-Path $destinationPath '.git'))){throw 'ExistingCheckout requires a Git checkout at D:\gen.'}
  & git -C $destinationPath diff --quiet HEAD -- src scripts tools automation prompts docs package.json package-lock.json
  if($LASTEXITCODE -ne 0){throw 'Preserve local source changes before restoring this checkout.'}
}elseif(Test-Path -LiteralPath $destinationPath){throw 'Destination already exists. For a fresh clone without a local run, use -ExistingCheckout.'}
$metadata=Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/tags/$Tag" -Headers @{'User-Agent'='Prompt15-transfer'}
if($metadata.draft){throw 'Transfer release is not published.'}
$originalLfs=$env:GIT_LFS_SKIP_SMUDGE
if(-not $ExistingCheckout){try {
  $env:GIT_LFS_SKIP_SMUDGE='1'
  & git clone --depth 1 --filter=blob:none --no-checkout --single-branch --branch $Tag "https://github.com/$repository.git" $destinationPath
  if($LASTEXITCODE -ne 0){throw 'Source clone failed.'}
  & git -C $destinationPath sparse-checkout set --cone src scripts tools automation docs prompts e2e .github checkpoints
  if($LASTEXITCODE -ne 0){throw 'Source checkout setup failed.'}
  & git -C $destinationPath checkout -b main $Tag
  if($LASTEXITCODE -ne 0){throw 'Source checkout failed.'}
  & git -C $destinationPath config remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
  & git -C $destinationPath config branch.main.remote origin
  & git -C $destinationPath config branch.main.merge refs/heads/main
} finally {if($null -eq $originalLfs){Remove-Item Env:GIT_LFS_SKIP_SMUDGE -ErrorAction SilentlyContinue}else{$env:GIT_LFS_SKIP_SMUDGE=$originalLfs}}}
$download=Join-Path $destinationPath '.tmp\prompt15-transfer-download'
New-Item -ItemType Directory -Path $download -ErrorAction Stop|Out-Null
$assetNames=@('manifest.json','publication-scan.json','summary.json','validation-report.json','SHA256SUMS.txt')
$assetNames+=@($metadata.assets|Where-Object {$_.name -match '^prompt15-transfer-objects-\d{3}\.tar\.gz$'}|ForEach-Object {$_.name})
foreach($name in $assetNames){
  $asset=@($metadata.assets|Where-Object {$_.name -eq $name})
  if($asset.Count -ne 1){throw ('Missing or duplicate release asset: '+$name)}
  $target=Join-Path $download $name
  Write-Output ('Downloading '+$name)
  Invoke-WebRequest -Uri $asset[0].browser_download_url -OutFile $target -UseBasicParsing
  if(-not $asset[0].digest -or -not $asset[0].digest.StartsWith('sha256:')){throw ('Release asset has no SHA256 identity: '+$name)}
  if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset[0].digest.Substring(7)){throw ('Download hash mismatch: '+$name)}
}
foreach($line in (Get-Content -LiteralPath (Join-Path $download 'SHA256SUMS.txt'))){
  if($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$'){throw 'Invalid checksum manifest line.'}
  $expectedHash=$Matches[1];$assetName=$Matches[2]
  if($assetName -notin $assetNames){throw ('Unexpected checksum asset: '+$assetName)}
  if((Get-FileHash -LiteralPath (Join-Path $download $assetName) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash){throw ('Checksum mismatch: '+$assetName)}
}
$manifest=Get-Content -Raw -LiteralPath (Join-Path $download 'manifest.json')|ConvertFrom-Json
$validation=Get-Content -Raw -LiteralPath (Join-Path $download 'validation-report.json')|ConvertFrom-Json
if(-not $validation.pass -or -not $validation.independentRestorePass -or -not $validation.operatingRegressionPass -or $validation.manifestSha256 -ne (Get-FileHash -LiteralPath (Join-Path $download 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Transfer independent validation did not pass.'}
$checkout=(& git -C $destinationPath rev-parse HEAD).Trim()
if($checkout -ne $manifest.sourceCommit){throw 'Release tag does not match the transfer source commit.'}
$oldLocation=Get-Location
try{
  Set-Location -LiteralPath $destinationPath
  & node tools/prompt15-transfer.mjs restore $download
  if($LASTEXITCODE -ne 0){throw 'Transfer restore failed. Run remains stopped.'}
  & npm.cmd ci
  if($LASTEXITCODE -ne 0){throw 'Dependency installation failed. Run remains stopped.'}
  foreach($environment in $manifest.npmInstallRoots){
    if($environment -eq '.'){continue}
    if($environment -match '(^|[/\\])\.\.([/\\]|$)' -or [System.IO.Path]::IsPathRooted($environment)){throw 'Invalid npm environment path.'}
    & npm.cmd ci --prefix (Join-Path $destinationPath $environment)
    if($LASTEXITCODE -ne 0){throw ('Dependency installation failed for '+$environment+'. Run remains stopped.')}
  }
  & node tools/prompt15-transfer.mjs prepare $download
  if($LASTEXITCODE -ne 0){throw 'Approval/integrity/regression verification failed. Run remains stopped.'}
  Write-Output 'Transfer prepared. Log in to Codex on this PC; no old credentials were copied.'
  Write-Output ('Resume: node tools/prompt15-runtime.mjs resume --run '+$manifest.runRelative)
  if($Resume){
    & node scripts/prompt15-orchestrator/run.mjs check
    if($LASTEXITCODE -ne 0){throw 'Codex is unavailable or not logged in. Log in and use the printed resume command.'}
    & node tools/prompt15-runtime.mjs resume --run $manifest.runRelative
  }
}finally{Set-Location -LiteralPath $oldLocation}
