# SastaLMS Media Processing & Streaming Pipeline

**Version:** 3.0\
**Purpose:** Explain the complete video pipeline from upload to playback
in simple English.

------------------------------------------------------------------------

# 1. Introduction

The media pipeline is responsible for converting a creator's uploaded
video into a secure HLS stream that students can watch.

The design has four goals:

-   Secure playback
-   Adaptive streaming
-   Low operating cost
-   Reliable file transfer

------------------------------------------------------------------------

# 2. Big Picture

### Option A: AWS MediaConvert Pipeline (Transcoded automatically via AWS)
``` text
Creator
   │
   ▼
Upload Video
   │
   ▼
AWS S3 (Input)
   │
   ▼
AWS MediaConvert
   │
   ▼
AWS S3 (Output)
   │
   ▼
EventBridge
   │
   ▼
Lambda
   │
   ▼
Backend (rclone copy to B2)
   │
   ▼
Backblaze B2 (Private)
   │
   ▼
Cloudflare Worker (Verification & Delivery)
   │
   ▼
Worker Cache
   │
   ▼
HLS.js Player
```

### Option B: Manual Ingestion Pipeline (Processed locally, bypassing AWS)
``` text
Creator
   │
   ▼
Create Manual Media Metadata (POST /media/manual)
   │
   ▼
Transcode locally (FFmpeg HLS 360p + 720p)
   │
   ▼
Upload directory to Backblaze B2 (using rclone)
   │
   ▼
Verify B2 Media (POST /media/manual/:mediaId/verify)
   │
   ▼
Backblaze B2 (Private)
   │
   ▼
Cloudflare Worker (Delivery)
   │
   ▼
Worker Cache
   │
   ▼
HLS.js Player
```

------------------------------------------------------------------------

# 3. Upload Phase (AWS Pipeline Only)

## Why direct upload?

Instead of sending large video files through the backend, the backend
generates a presigned upload URL.

``` text
Creator
   │
   ▼
Request Upload URL
   │
   ▼
Backend
   │
   Generate Presigned URL
   │
   ▼
Upload directly to S3
```

Benefits:

-   Faster uploads
-   Lower backend bandwidth
-   Better scalability

After upload, the backend verifies that the file really exists before
continuing.

------------------------------------------------------------------------

# 4. MediaConvert (AWS Pipeline Only)

MediaConvert converts one uploaded video into an HLS package.

Current renditions:

-   360p
-   720p

Generated files:

``` text
master.m3u8

360p.m3u8

720p.m3u8

segment00001.ts
segment00002.ts
...
```

Only two renditions are used because lecture videos do not require many
quality levels.

This reduces processing cost considerably.

------------------------------------------------------------------------

# 5. Event Driven Processing (AWS Pipeline Only)

The backend never polls MediaConvert.

Instead AWS notifies us automatically.

``` text
MediaConvert
      │
      ▼
EventBridge
      │
      ▼
Lambda
      │
      ▼
Backend Callback
```

This is called an event-driven architecture.

------------------------------------------------------------------------

# 6. Copy Pipeline (AWS Pipeline Only)

MediaConvert stores generated files inside an S3 output bucket.

Those files are temporary.

``` text
S3 Output
     │
     ▼
rclone
     │
     ▼
Private Backblaze B2
```

## Why rclone?

Initially the AWS SDK copied files.

Problems:

-   Slow
-   Hundreds of small files
-   Retry problems

rclone already solves these problems by providing:

-   Parallel transfers
-   Automatic retries
-   Better throughput

------------------------------------------------------------------------

# 7. Fault Tolerance (AWS Pipeline Only)

``` text
Copy Files
    │
    ▼
Success?
 ┌──┴──┐
 │     │
 Yes   No
 │     │
 ▼     ▼
READY Retry
          │
     Still Fail?
          │
     ┌────┴────┐
     │         │
    Yes       No
     │         │
COPY_PENDING READY
```

Only failed files are retried.

MediaConvert is never executed again because of transfer failures.

------------------------------------------------------------------------

# 8. Verification & Metadata Ingestion

Before marking media as playable, the backend verifies B2 presence.

### AWS Pipeline Verification
- Confirms `rclone` finishes uploading all files.
- Lists all B2 objects under `videos/{mediaId}/`.
- Confirms the master playlist file `videos/{mediaId}/{mediaId}.m3u8` exists and has Content-Type `application/vnd.apple.mpegurl`.
- Calculates total folder size dynamically by summing up sizes of all listed objects in B2.
- Calculates duration from the S3 playlist.
- Atomically updates Media status to `READY`, size, duration, and mimeType to `application/vnd.apple.mpegurl`.
- Cleans up temporary files in S3.

