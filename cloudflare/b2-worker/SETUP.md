# Cloudflare Worker Setup (veoLMS)

## Overview

The Cloudflare Worker acts as a secure proxy between the client and the private Backblaze B2 bucket.

Without the worker:

```text
Client
   │
   ▼
Private B2 ❌ (Access Denied)
```

With the worker:

```text
Client
   │
   ▼
Cloudflare Worker
   │
   ▼
Private Backblaze B2 ✅
```

The worker authenticates every request to Backblaze B2 using the B2 Application Key and streams the requested object back to the client.

---

# Why We Use a Worker

Our Backblaze B2 bucket is private.

A private bucket cannot be accessed directly from the browser.

Instead of exposing the bucket publicly, every request goes through the Cloudflare Worker.

Benefits:

- Private bucket remains private.
- Backblaze credentials are never exposed to the browser.
- Cloudflare can cache media.
- Future playback authentication can be implemented without changing the player.

---

# Initial Setup

The worker was created using Backblaze's official Cloudflare Worker template.

Repository:

https://github.com/backblaze-b2-samples/cloudflare-b2

Commands used:

```bash
wrangler generate b2-worker https://github.com/backblaze-b2-samples/cloudflare-b2

cd b2-worker

npm install
```

---

# Wrangler Configuration

Update `wrangler.toml`

```toml
[vars]
B2_APPLICATION_KEY_ID = ""
B2_ENDPOINT = ""
BUCKET_NAME = "veoLMS"
ALLOW_LIST_BUCKET = "false"
```

### Configuration

| Variable                | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `B2_APPLICATION_KEY_ID` | Backblaze Application Key ID                            |
| `B2_ENDPOINT`           | Backblaze S3 Endpoint                                   |
| `BUCKET_NAME`           | Private Backblaze bucket                                |
| `ALLOW_LIST_BUCKET`     | Disabled because listing bucket contents is unnecessary |

---

# Secrets

Never store the Backblaze Application Key inside `wrangler.toml`.

Instead configure it as a Cloudflare Secret.

Cloudflare Dashboard

```
Workers & Pages
    ↓
b2-worker
    ↓
Settings
    ↓
Variables & Secrets
```

Create:

```
B2_APPLICATION_KEY
```

---

# Bucket Configuration

Bucket Visibility

```
Private
```

Bucket Info

```json
{
  "Cache-Control": "public"
}
```

This allows Cloudflare to cache responses while the bucket remains private.

---

# Deploy

Deploy the worker:

```bash
npx wrangler deploy
```

Worker URL:

```
https://<worker-name>.<subdomain>.workers.dev
```

Development URL:

```
https://b2-worker.joydipbag27.workers.dev
```

---

# Request Flow

```text
Browser
    │
    ▼
Cloudflare Worker
    │
Signs request using B2 credentials
    │
    ▼
Private Backblaze B2
    │
Streams requested object
    │
    ▼
Browser
```

---

# Current Responsibilities

The worker currently:

- Receives requests
- Authenticates with Backblaze B2
- Fetches requested objects
- Streams objects back to the browser

Currently supported:

- Images
- Videos
- HLS Playlists (`.m3u8`)
- HLS Segments (`.ts`)

---

# Current Media Pipeline

```text
Creator Upload
        │
        ▼
AWS S3 Input Bucket
        │
        ▼
MediaConvert
        │
        ▼
AWS S3 Output Bucket (HLS)
        │
        ▼
Backend Callback
        │
Copy HLS to Backblaze B2
        │
Delete Temporary S3 Files
        │
        ▼
Private Backblaze B2
        │
        ▼
Cloudflare Worker
        │
        ▼
Student
```

---

# Future Responsibilities

The worker will eventually become the secure media delivery layer.

Future features:

- Playback authentication
- Enrollment verification
- Signed playback tokens
- Cache optimization
- Rate limiting (if required)

Future playback flow:

```text
Student
      │
      ▼
Backend
      │
Verify Login
Verify Enrollment
      │
Generate Playback Token
      │
      ▼
Cloudflare Worker
      │
Validate Token
      │
      ▼
Private Backblaze B2
      │
      ▼
HLS.js Player
```

---

# Important Notes

- Never expose the Backblaze Application Key.
- Never make the production bucket public.
- The worker is only responsible for media delivery.
- Uploading, transcoding and processing remain backend responsibilities.
- Keep the worker lightweight and stateless.

---

# References

Backblaze Official Worker Template

https://github.com/backblaze-b2-samples/cloudflare-b2

Backblaze Documentation

https://www.backblaze.com/docs/cloud-storage-deliver-private-backblaze-b2-content-through-cloudflare-cdn
