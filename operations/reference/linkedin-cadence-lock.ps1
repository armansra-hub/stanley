param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Acquire', 'Heartbeat', 'Release', 'Status')]
    [string]$Mode,

    [string]$OwnerId,

    [ValidateRange(5, 120)]
    [int]$LeaseMinutes = 30
)

$ErrorActionPreference = 'Stop'
$lockPath = Join-Path $PSScriptRoot 'linkedin-cadence-run.lock.json'

function Read-Lock {
    if (-not (Test-Path -LiteralPath $lockPath)) {
        return $null
    }
    try {
    return Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "LinkedIn cadence lock is unreadable; refusing external action."
    }
}

function New-LockRecord {
    param([string]$Id)
    $now = [DateTime]::UtcNow
    return [ordered]@{
        schema_version = 1
        owner_id = $Id
        acquired_at_utc = $now.ToString('o')
        heartbeat_at_utc = $now.ToString('o')
        expires_at_utc = $now.AddMinutes($LeaseMinutes).ToString('o')
    }
}

function Write-NewLock {
    param($Record)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Depth 5))
    $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally {
        $stream.Dispose()
    }
}

function Write-OwnedLock {
    param($Record)
    $tempPath = "$lockPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($tempPath, ($Record | ConvertTo-Json -Depth 5), [Text.Encoding]::UTF8)
        Move-Item -LiteralPath $tempPath -Destination $lockPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force
        }
    }
}

if ($Mode -ne 'Status' -and [string]::IsNullOrWhiteSpace($OwnerId)) {
    throw 'OwnerId is required for Acquire, Heartbeat, and Release.'
}

switch ($Mode) {
    'Acquire' {
        for ($attempt = 0; $attempt -lt 2; $attempt++) {
            try {
                $record = New-LockRecord -Id $OwnerId
                Write-NewLock -Record $record
                $record | ConvertTo-Json -Depth 5
                exit 0
            }
            catch [System.IO.IOException] {
                $existing = Read-Lock
                if ($existing.owner_id -eq $OwnerId) {
                    $record = New-LockRecord -Id $OwnerId
                    $record.acquired_at_utc = $existing.acquired_at_utc
                    Write-OwnedLock -Record $record
                    $record | ConvertTo-Json -Depth 5
                    exit 0
                }
                $expiry = [DateTime]::Parse($existing.expires_at_utc).ToUniversalTime()
                if ($expiry -gt [DateTime]::UtcNow) {
                    throw "LOCKED_BY_OTHER:$($existing.owner_id):$($existing.expires_at_utc)"
                }
                Remove-Item -LiteralPath $lockPath -Force
            }
        }
        throw 'Unable to acquire LinkedIn cadence lock.'
    }
    'Heartbeat' {
        $existing = Read-Lock
        if ($null -eq $existing -or $existing.owner_id -ne $OwnerId) {
            throw 'LOCK_NOT_OWNED'
        }
        $now = [DateTime]::UtcNow
        $existing.heartbeat_at_utc = $now.ToString('o')
        $existing.expires_at_utc = $now.AddMinutes($LeaseMinutes).ToString('o')
        Write-OwnedLock -Record $existing
        $existing | ConvertTo-Json -Depth 5
    }
    'Release' {
        $existing = Read-Lock
        if ($null -eq $existing) {
            '{"released":true,"already_absent":true}'
            exit 0
        }
        if ($existing.owner_id -ne $OwnerId) {
            throw 'LOCK_NOT_OWNED'
        }
        Remove-Item -LiteralPath $lockPath -Force
        '{"released":true,"already_absent":false}'
    }
    'Status' {
        $existing = Read-Lock
        if ($null -eq $existing) {
            '{"locked":false}'
        }
        else {
            $existing | Add-Member -NotePropertyName locked -NotePropertyValue $true -PassThru |
                ConvertTo-Json -Depth 5
        }
    }
}
