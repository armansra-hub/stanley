param(
  [ValidateSet('Awards', 'Subawards')]
  [string]$Mode = 'Awards',
  [int]$WorkerIndex = 0,
  [int]$WorkerCount = 1,
  [int]$BatchSize = 10,
  [int]$StartOffset = 0,
  [int]$TotalCompanies = 6949,
  [int]$RequestTimeoutSeconds = 75,
  [int]$CooldownMilliseconds = 1500,
  [string]$BaseUrl = 'https://jarvis-sable-eta.vercel.app'
)

$ErrorActionPreference = 'Stop'
$runDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) '.foundation-run'
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$source = if ($Mode -eq 'Subawards') { 'usaspending-subawards' } else { 'usaspending' }
$logPath = Join-Path $runDirectory ("{0}-foundation-{1}.jsonl" -f $source, $WorkerIndex)
$secretPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Stanley') 'public-growth-sweep-secret.dpapi'
$secure = Get-Content -Raw -LiteralPath $secretPath | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
$headers = @{ 'x-cron-secret' = $secret }
$completed = [Collections.Generic.HashSet[int]]::new()
$resumeAwardOffsets = @{}

if ($Mode -eq 'Awards') {
  $batchRows = @()
  foreach ($file in Get-ChildItem -LiteralPath $runDirectory -Filter 'usaspending*.jsonl') {
    foreach ($line in Get-Content -LiteralPath $file.FullName) {
      try { $row = $line | ConvertFrom-Json; if ($null -ne $row.offset) { $batchRows += $row } } catch {}
    }
  }
  foreach ($row in ($batchRows | Group-Object offset | ForEach-Object { $_.Group | Sort-Object at | Select-Object -Last 1 })) {
    # Only a verified match needs every award page before it is complete.
    # No-award and ambiguous identities are terminal outcomes for this pass.
    $awardComplete = $row.status -ne 'matched' -or [bool]$row.awardDone
    if ([int]$row.checked -gt 0 -and [int]$row.errors -eq 0 -and $awardComplete) {
      for ($i = [int]$row.offset; $i -lt [Math]::Min([int]$row.offset + [int]$row.checked, $TotalCompanies); $i++) { [void]$completed.Add($i) }
    }
    elseif ($row.status -eq 'matched' -and $row.awardDone -eq $false -and [int]$row.nextAwardOffset -gt 0) {
      $resumeAwardOffsets[[int]$row.offset] = [int]$row.nextAwardOffset
    }
  }
  $companyRows = @()
  foreach ($file in Get-ChildItem -LiteralPath $runDirectory -Filter 'usaspending-company-worker-*.jsonl') {
    foreach ($line in Get-Content -LiteralPath $file.FullName) {
      try { $row = $line | ConvertFrom-Json; if ($null -ne $row.companyOffset) { $companyRows += $row } } catch {}
    }
  }
  foreach ($row in ($companyRows | Group-Object companyOffset | ForEach-Object { $_.Group | Sort-Object at | Select-Object -Last 1 })) {
    if ([int]$row.checked -eq 1) { [void]$completed.Add([int]$row.companyOffset) }
  }
  # The first batch predates the durable worker receipts, and offset 115 was
  # completed through the award-pagination recovery path.
  for ($i = 0; $i -lt 10; $i++) { [void]$completed.Add($i) }
  [void]$completed.Add(115)
}

function Write-Receipt([hashtable]$Receipt) {
  $Receipt.at = (Get-Date).ToString('o')
  $line = $Receipt | ConvertTo-Json -Compress -Depth 8
  Add-Content -LiteralPath $logPath -Value $line
  Write-Output $line
}

for ($offset = $StartOffset + $WorkerIndex * $BatchSize; $offset -lt $TotalCompanies; $offset += $WorkerCount * $BatchSize) {
  $limit = [Math]::Min($BatchSize, $TotalCompanies - $offset)
  $pending = @($offset..($offset + $limit - 1) | Where-Object { -not $completed.Contains($_) })
  if ($pending.Count -eq 0) { continue }
  $uri = "$BaseUrl/api/cron/public-growth?source=$source&n=$limit&offset=$offset"
  if ($Mode -eq 'Awards' -and $BatchSize -eq 1) {
    $initialAwardOffset = if ($resumeAwardOffsets.ContainsKey($offset)) { [int]$resumeAwardOffsets[$offset] } else { 0 }
    $uri += "&awardOffset=$initialAwardOffset&awardLimit=50"
  }
  try {
    $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
    $primary = @($result.receipts)[0]
    Write-Receipt ([ordered]@{
      worker = $WorkerIndex; offset = $offset; checked = $result.checked
      matched = $result.matched; ambiguous = $result.ambiguous; errors = $result.errors
      awards = $result.awards; transactions = $result.transactions
      stored = $result.stored; triggers = $result.triggers
      status = $primary.status; awardOffset = $primary.awardOffset
      nextAwardOffset = $primary.nextAwardOffset; awardTotal = $primary.awardTotal
      awardDone = $primary.awardDone
      receiptErrors = @($result.receipts | Where-Object { $_.error } | ForEach-Object { $_.error })
    })

    if ($Mode -eq 'Awards' -and $BatchSize -eq 1 -and $primary.status -eq 'matched' -and $primary.awardDone -eq $false) {
      $awardOffset = [int]$primary.nextAwardOffset
      $awardTotal = [int]$primary.awardTotal
      while ($awardOffset -lt $awardTotal) {
        if ($CooldownMilliseconds -gt 0) { Start-Sleep -Milliseconds $CooldownMilliseconds }
        $chunkUri = "$BaseUrl/api/cron/public-growth?source=usaspending&n=1&offset=$offset&awardOffset=$awardOffset&awardLimit=50"
        $chunk = Invoke-RestMethod -Uri $chunkUri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
        $chunkReceipt = @($chunk.receipts)[0]
        Write-Receipt ([ordered]@{
          worker = $WorkerIndex; offset = $offset; checked = $chunk.checked
          matched = $chunk.matched; ambiguous = $chunk.ambiguous; errors = $chunk.errors
          awards = $chunk.awards; transactions = $chunk.transactions; triggers = $chunk.triggers
          status = $chunkReceipt.status; awardOffset = $chunkReceipt.awardOffset
          nextAwardOffset = $chunkReceipt.nextAwardOffset; awardTotal = $chunkReceipt.awardTotal
          awardDone = $chunkReceipt.awardDone
          receiptErrors = @($chunk.receipts | Where-Object { $_.error } | ForEach-Object { $_.error })
        })
        if ([int]$chunk.errors -gt 0 -or $chunkReceipt.status -eq 'error') { break }
        $awardOffset = [int]$chunkReceipt.nextAwardOffset
        $awardTotal = [int]$chunkReceipt.awardTotal
        if ([bool]$chunkReceipt.awardDone) { break }
      }
    }
  }
  catch {
    Write-Receipt ([ordered]@{ worker = $WorkerIndex; offset = $offset; fatal = $_.Exception.Message })
  }
  if ($CooldownMilliseconds -gt 0) { Start-Sleep -Milliseconds $CooldownMilliseconds }
}
