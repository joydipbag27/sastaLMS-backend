# veoLMS Manual Video Processing Guide

This document explains how to process and upload videos using the veoLMS manual low-cost media pipeline.

This pipeline is separate from the existing AWS MediaConvert pipeline.

The manual pipeline uses:

- FFmpeg for local video transcoding.
- HLS with 360p and 720p variants.
- PowerShell for running the reusable processing script.
- rclone for uploading processed HLS files to Backblaze B2.
- The veoLMS backend for creating Media metadata and verifying the final uploaded media.

The complete flow is:

```text
Verify local tools and B2 access
        ↓
Create Media metadata from frontend/backend
        ↓
Receive mediaId
        ↓
Put source video inside input/
        ↓
Run process-video.ps1
        ↓
Generate 360p HLS
        ↓
Generate 720p HLS
        ↓
Generate master playlist
        ↓
Upload playlists and segments to B2
        ↓
Verify upload with rclone
        ↓
Test HLS playback manually
        ↓
Call manual verification endpoint
        ↓
Backend verifies B2 output
        ↓
Backend calculates size + duration
        ↓
Backend verifies MIME types
        ↓
Media becomes READY
```

---

# 1. Required Folder Structure

Copy the complete `HLSconvert` folder to the local machine that will process the videos.

Expected structure:

```text
HLSconvert/
│
├── input/
│
├── output/
│
└── process-video.ps1
```

### `input/`

Place the original source video inside this folder.

Example:

```text
HLSconvert/
│
├── input/
│   └── indian_schools.webm
│
├── output/
│
└── process-video.ps1
```

### `output/`

Do not manually create media folders inside `output/`.

The processing script automatically creates:

```text
output/{mediaId}/
```

Example:

```text
output/
└── 6a4e4d09dd1f1573244fbcfa/
```

### `process-video.ps1`

This is the reusable PowerShell processing script.

The script:

1. Validates the input file.
2. Validates the Media ID.
3. Checks that FFmpeg is installed.
4. Checks that rclone is installed.
5. Creates the output directory.
6. Generates the 360p HLS rendition.
7. Generates the 720p HLS rendition.
8. Creates the master playlist.
9. Validates the generated local files.
10. Uploads `.m3u8` playlists with the correct MIME type.
11. Uploads `.ts` segments with the correct MIME type.
12. Verifies the B2 upload.
13. Reports success or failure.

---

# 2. Install FFmpeg

FFmpeg must be installed and available from PowerShell.

Check:

```powershell
ffmpeg -version
```

If the command prints the installed FFmpeg version, FFmpeg is ready.

If PowerShell reports that `ffmpeg` is not recognized, install FFmpeg and add it to the Windows `PATH`.

After installation, close and reopen PowerShell.

Run again:

```powershell
ffmpeg -version
```

Do not continue until this command works.

---

# 3. Install rclone

Check whether rclone is already installed:

```powershell
rclone version
```

If the command prints the installed rclone version, continue to the configuration section.

Otherwise, install rclone.

Official installation documentation:

https://rclone.org/install/

After installation, close and reopen PowerShell.

Verify:

```powershell
rclone version
```

---

# 4. Configure rclone

Check existing rclone remotes:

```powershell
rclone listremotes
```

The veoLMS B2 remote should appear:

```text
veolms-b2:
```

If `veolms-b2:` already exists, continue to the bucket access test.

If it does not exist, start rclone configuration:

```powershell
rclone config
```

Create a new remote.

Use:

```text
Remote name:

veolms-b2
```

Select Backblaze B2 as the storage provider.

Enter the Backblaze B2 credentials when requested.

Complete the configuration and save the remote.

Verify again:

```powershell
rclone listremotes
```

Expected:

```text
veolms-b2:
```

Do not store B2 credentials inside `process-video.ps1`.

---

# 5. Verify B2 Bucket Access

Before processing any video, verify that rclone can access the expected B2 bucket.

Run:

```powershell
rclone lsd "veolms-b2:veoLMS"
```

Expected output should contain:

```text
videos
```

You can also check the configured video destination:

```powershell
rclone lsf "veolms-b2:veoLMS/videos"
```

If these commands succeed, the rclone configuration and B2 access are working.

If they fail:

1. Run:

```powershell
rclone listremotes
```

2. Confirm the remote name.

3. Confirm the bucket name.

4. Confirm the B2 credentials.

5. Confirm that the credentials have permission to access the bucket.

The processing script currently contains:

```powershell
$B2Remote = "veolms-b2:veoLMS/videos"
```

If the remote name, bucket name, or destination prefix changes, update `$B2Remote` inside `process-video.ps1` before processing videos.

---

# 6. Create Manual Media Metadata

Open the veoLMS frontend and use the manual media creation flow.

The authenticated user must be an authorized:

```text
ADMIN
```

or:

```text
CREATOR
```

Create the Media metadata.

The backend creates the Media document and returns a Media ID.

Example:

