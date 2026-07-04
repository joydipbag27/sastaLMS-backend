# veoLMS Media Processing & Streaming Pipeline

**Version:** 2.0\
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
Backend
   │
   ▼
rclone
   │
   ▼
Backblaze B2 (Private)
   │
   ▼
Cloudflare Worker
   │
   ▼
Worker Cache
   │
   ▼
HLS.js Player
```

Every box has only one responsibility.

------------------------------------------------------------------------

# 3. Upload Phase

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

# 4. MediaConvert

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

# 5. Event Driven Processing

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

# 6. Copy Pipeline

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

# 7. Fault Tolerance

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

# 8. Verification

Before deleting S3 files the backend verifies that every expected object
exists in Backblaze B2.

Only then:

-   Delete S3 Output
-   Delete original upload
-   Mark media READY

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
UPLOADING
    │
    ▼
PROCESSING
    │
    ▼
COPYING
    │
    ▼
READY
```

Failure:

``` text
COPY_PENDING
```

------------------------------------------------------------------------

# 17. Cost Optimizations

-   Only two renditions.
-   Backblaze B2 for low-cost storage.
-   Cloudflare Worker for secure delivery.
-   Worker Cache for repeated requests.
-   rclone for reliable transfers.
-   Retry failed copies instead of rerunning MediaConvert.

------------------------------------------------------------------------

# 18. Technologies

-   Node.js
-   Express
-   MongoDB
-   AWS S3
-   MediaConvert
-   EventBridge
-   Lambda
-   rclone
-   Backblaze B2
-   Cloudflare Workers
-   HLS.js

------------------------------------------------------------------------

# 19. Lessons Learned

-   Upload directly to S3.
-   Keep the bucket private.
-   Verify files before deleting originals.
-   Never rerun MediaConvert for copy failures.
-   Cache immutable video segments.
-   Keep the Worker focused on media delivery only.

------------------------------------------------------------------------

# 20. Future Improvements

-   DRM
-   Subtitles
-   Analytics
-   Progress tracking
-   Multi-audio
-   Thumbnail CDN

------------------------------------------------------------------------

# Conclusion

The veoLMS media pipeline combines AWS processing, Backblaze storage,
Cloudflare edge delivery and HLS streaming into a secure, reliable and
cost-optimized system. Each component has a single responsibility,
making the architecture easier to understand, maintain and extend.
