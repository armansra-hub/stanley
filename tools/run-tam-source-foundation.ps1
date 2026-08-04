param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('triggers','ats','website','signals','cosos')]
  [string]$Source,
  [int]$BatchSize = 50,
  [int]$RequestTimeoutSeconds = 150,
  [int]$StartOffset = -1,
  [int]$EndOffset = -1,
  [string]$StateSuffix = '',
  [string]$BaseUrl = 'https://jarvis-sable-eta.vercel.app'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
$root = Split-Path $PSScriptRoot -Parent
$runDirectory = Join-Path $root '.foundation-run'
$stateLeaf = if ($StateSuffix) { "{0}-foundation-{1}.json" -f $Source, $StateSuffix } else { "{0}-foundation.json" -f $Source }
$statePath = Join-Path $runDirectory $stateLeaf
$initialOffset = if ($StartOffset -ge 0) { $StartOffset } else { 0 }
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { [pscustomobject]@{ status='running'; source=$Source; offset=$initialOffset; checked=0; receipts=@() } }
if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; exit 0 }
if ($state.source -ne $Source) { throw 'checkpoint source mismatch' }
if ($StartOffset -ge 0 -and $state.receipts.Count -eq 0 -and [int]$state.offset -ne $StartOffset) { throw 'checkpoint start offset mismatch' }

$secretPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Stanley') 'public-growth-sweep-secret.dpapi'
$secret = $null
try {
  $secure = Get-Content -Raw -LiteralPath $secretPath | ConvertTo-SecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
} catch [Security.Cryptography.CryptographicException] {
  # DPAPI blobs are bound to the Windows security context that created them.
  # Reuse the already-downloaded production environment without printing it.
  $environmentPath = Join-Path $runDirectory 'vercel-production.env'
  $secretLine = Get-Content -LiteralPath $environmentPath |
    Where-Object { $_ -match '^TAM_GROWTH_SWEEP_SECRET=' } |
    Select-Object -First 1
  if (-not $secretLine) { throw 'sweep secret unavailable in DPAPI or production environment' }
  $secret = ($secretLine -split '=', 2)[1].Trim().Trim('"')
}
$headers = @{ 'x-cron-secret' = $secret }
$httpClient = [Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds($RequestTimeoutSeconds)
$httpClient.DefaultRequestHeaders.Add('x-cron-secret', $secret)

function Save-State {
  $tmp = "$statePath.$PID.tmp"
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp
      break
    } catch [System.IO.IOException] {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Milliseconds (100 * $attempt)
    }
  }
  # Move-Item -Force can still fail on Windows when the destination exists and a
  # status reader briefly has it open. File.Replace is an atomic same-volume swap;
  # retry boundedly when a virus scanner/status read holds either file for a moment.
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      [System.IO.File]::Copy($tmp, $statePath, $true)
      [System.IO.File]::Delete($tmp)
      return
    } catch [System.IO.IOException] {
      if ($attempt -eq 5) { throw }
      Start-Sleep -Milliseconds (100 * $attempt)
    }
  }
}

while ($true) {
  if ($EndOffset -ge 0 -and [int]$state.offset -ge $EndOffset) {
    $state.status='complete'
    $state | Add-Member -NotePropertyName completedAt -NotePropertyValue (Get-Date).ToString('o') -Force
    Save-State
    $state | ConvertTo-Json -Depth 8
    break
  }
  $requestSize = if ($EndOffset -ge 0) { [Math]::Min($BatchSize, $EndOffset - [int]$state.offset) } else { $BatchSize }
  $uri = "$BaseUrl/api/cron/${Source}?n=$requestSize&offset=$($state.offset)"
  $result = $null
  $requestError = $null
  try {
    $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
  } catch {
    $legacyError = $_.Exception
    if ($legacyError -is [Net.WebException] -and $null -ne $legacyError.Response) {
      # A real HTTP status (notably Vercel 504) is authoritative; repeating the
      # same request through another client only doubles the stall.
      $requestError = $legacyError.Message
    } else {
      try {
        # Retry transport-only TLS failures once through HttpClient.
        $response = $httpClient.GetAsync($uri).GetAwaiter().GetResult()
        $null = $response.EnsureSuccessStatusCode()
        $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
      } catch {
        $requestError = $_.Exception.Message
      }
    }
  }
  if ($null -eq $result) {
    $failedReceipt = [pscustomobject][ordered]@{
      at=(Get-Date).ToString('o'); offset=[int]$state.offset; checked=0
      error='request_timeout_or_gateway_failure'; detail=$requestError
      action=if ($requestSize -gt 1) { 'reduce_batch' } else { 'blocked_and_advance' }
    }
    $state.receipts = @($state.receipts) + $failedReceipt
    if ($requestSize -gt 1) {
      $BatchSize = [Math]::Max(1, [Math]::Floor($requestSize / 2))
    } else {
      $state.offset = [int]$state.offset + 1
      $blocked = if ($state.PSObject.Properties.Name -contains 'blockedOffsets') { @($state.blockedOffsets) } else { @() }
      $state | Add-Member -NotePropertyName blockedOffsets -NotePropertyValue (@($blocked) + ([int]$failedReceipt.offset)) -Force
    }
    Save-State
    $failedReceipt | ConvertTo-Json -Compress -Depth 4
    continue
  }
  $receipt = [ordered]@{ at=(Get-Date).ToString('o'); offset=[int]$state.offset; checked=[int]$result.checked }
  foreach ($property in $result.PSObject.Properties) {
    if ($property.Name -ne 'checked') { $receipt[$property.Name] = $property.Value }
  }
  $receiptObject = [pscustomobject]$receipt
  $state.receipts = @($state.receipts) + $receiptObject
  $state.checked = [int]$state.checked + [int]$result.checked
  $state.offset = [int]$state.offset + [int]$result.checked
  if ([int]$result.checked -eq 0 -or ($EndOffset -ge 0 -and [int]$state.offset -ge $EndOffset)) {
    $state.status='complete'
    $state | Add-Member -NotePropertyName completedAt -NotePropertyValue (Get-Date).ToString('o') -Force
  }
  Save-State
  $receiptObject | ConvertTo-Json -Compress -Depth 6
  if ($state.status -eq 'complete') { $state | ConvertTo-Json -Depth 8; break }
}