```text
6a4e4d09dd1f1573244fbcfa
```

Copy the Media ID.

You will need it when running the processing script.

Do not process or upload the video before creating the Media metadata.

The backend Media document must exist before the B2 output is created.

---

# 7. Put the Source Video Inside the Input Folder

Copy the source video into:

```text
HLSconvert/input/
```

Example:

```text
HLSconvert/
│
├── input/
│   └── indian_schools.webm
│
├── output/
│
└── process-video.ps1
```

Copy or note the path of the input video.

Example absolute path:

```text
C:\Users\User\OneDrive\Desktop\HLSconvert\input\indian_schools.webm
```

You may also use the relative path:

```text
.\input\indian_schools.webm
```

---

# 8. Open PowerShell Inside HLSconvert

Open PowerShell.

Navigate to the `HLSconvert` folder:

```powershell
cd "C:\Users\User\OneDrive\Desktop\HLSconvert"
```

Verify the folder contents:

```powershell
Get-ChildItem
```

Expected:

```text
input
output
process-video.ps1
```

---

# 9. Unblock the PowerShell Script If Required

Windows may show a security warning when running the script.

If you trust and have inspected the local `process-video.ps1` file, unblock only this script:

```powershell
Unblock-File ".\process-video.ps1"
```

Do not change the machine-wide PowerShell execution policy unnecessarily.

---

# 10. Run the Processing Script

The script requires three values:

```text
InputFile

OutputRoot

MediaId
```

Example:

```powershell
.\process-video.ps1 -InputFile ".\input\indian_schools.webm" -OutputRoot ".\output" -MediaId "6a4e4d09dd1f1573244fbcfa"
```

You can also use absolute paths:

```powershell
.\process-video.ps1 -InputFile "C:\Users\User\OneDrive\Desktop\HLSconvert\input\indian_schools.webm" -OutputRoot "C:\Users\User\OneDrive\Desktop\HLSconvert\output" -MediaId "6a4e4d09dd1f1573244fbcfa"
```

The script executes the processing steps sequentially.

```text
Validate input
        ↓
Validate mediaId
        ↓
Check FFmpeg
        ↓
Check rclone
        ↓
Create output/{mediaId}/
        ↓
Generate 360p HLS
        ↓
Generate 720p HLS
        ↓
Create master playlist
        ↓
Validate local output
        ↓
Upload playlists to B2
        ↓
Upload segments to B2
        ↓
Verify remote upload
        ↓
Success
```

Do not close PowerShell while processing or uploading is in progress.

---

# 11. Expected Local Output

The script dynamically creates a folder using the Media ID.

Example:

```text
output/
└── 6a4e4d09dd1f1573244fbcfa/
    │
    ├── 6a4e4d09dd1f1573244fbcfa.m3u8
    │
    ├── 6a4e4d09dd1f1573244fbcfa_360p.m3u8
    ├── 6a4e4d09dd1f1573244fbcfa_360p_00001.ts
    ├── 6a4e4d09dd1f1573244fbcfa_360p_00002.ts
    ├── ...
    │
    ├── 6a4e4d09dd1f1573244fbcfa_720p.m3u8
    ├── 6a4e4d09dd1f1573244fbcfa_720p_00001.ts
    ├── 6a4e4d09dd1f1573244fbcfa_720p_00002.ts
    └── ...
```

The master playlist is:

```text
{mediaId}.m3u8
```

The 360p playlist is:

```text
{mediaId}_360p.m3u8
```

The 720p playlist is:

```text
{mediaId}_720p.m3u8
```

---

# 12. Expected B2 Output

The script uploads the processed output to:

```text
veoLMS/videos/{mediaId}/
```

Example:

```text
veoLMS/
└── videos/
    └── 6a4e4d09dd1f1573244fbcfa/
        │
        ├── 6a4e4d09dd1f1573244fbcfa.m3u8
        │
        ├── 6a4e4d09dd1f1573244fbcfa_360p.m3u8
        ├── 6a4e4d09dd1f1573244fbcfa_360p_00001.ts
        ├── ...
        │
        ├── 6a4e4d09dd1f1573244fbcfa_720p.m3u8
        ├── 6a4e4d09dd1f1573244fbcfa_720p_00001.ts
        └── ...
```

The processing script must upload:

```text
.m3u8 → application/vnd.apple.mpegurl
```

and:

```text
.ts → video/mp2t
```

The backend manual verification endpoint checks the B2 object MIME metadata.

Incorrect MIME types will cause verification to fail.

---

# 13. Verify the Uploaded Files Manually

The script already performs an rclone verification step.

You can additionally list the uploaded files:

```powershell
rclone ls "veolms-b2:veoLMS/videos/6a4e4d09dd1f1573244fbcfa"
```

Replace the example Media ID with the actual Media ID.

Verify that the output contains:

```text
{mediaId}.m3u8

{mediaId}_360p.m3u8

360p segments

{mediaId}_720p.m3u8

720p segments
```

---

