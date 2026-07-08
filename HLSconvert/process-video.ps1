param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,

    [Parameter(Mandatory = $true)]
    [string]$MediaId
)

$ErrorActionPreference = "Stop"

$B2Remote = "veolms-b2:veoLMS/videos"

$OutputDirectory = Join-Path $OutputRoot $MediaId


# ============================================================
# VALIDATION
# ============================================================

if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
    Write-Host "Input file does not exist:"
    Write-Host $InputFile
    exit 1
}

if ([string]::IsNullOrWhiteSpace($MediaId)) {
    Write-Host "MediaId is required."
    exit 1
}

# MongoDB ObjectId validation
if ($MediaId -notmatch '^[a-fA-F0-9]{24}$') {
    Write-Host "Invalid MediaId. Expected a 24-character MongoDB ObjectId."
    exit 1
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "FFmpeg is not available."
    exit 1
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    Write-Host "rclone is not available."
    exit 1
}


# ============================================================
# PREVENT ACCIDENTAL OVERWRITE
# ============================================================

if (Test-Path -LiteralPath $OutputDirectory) {
    Write-Host "Output directory already exists:"
    Write-Host $OutputDirectory
    Write-Host "Delete it manually before retrying."
    exit 1
}


# ============================================================
# CREATE OUTPUT DIRECTORY
# ============================================================

New-Item `
    -ItemType Directory `
    -Path $OutputDirectory `
    -Force | Out-Null

Write-Host ""
Write-Host "Media ID: $MediaId"
Write-Host "Input: $InputFile"
Write-Host "Output: $OutputDirectory"
Write-Host ""


# ============================================================
# 360P TRANSCODING
# ============================================================

Write-Host "Starting 360p transcoding..."

& ffmpeg `
    -y `
    -i $InputFile `
    -vf "scale=-2:360" `
    -c:v libx264 `
    -preset fast `
    -b:v 600k `
    -maxrate 700k `
    -bufsize 1200k `
    -c:a aac `
    -b:a 96k `
    -force_key_frames "expr:gte(t,n_forced*6)" `
    -f hls `
    -hls_time 6 `
    -hls_playlist_type vod `
    -start_number 1 `
    -hls_segment_filename "$OutputDirectory\${MediaId}_360p_%05d.ts" `
    "$OutputDirectory\${MediaId}_360p.m3u8"

if ($LASTEXITCODE -ne 0) {
    Write-Host "360p transcoding failed."
    exit 1
}


# ============================================================
# 720P TRANSCODING
# ============================================================

Write-Host "Starting 720p transcoding..."

& ffmpeg `
    -y `
    -i $InputFile `
    -vf "scale=-2:720" `
    -c:v libx264 `
    -preset fast `
    -b:v 2500k `
    -maxrate 2800k `
    -bufsize 5000k `
    -c:a aac `
    -b:a 128k `
    -force_key_frames "expr:gte(t,n_forced*6)" `
    -f hls `
    -hls_time 6 `
    -hls_playlist_type vod `
    -start_number 1 `
    -hls_segment_filename "$OutputDirectory\${MediaId}_720p_%05d.ts" `
    "$OutputDirectory\${MediaId}_720p.m3u8"

if ($LASTEXITCODE -ne 0) {
    Write-Host "720p transcoding failed."
    exit 1
}


# ============================================================
# CREATE MASTER PLAYLIST
# ============================================================

Write-Host "Creating master playlist..."

$MasterPlaylist = @"
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=750000,RESOLUTION=640x360
${MediaId}_360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
${MediaId}_720p.m3u8
"@

$MasterPlaylist |
    Set-Content `
        -Encoding ascii `
        "$OutputDirectory\${MediaId}.m3u8"


# ============================================================
# LOCAL VALIDATION
# ============================================================

$RequiredFiles = @(
    "$OutputDirectory\${MediaId}.m3u8",
    "$OutputDirectory\${MediaId}_360p.m3u8",
    "$OutputDirectory\${MediaId}_720p.m3u8"
)

foreach ($File in $RequiredFiles) {

    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        Write-Host "Required file missing:"
        Write-Host $File
        exit 1
    }
}

$Segments360 = @(
    Get-ChildItem `
        -LiteralPath $OutputDirectory `
        -Filter "${MediaId}_360p_*.ts"
)

$Segments720 = @(
    Get-ChildItem `
        -LiteralPath $OutputDirectory `
        -Filter "${MediaId}_720p_*.ts"
)

if ($Segments360.Count -eq 0) {
    Write-Host "No 360p segments generated."
    exit 1
}

if ($Segments720.Count -eq 0) {
    Write-Host "No 720p segments generated."
    exit 1
}

Write-Host "Local validation passed."


# ============================================================
# B2 DESTINATION
# ============================================================

$B2Destination = "$B2Remote/$MediaId"


# ============================================================
# PREVENT ACCIDENTAL REMOTE OVERWRITE
# ============================================================

$ExistingRemoteFiles = & rclone lsf $B2Destination 2>$null

if ($LASTEXITCODE -eq 0 -and $ExistingRemoteFiles) {
    Write-Host "B2 destination already contains files:"
    Write-Host $B2Destination
    Write-Host "Upload aborted."
    exit 1
}


# ============================================================
# RCLONE UPLOAD
# ============================================================

Write-Host "Uploading to B2..."

& rclone copy `
    $OutputDirectory `
    $B2Destination `
    --include "*.m3u8" `
    --header-upload "Content-Type: application/vnd.apple.mpegurl" `
    --progress `
    --transfers 8 `
    --checkers 16

if ($LASTEXITCODE -ne 0) {
    Write-Host "B2 playlist upload failed."
    exit 1
}

& rclone copy `
    $OutputDirectory `
    $B2Destination `
    --include "*.ts" `
    --header-upload "Content-Type: video/mp2t" `
    --progress `
    --transfers 8 `
    --checkers 16

if ($LASTEXITCODE -ne 0) {
    Write-Host "B2 segment upload failed."
    exit 1
}


# ============================================================
# VERIFY REMOTE UPLOAD
# ============================================================

Write-Host "Verifying B2 upload..."

& rclone check `
    $OutputDirectory `
    $B2Destination `
    --one-way

if ($LASTEXITCODE -ne 0) {
    Write-Host "B2 verification failed."
    exit 1
}


# ============================================================
# SUCCESS
# ============================================================

Write-Host ""
Write-Host "=========================================="
Write-Host "PROCESSING COMPLETED SUCCESSFULLY"
Write-Host "=========================================="
Write-Host ""
Write-Host "Media ID: $MediaId"
Write-Host "Local output: $OutputDirectory"
Write-Host "B2 destination: $B2Destination"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Test HLS playback manually."
Write-Host "2. Call the manual verification endpoint."
Write-Host ""