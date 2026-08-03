param(
  [int]$BatchSize = 50,
  [int]$RequestTimeoutSeconds = 120,
  [string]$BaseUrl = 'https://jarvis-sable-eta.vercel.app'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runDirectory = Join-Path $root '.foundation-run'
$statePath = Join-Path $runDirectory 'fmcsa-foundation.json'
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { [pscustomobject]@{ status='running'; offset=0; checked=0; matched=0; triggers=0; receipts=@() } }
if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; exit 0 }

$secretPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Stanley') 'public-growth-sweep-secret.dpapi'
$secure = Get-Content -Raw -LiteralPath $secretPath | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$headers = @{ 'x-cron-secret' = $secret }

function Save-State {
  $tmp = "$statePath.tmp"
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
}

while ($true) {
  $uri = "$BaseUrl/api/cron/fmcsa?n=$BatchSize&offset=$($state.offset)"
  $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
  $receipt = [pscustomobject]@{ at=(Get-Date).ToString('o'); offset=[int]$state.offset; checked=[int]$result.checked; matched=[int]$result.matched; triggers=[int]$result.fleet_growth }
  $state.receipts = @($state.receipts) + $receipt
  $state.checked = [int]$state.checked + [int]$result.checked
  $state.matched = [int]$state.matched + [int]$result.matched
  $state.triggers = [int]$state.triggers + [int]$result.fleet_growth
  $state.offset = [int]$state.offset + [int]$result.checked
  if ([int]$result.checked -eq 0) { $state.status='complete'; $state.completedAt=(Get-Date).ToString('o') }
  Save-State
  $receipt | ConvertTo-Json -Compress
  if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; break }
}