# 14. Test HLS Playback

Before calling the backend manual verification endpoint, test the uploaded video through the normal veoLMS playback delivery path.

Confirm:

- The master playlist loads.
- The video starts playing.
- 360p playback works.
- 720p playback works.
- Seeking works.
- Playback does not stop because of missing segments.
- Quality switching works.

Do not call the verification endpoint if playback is broken.

Fix the upload or processing problem first.

---

# 15. Call the Manual Verification Endpoint

After successful playback testing, use the veoLMS frontend manual verification action.

The backend performs the authoritative verification.

The backend checks:

1. Authentication.

2. ADMIN or CREATOR authorization.

3. Creator ownership where required.

4. The Media belongs to the manual ingestion flow.

5. The master playlist exists.

6. The 360p playlist exists.

7. The 720p playlist exists.

8. Variant playlists contain segments.

9. Referenced segments exist in B2.

10. Playlist references are safe.

11. Playlist MIME types are correct.

12. Segment MIME types are correct.

13. Total B2 media folder size.

14. HLS duration from playlist `EXTINF` values.

Only after every verification step succeeds does the backend update the Media document and mark the media READY.

---

# 16. Failure Rules

## FFmpeg Failure

If either FFmpeg process fails:

```text
STOP
```

Do not upload the output.

Do not call the manual verification endpoint.

Inspect the FFmpeg error and retry after fixing the problem.

## Partial Local Output

If required playlists or segments are missing:

```text
STOP
```

Do not upload.

## rclone Upload Failure

If rclone reports an upload failure:

```text
STOP
```

Do not call the manual verification endpoint.

Determine whether the B2 destination contains a partial upload.

Clean up the failed B2 media folder manually if necessary before retrying.

## rclone Verification Failure

If the local and remote files do not match:

```text
STOP
```

Do not call the backend verification endpoint.

## MIME Verification Failure

If the backend reports:

```text
application/octet-stream
```

instead of the expected MIME type, confirm that the processing script uploads files using:

```text
.m3u8 → application/vnd.apple.mpegurl

.ts → video/mp2t
```

Delete the failed remote media folder if necessary and upload again with the correct metadata.

## Backend Verification Failure

If the backend verification endpoint fails:

```text
DO NOT MARK THE MEDIA READY MANUALLY
```

Read the backend error.

Fix the local processing or B2 output problem.

Retry verification only after the problem is resolved.

---

# 17. Retrying a Failed Media Processing Operation

Before retrying, check whether the local output directory already exists:

```text
output/{mediaId}/
```

The processing script intentionally prevents accidental overwriting of existing local output.

Check whether the B2 destination already contains files:

```powershell
rclone ls "veolms-b2:veoLMS/videos/{mediaId}"
```

Do not blindly overwrite or delete existing media.

Confirm that the Media ID belongs to the failed manual processing operation.

If cleanup is required, remove the failed local output directory.

Example:

```powershell
Remove-Item -LiteralPath ".\output\{mediaId}" -Recurse -Force
```

If remote cleanup is required, verify the Media ID carefully before deleting anything from B2.

---

# 18. Processing the Next Video

For each new video:

1. Create manual Media metadata from the frontend.

2. Copy the returned Media ID.

3. Put the source video inside `input/`.

4. Run:

```powershell
.\process-video.ps1 -InputFile ".\input\YOUR_VIDEO_FILE" -OutputRoot ".\output" -MediaId "YOUR_MEDIA_ID"
```

5. Wait for processing and upload to complete.

6. Test playback.

7. Call the manual verification endpoint.

8. Confirm that the Media becomes READY.

---

# Quick Reference

## Check FFmpeg

```powershell
ffmpeg -version
```

## Check rclone

```powershell
rclone version
```

## Check configured remotes

```powershell
rclone listremotes
```

## Check B2 bucket access

```powershell
rclone lsd "veolms-b2:veoLMS"
```

## Open the processing folder

```powershell
cd "C:\Users\User\OneDrive\Desktop\HLSconvert"
```

## Run the processing script

```powershell
.\process-video.ps1 -InputFile ".\input\YOUR_VIDEO_FILE" -OutputRoot ".\output" -MediaId "YOUR_MEDIA_ID"
```

## Check uploaded media

```powershell
rclone ls "veolms-b2:veoLMS/videos/YOUR_MEDIA_ID"
```

---

# Manual Pipeline Summary

```text
ONE-TIME SETUP

Copy HLSconvert/
        ↓
Install FFmpeg
        ↓
Install rclone
        ↓
Configure veolms-b2 remote
        ↓
Verify B2 bucket access


FOR EVERY VIDEO

Create Media metadata
        ↓
Copy mediaId
        ↓
Put source video in input/
        ↓
Run process-video.ps1
        ↓
Wait for FFmpeg processing
        ↓
Wait for rclone upload
        ↓
Verify successful script completion
        ↓
Test HLS playback
        ↓
Call manual verification endpoint
        ↓
Media READY
```