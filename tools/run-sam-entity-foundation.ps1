param(
  [int]$BatchSize = 10,
  [int]$StartOffset = 0,
  [int]$TotalCompanies = 6949,
  [int]$RequestTimeoutSeconds = 240,
  [int]$CooldownMilliseconds = 1000,
  [string]$BaseUrl = 'https://jarvis-sable-eta.vercel.app'
)

$ErrorActionPreference = 'Stop'
$runDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) '.foundation-run'
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$logPath = Join-Path $runDirectory 'sam-entity-foundation.jsonl'
$secretPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Stanley') 'public-growth-sweep-secret.dpapi'
$secure = Get-Content -Raw -LiteralPath $secretPath | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$headers = @{ 'x-cron-secret' = $secret }

$completed = [Collections.Generic.HashSet[int]]::new()
if (Test-Path -LiteralPath $logPath) {
  $rows = foreach ($line in Get-Content -LiteralPath $logPath) {
    try { $line | ConvertFrom-Json } catch {}
  }
  foreach ($row in ($rows | Group-Object offset | ForEach-Object { $_.Group | Sort-Object at | Select-Object -Last 1 })) {
    if ([int]$row.checked -gt 0 -and [int]$row.errors -eq 0) {
      for ($i = [int]$row.offset; $i -lt [Math]::Min([int]$row.offset + [int]$row.checked, $TotalCompanies); $i++) {
        [void]$completed.Add($i)
      }
    }
  }
}

function Write-Receipt([hashtable]$Receipt) {
  $Receipt.at = (Get-Date).ToString('o')
  $line = $Receipt | ConvertTo-Json -Compress -Depth 8
  Add-Content -LiteralPath $logPath -Value $line
  Write-Output $line
}

try {
  for ($offset = $StartOffset; $offset -lt $TotalCompanies; $offset += $BatchSize) {
    $limit = [Math]::Min($BatchSize, $TotalCompanies - $offset)
    $pending = @($offset..($offset + $limit - 1) | Where-Object { -not $completed.Contains($_) })
    if ($pending.Count -eq 0) { continue }

    # Resume on the first unfinished company so a partially completed batch is
    # never silently skipped after an interruption.
    $requestOffset = [int]$pending[0]
    $requestLimit = [Math]::Min($BatchSize, $TotalCompanies - $requestOffset)
    $uri = "$BaseUrl/api/cron/public-growth?source=sam-entity&n=$requestLimit&offset=$requestOffset"
    try {
      $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
      Write-Receipt ([ordered]@{
        offset = $requestOffset; checked = $result.checked; nextOffset = $result.nextOffset
        matched = $result.matched; ambiguous = $result.ambiguous; errors = $result.errors
        entities = $result.entities; naics = $result.naics; triggers = $result.triggers
        statuses = @($result.receipts | Group-Object status | ForEach-Object { @{ status = $_.Name; count = $_.Count } })
        receiptErrors = @($result.receipts | Where-Object { $_.error } | ForEach-Object { $_.error })
      })
      if ([int]$result.errors -gt 0) { throw "SAM entity batch $requestOffset returned $($result.errors) error(s)" }
    }
    catch {
      Write-Receipt ([ordered]@{
        offset = $requestOffset; checked = 0; nextOffset = $requestOffset
        matched = 0; ambiguous = 0; errors = 1; entities = 0; naics = 0; triggers = 0
        statuses = @(); receiptErrors = @($_.Exception.Message)
      })
      throw
    }
    if ($CooldownMilliseconds -gt 0) { Start-Sleep -Milliseconds $CooldownMilliseconds }
  }
}
finally {
  Remove-Variable secret -ErrorAction SilentlyContinue
}
