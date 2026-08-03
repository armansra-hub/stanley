param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('triggers','ats','website','signals','cosos')]
  [string]$Source,
  [int]$BatchSize = 50,
  [int]$RequestTimeoutSeconds = 150,
  [string]$BaseUrl = 'https://jarvis-sable-eta.vercel.app'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runDirectory = Join-Path $root '.foundation-run'
$statePath = Join-Path $runDirectory ("{0}-foundation.json" -f $Source)
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { [pscustomobject]@{ status='running'; source=$Source; offset=0; checked=0; receipts=@() } }
if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; exit 0 }
if ($state.source -ne $Source) { throw 'checkpoint source mismatch' }

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
  $uri = "$BaseUrl/api/cron/$Source?n=$BatchSize&offset=$($state.offset)"
  $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
  $receipt = [ordered]@{ at=(Get-Date).ToString('o'); offset=[int]$state.offset; checked=[int]$result.checked }
  foreach ($property in $result.PSObject.Properties) {
    if ($property.Name -ne 'checked') { $receipt[$property.Name] = $property.Value }
  }
  $receiptObject = [pscustomobject]$receipt
  $state.receipts = @($state.receipts) + $receiptObject
  $state.checked = [int]$state.checked + [int]$result.checked
  $state.offset = [int]$state.offset + [int]$result.checked
  if ([int]$result.checked -eq 0) {
    $state.status='complete'
    $state | Add-Member -NotePropertyName completedAt -NotePropertyValue (Get-Date).ToString('o') -Force
  }
  Save-State
  $receiptObject | ConvertTo-Json -Compress -Depth 6
  if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; break }
}