### Manual Pipeline Verification
- Confirms playlists exist (`{mediaId}.m3u8`, `{mediaId}_360p.m3u8`, `{mediaId}_720p.m3u8`).
- Fetches playlists and verifies structure (segments exist, valid `EXTINF` duration entries).
- Rejects any external, absolute, or traversing path references.
- Validates the Content-Type of playlists (`application/vnd.apple.mpegurl`) and segments (`video/mp2t`) on B2.
- Calculates folder size dynamically by summing all object sizes under the prefix.
- Calculates duration from the 720p HLS variant.
- Updates Media status to `READY`, size, duration, and mimeType to `application/vnd.apple.mpegurl`.

------------------------------------------------------------------------

# 9. Playback Flow

``` text
Student
   │
   ▼
Request Lesson
   │
   ▼
Backend
   │
Check:
- Login
- Enrollment
- Published
- Video Ready
   │
   ▼
Generate Playback Token
   │
   ▼
Return master.m3u8 URL
```

------------------------------------------------------------------------

# 10. Playback Token

The playback token contains:

-   userId
-   courseId
-   mediaId
-   expiry

The backend signs it using HMAC.

Example:

``` text
https://media.example.com/videos/{mediaId}/master.m3u8?token=...
```

------------------------------------------------------------------------

# 11. Cloudflare Worker

The Worker is responsible only for secure media delivery.

``` text
Incoming Request
       │
       ▼
Validate Route
       │
       ▼
Validate Extension
       │
       ▼
Verify Token
       │
       ▼
Fetch Private B2 Object
       │
       ▼
Return Response
```

Allowed:

-   /videos/\*
-   .m3u8
-   .ts

Everything else returns 404 immediately.

------------------------------------------------------------------------

# 12. Manifest Rewriting

MediaConvert creates playlists like:

``` text
segment00001.ts
segment00002.ts
```

Worker rewrites them into:

``` text
segment00001.ts?token=...
segment00002.ts?token=...
```

Now every segment request remains authenticated.

------------------------------------------------------------------------

# 13. Worker Cache

``` text
Segment Request
      │
      ▼
Cache Match?
 ┌────┴────┐
 │         │
 HIT       MISS
 │         │
 ▼         ▼
Return   Fetch B2
            │
            ▼
        cache.put()
            │
            ▼
         Return
```

Benefits:

-   Lower latency
-   Lower B2 bandwidth
-   Faster playback

------------------------------------------------------------------------

# 14. Adaptive Streaming

Frontend loads only:

master.m3u8

HLS.js automatically chooses:

-   360p
-   720p

and switches quality when network conditions change.

No backend logic is needed.

------------------------------------------------------------------------

# 15. Security Layers

1.  Route allow-list
2.  Extension allow-list
3.  Playback token
4.  Expiry validation
5.  mediaId validation
6.  Private B2 bucket

------------------------------------------------------------------------

# 16. Media State Machine

``` text
UPLOADING / PROCESSING (Pending state)
     │
     ▼
READY (Verified and playable)
```

Failure / Retries (AWS Only):

``` text
COPY_PENDING / FAILED
```

------------------------------------------------------------------------

# 17. Cost Optimizations

-   Option for Manual local transcoding and upload to Backblaze B2, avoiding AWS compute costs.
-   Only two HLS renditions.
-   Backblaze B2 for low-cost storage.
-   Cloudflare Worker for secure delivery.
-   Worker Cache for repeated requests.
-   rclone for reliable transfers.
-   Retry failed copies instead of rerunning MediaConvert.

------------------------------------------------------------------------

# 18. Technologies

-   Node.js
-   Express
-   MongoDB (Mongoose)
-   AWS S3 & MediaConvert
-   EventBridge & Lambda
-   rclone
-   Backblaze B2
-   Cloudflare Workers
-   HLS.js
-   FFmpeg

------------------------------------------------------------------------

# 19. Lessons Learned

-   Upload directly to S3 or B2.
-   Keep the bucket private.
-   Verify files before deleting S3 originals.
-   Never rerun MediaConvert for copy failures.
-   Cache immutable video segments.
-   Keep the Worker focused on media delivery only.

------------------------------------------------------------------------

# Conclusion

The SastaLMS media pipeline provides two ingestion paths—automated AWS MediaConvert and low-cost manual FFmpeg+rclone—converging at the same Backblaze B2 storage structure and Cloudflare Worker playback flow. This ensures cost-efficiency, flexibility, and architectural clean separation.
