param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Acquire', 'Heartbeat', 'Release', 'Status')]
    [string]$Mode,

    [string]$OwnerId,

    [ValidateRange(5, 120)]
    [int]$LeaseMinutes = 60
)

$ErrorActionPreference = 'Stop'
$lockPath = Join-Path $PSScriptRoot 'browser-automation-run.lock.json'

function Read-Lock {
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try {
        return Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        throw 'Browser automation lock is unreadable; refusing browser work.'
    }
}

function New-Record([string]$Id, [string]$AcquiredAt) {
    $now = [DateTime]::UtcNow
    if ([string]::IsNullOrWhiteSpace($AcquiredAt)) {
        $AcquiredAt = $now.ToString('o')
    }
    return [ordered]@{
        schema_version = 1
        owner_id = $Id
        acquired_at_utc = $AcquiredAt
        heartbeat_at_utc = $now.ToString('o')
        expires_at_utc = $now.AddMinutes($LeaseMinutes).ToString('o')
    }
}

function Write-NewLock($Record) {
    $json = $Record | ConvertTo-Json -Depth 4 -Compress
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally { $stream.Dispose() }
}

function Write-OwnedLock($Record) {
    $tempPath = "$lockPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $Record | ConvertTo-Json -Depth 4 -Compress
        [IO.File]::WriteAllText($tempPath, $json, [Text.UTF8Encoding]::new($false))
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
                $record = New-Record -Id $OwnerId -AcquiredAt ''
                Write-NewLock -Record $record
                $record | ConvertTo-Json -Depth 4 -Compress
                exit 0
            }
            catch [System.IO.IOException] {
                $existing = Read-Lock
                if ($existing.owner_id -eq $OwnerId) {
                    $record = New-Record -Id $OwnerId -AcquiredAt $existing.acquired_at_utc
                    Write-OwnedLock -Record $record
                    $record | ConvertTo-Json -Depth 4 -Compress
                    exit 0
                }
                $expiry = [DateTime]::Parse($existing.expires_at_utc).ToUniversalTime()
                if ($expiry -gt [DateTime]::UtcNow) {
                    throw "BROWSER_LOCKED_BY:$($existing.owner_id):$($existing.expires_at_utc)"
                }
                Remove-Item -LiteralPath $lockPath -Force
            }
        }
        throw 'Unable to acquire browser automation lock.'
    }
    'Heartbeat' {
        $existing = Read-Lock
        if ($null -eq $existing -or $existing.owner_id -ne $OwnerId) {
            throw 'BROWSER_LOCK_NOT_OWNED'
        }
        $record = New-Record -Id $OwnerId -AcquiredAt $existing.acquired_at_utc
        Write-OwnedLock -Record $record
        $record | ConvertTo-Json -Depth 4 -Compress
    }
    'Release' {
        $existing = Read-Lock
        if ($null -eq $existing) {
            '{"released":true,"already_absent":true}'
            exit 0
        }
        if ($existing.owner_id -ne $OwnerId) {
            throw 'BROWSER_LOCK_NOT_OWNED'
        }
        Remove-Item -LiteralPath $lockPath -Force
        '{"released":true,"already_absent":false}'
    }
    'Status' {
        $existing = Read-Lock
        if ($null -eq $existing) { '{"locked":false}' }
        else {
            [ordered]@{
                locked = $true
                owner_id = $existing.owner_id
                acquired_at_utc = $existing.acquired_at_utc
                heartbeat_at_utc = $existing.heartbeat_at_utc
                expires_at_utc = $existing.expires_at_utc
            } | ConvertTo-Json -Depth 4 -Compress
        }
    }
}
