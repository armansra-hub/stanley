param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('triggers','ats','website')]
  [string]$Source,
  [Parameter(Mandatory=$true)]
  [int]$FinalOffset,
  [Parameter(Mandatory=$true)]
  [string]$ShardFiles,
  [int]$TotalTam = 6949
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runDirectory = Join-Path $root '.foundation-run'
$statePath = Join-Path $runDirectory ("{0}-foundation.json" -f $Source)
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json

$merged = [Collections.Generic.List[string]]::new()
$blocked = [Collections.Generic.List[int]]::new()
$receipts = [Collections.Generic.List[object]]::new()

foreach ($receipt in @($state.receipts)) { $receipts.Add($receipt) }
foreach ($offset in @($state.blockedOffsets)) {
  if ($null -ne $offset) { $blocked.Add([int]$offset) }
}
foreach ($leaf in @($state.mergedShardFiles)) {
  if ($null -ne $leaf -and $leaf -isnot [string]) { continue }
  if ($leaf -and (Test-Path -LiteralPath (Join-Path $runDirectory $leaf))) { $merged.Add($leaf) }
}

foreach ($leaf in ($ShardFiles -split ',')) {
  if ($merged -contains $leaf) { continue }
  $shardPath = Join-Path $runDirectory $leaf
  $shard = Get-Content -Raw -LiteralPath $shardPath | ConvertFrom-Json
  if ($shard.source -ne $Source) { throw "shard source mismatch: $leaf" }
  foreach ($receipt in @($shard.receipts)) { $receipts.Add($receipt) }
  if ($shard.PSObject.Properties.Name -contains 'blockedOffsets') {
    foreach ($offset in @($shard.blockedOffsets)) {
      if ($null -ne $offset) { $blocked.Add([int]$offset) }
    }
  }
  $merged.Add($leaf)
}

$blockedArray = @($blocked | Sort-Object -Unique)
$mergedArray = @($merged | Sort-Object -Unique)
$state.receipts = [object[]]$receipts.ToArray()
$state.offset = $FinalOffset
$state.checked = $FinalOffset - $blockedArray.Count
$state.status = 'complete'
$state | Add-Member -NotePropertyName completedAt -NotePropertyValue (Get-Date).ToString('o') -Force
$state | Add-Member -NotePropertyName totalTam -NotePropertyValue $TotalTam -Force
$state | Add-Member -NotePropertyName eligibleCount -NotePropertyValue $FinalOffset -Force
$state | Add-Member -NotePropertyName ineligibleCount -NotePropertyValue ($TotalTam - $FinalOffset) -Force
$state | Add-Member -NotePropertyName blockedOffsets -NotePropertyValue ([object[]]$blockedArray) -Force
$state | Add-Member -NotePropertyName mergedShardFiles -NotePropertyValue ([object[]]$mergedArray) -Force

$tmp = "$statePath.$PID.merge.tmp"
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp
[IO.File]::Copy($tmp, $statePath, $true)
[IO.File]::Delete($tmp)

[pscustomobject]@{
  source = $Source
  status = $state.status
  checked = $state.checked
  eligible = $FinalOffset
  ineligible = $TotalTam - $FinalOffset
  blocked = $blockedArray.Count
  merged_shards = $mergedArray.Count
} | ConvertTo-Json -Compress
