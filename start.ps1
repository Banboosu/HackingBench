$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Install Windows-native Bun >=1.4.4 first, then reopen PowerShell.' }
  bun --no-env-file -e "const [a,b,c]=Bun.version.split('.').map(Number); if(process.platform!=='win32'||!Number.isInteger(c)||a<1||(a===1&&(b<4||(b===4&&c<4)))){console.error('Windows-native Bun >=1.4.4 required.');process.exit(1)}"
  if ($LASTEXITCODE -ne 0) { throw 'Unsupported Bun environment.' }
  Write-Host 'Checking pinned Bun dependencies (no lifecycle scripts)...' -ForegroundColor Cyan
  bun install --frozen-lockfile --ignore-scripts --no-env-file
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  bun --no-env-file run start @args
  if ($LASTEXITCODE -ne 0) { throw "HackingBench exited with code $LASTEXITCODE" }
} finally { Pop-Location }
