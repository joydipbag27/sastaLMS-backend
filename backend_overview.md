# SastaLMS — Backend Overview

A comprehensive reference for the features, architecture, middleware pipeline, data models, and API routes of the SastaLMS backend.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM / `"type": "module"`) |
| Framework | Express.js v5 |
| Database | MongoDB via Mongoose v8 |
| Session Store | Redis (JSON + FT Search index) |
| File Storage | Backblaze B2 (S3-compatible) & AWS S3 via `@aws-sdk/client-s3` |
| Payments | Razorpay API |
| Validation | Zod v4 |
| Auth | Cookie-based signed sessions |
| Email | Resend |
| Security | Helmet, CORS, express-rate-limit, bcryptjs |

---

## Features

### 🔐 Authentication & Session Management
- **Register** — Email + username + password. Password hashed with bcryptjs.
- **Login** — Validates credentials, creates a signed session in Redis, sets a signed `sid` cookie.
- **Google OAuth** — Login / register via Google ID token (`google-auth-library`).
- **OTP Verification** — Send and verify a one-time password for email verification or 2FA flows.
- **Logout** — Deletes the current device session from Redis.
- **Logout All Devices** — Deletes all sessions for a user from Redis using the `userIdIndex` FT search index.
- **Forgot Password** — Sends a reset OTP via Resend email service.
- **Change Password** — Authenticated users can change their existing password.
- **Set Password** — Allows users who signed up via Google (no password) to set one.

### 👤 Role-Based Access Control (RBAC)
Two roles are defined in `config/roles.js`:

| Role | Capabilities |
|---|---|
| `STUDENT` | Enroll in courses, access allowed lessons, purchase courses |
| `CREATOR` | All STUDENT abilities + create/manage their own courses, sections, lessons, uploads + user management and manual processing triggers |

**Creator operations (gated by `CREATOR` role):**
- View all users (paginated)
- Check a specific user's session status
- Force-logout any user's session
- Block / Unblock users
- Promote a student to creator
- Permanently delete a user account

### 📚 LMS Content Management

#### Courses
- Full CRUD for courses.
- Courses have a `status` of `Draft` or `Published`.
- **Dedicated publish/unpublish endpoints** (`PATCH /course/:id/publish` and `PATCH /course/:id/unpublish`) separate status management from general course updates.
- **Publishing validations**: A course can only be published if it has ≥1 section, every section has ≥1 lesson, and every lesson has a video attached.
- The general update endpoint (`PATCH /course/:id`) cannot change `status` — it is excluded from the update schema.
- `GET /course/creator/me` supports `?status=Draft`, `?status=Published`, or `?status=All` to fetch all in a single call.
- All list endpoints support cursor-based pagination (`?cursor=<id>&limit=<n>`).
- Cascading delete: deleting a course also deletes all its sections, lessons, progress records, and associated media from B2/S3.
- **Course Statistics**: Courses automatically maintain counters for `stats.sectionCount` and `stats.lessonCount`.

#### Sections
- Scoped to a course. Ordered by `order` field.
- **Order validation**: Duplicate `order` values within the same course are rejected (`409 Conflict`) at both the controller level and the DB level (compound unique index on `{ course, order }`).
- Cascading delete: deleting a section also deletes all its lessons and progress records.

#### Lessons
- Scoped to a section (and course). Ordered by `order` field.
- **Order validation**: Duplicate `order` values within the same section are rejected (`409 Conflict`) at both the controller level and the DB level (compound unique index on `{ section, order }`).
- `isPreview` flag marks a lesson as accessible to any authenticated user without enrollment.

### 🎟️ Enrollment System
- Students can enroll in any `Published` course (either directly if price is 0, or automated via successful Razorpay checkout).
- **Business rules enforced:**
  - User must be authenticated.
  - Course must exist and be `Published` (not `Draft`).
  - The course creator cannot enroll in their own course.
  - A user can only enroll once (compound unique index on `{ user, course }`).
- Enrollment status: `Active` or `Completed`.

### 💳 Razorpay Payment Integration
- **Order Creation**: Authenticated users can create a payment order for a course via `POST /payment/order`.
- **Webhook Processing**: Secure Razorpay webhook route `POST /payment/webhook` validates signatures and automatically enrolls students upon successful completion of payment (`payment.captured` / `order.paid`).

### 📈 Lesson Progress Tracking
- Saves the completion status, last playback position, max position reached, and total duration watched per student per lesson via `GET/PATCH /lesson/:id/progress`.
- Progress is automatically cleaned up when associated lessons or enrollments are deleted.

### 🔒 Lesson and Media Access Control
Lesson and course resource access is determined by strict middleware and controller logic. The authorization hierarchy and rules are:

#### 1. General Access Rules
- **Creator Access**: The course creator always retains full access to manage and read their own courses, sections, lessons, and media files, regardless of whether the course `status` is `Draft` or `Published`.
- **Draft Restriction**: All course metadata, sections, lesson metadata, and media of a `Draft` course are entirely private to the creator. Non-creators (including enrolled students) will be blocked with a `403 Forbidden` error.
- **Temporary Lock (Draft State)**: If a creator changes a published course back to `Draft`, existing enrollments are preserved, but students temporarily lose all access to read the course, sections, lessons, or media. Access is restored once the course is published again.

#### 2. Media Playback Authorization
Media playback and token generation are authorized under the following conditions:
- The requester is the course creator.
- **OR** The requester is **authenticated**, the parent course `status` is `Published` **AND** one of:
  - The lesson is marked as a preview lesson (`isPreview === true`).
  - The user has an `Active` enrollment in the course.

Unauthenticated guest users cannot watch any media (neither preview nor normal lessons).

#### 3. Metadata Omission (Media ID Stripping)
To prevent unauthorized media downloads, the media ID (`video` field) is omitted/stripped from the lesson metadata payloads returned in `GET /course/:id/details` and `GET /lesson/section/:sectionId` unless the user meets the media playback authorization rules above.

---

### 🖼️ Media Management & Processing Pipelines
- **Media** is a standalone, reusable module that tracks uploaded-file metadata. Business models (Course, Lesson) reference Media documents.
- **B2 / S3 Keys**: Uploads are partitioned based on their type (e.g. course thumbnails, trailers, and lesson videos).
- **Upload pipelines**:
  - **AWS S3 Lesson Upload**: `POST /media/s3/lesson/:lessonId/upload-url` returns a presigned PUT URL for direct client upload to the landing S3 bucket. After uploading, `POST /media/s3/lesson/:lessonId/confirm` verifies the file using `HeadObjectCommand` and starts the transcoding pipeline.
  - **Manual Video Ingestion**: `POST /media/manual` creates a custom Media document for manually processed HLS/dash files. `POST /media/manual/:mediaId/verify` verifies manually prepared outputs.
  - **Course Thumbnail/Trailer**: Dedicated presigned upload and confirm endpoints exist under course controller scopes (`POST /course/:id/thumbnail/upload-url`, `POST /course/:id/trailer/upload-url`).
- **Robust Verification**: When confirming, the backend queries the storage provider to verify the file exists and that its size/mimeType matches expectations.
- **Robust Cleanup / Version Deletion**: Handles versioned objects and delete markers on B2/S3 during media deletion.
- **COPY_PENDING Recovery**: Creator-restricted endpoint `POST /media/:id/retry-transfer` allows retrying file syncs to Backblaze B2 using custom rclone script logging.

---

## Connections

| Service | Purpose | Config File |
|---|---|---|
| **MongoDB** | Primary database (users, courses, sections, lessons, media, OTPs, enrollments, payments, lesson progress) | `config/db.js` |
| **Redis** | Session storage, FT search index for logout-all-devices | `config/redis.js`, `config/redisSetup.js` |
| **Backblaze B2** | S3-compatible object storage for production course media delivery | `config/s3Client.js` |
| **AWS S3** | Ingestion, transcoding, and thumbnail/trailer storage bucket | `config/s3Client.js` |
| **Resend** | Transactional email (OTPs, password resets) | Used in `authController.js` / `userController.js` |
| **Google OAuth** | Third-party login via ID token validation | Used in `authController.js` |
| **Razorpay** | Payment processing and checkout validation | Used in `paymentController.js` |

---

## Data Models

### `User`
| Field | Type | Notes |
|---|---|---|
| `username` | String | 3–100 chars, required |
| `email` | String | Validated format (no unique constraint at schema level) |
| `password` | String | Optional (Google users may not have one) |
| `rootDirId` | ObjectId | Optional, internal use |
| `role` | String | `STUDENT` \| `CREATOR`, default `STUDENT` |
| `isBlocked` | Boolean | Default `false` |

### `Course`
| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `displayName` | String | Optional display-friendly title |
| `description` | String | Required |
| `creator` | ObjectId → User | Required |
| `thumbnail` | ObjectId → Media | References course thumbnail Media asset |
| `trailer` | ObjectId → Media | References course trailer Media asset |
| `price` | Number | Default `0` |
| `level` | String | `Beginner` \| `Intermediate` \| `Advanced` |
| `status` | String | `Draft` \| `Published`, default `Draft` |
| `stats` | Object | Nested fields: `sectionCount`, `lessonCount` |

> Virtual fields: `thumbnailUrl`, `trailerUrl` provide absolute links to S3 assets.

### `Section`
| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `description` | String | Optional |
| `course` | ObjectId → Course | Required, indexed |
| `order` | Number | Required; unique within course |

### `Lesson`
| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `description` | String | Optional |
| `course` | ObjectId → Course | Required, indexed |
| `section` | ObjectId → Section | Required, indexed |
| `video` | ObjectId → Media | Optional in schema (business rule: required for publishing) |
| `duration` | Number | Seconds, default `0` |
| `isPreview` | Boolean | Default `false` |
| `order` | Number | Required; unique within section |

### `Enrollment`
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → User | Required, indexed |
| `course` | ObjectId → Course | Required, indexed |
| `status` | String | `Active` \| `Completed`, default `Active` |
| `enrolledAt` | Date | Default `Date.now` |

> Compound unique index on `{ user, course }` prevents duplicate enrollments.

### `LessonProgress`
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → User | Required |
| `course` | ObjectId → Course | Required |
| `section` | ObjectId → Section | Required |
| `lesson` | ObjectId → Lesson | Required |
| `enrollment` | ObjectId → Enrollment | Required |
| `duration` | Number | Active watch duration in seconds |
| `maxPositionReached` | Number | Max playback position in seconds |
| `lastPosition` | Number | Last playback position in seconds |
| `lastWatchedAt` | Date | Timestamp of last watch activity, default `null` |
| `completed` | Boolean | Completion flag |
| `completedAt` | Date | Completion timestamp |

> Indexes: Compound unique `{ user, lesson }`, Compound `{ user, course }`, Single `{ enrollment }`.

### `Payment`
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → User | Required, indexed |
| `course` | ObjectId → Course | Required, indexed |
| `amount` | Number | Transaction amount |
| `razorpayOrderId` | String | Razorpay Order ID (unique, indexed) |
| `razorpayPaymentId` | String | Razorpay Payment ID |
| `status` | String | `Created` \| `Paid`, default `Created` |

### `Media`
| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Auto-generated. Used as the object key for storage |
| `uploadedBy` | ObjectId → User | Required, indexed |
| `mimeType` | String | File mimetype (e.g. `video/mp4`, `image/png`) |
| `size` | Number | File size in bytes |
| `status` | String | `UPLOADING` \| `PROCESSING` \| `READY` \| `FAILED` \| `COPY_PENDING` |
| `failedUploadLog` | String | Log path when status is `COPY_PENDING` |
| `copyAttempts` | Number | Count of rclone pipeline attempts |
| `type` | String | `VIDEO` \| `THUMBNAIL`, default `VIDEO` |
| `storageProvider` | String | `BACKBLAZE` \| `AWS_S3`, default `BACKBLAZE` |
| `jobId` | String | Transcoding job identifier (e.g., MediaConvert Job ID) |
| `duration` | Number | Calculated duration of video files in seconds |
| `ingestionMethod` | String | `AWS_PIPELINE` \| `MANUAL`, default `AWS_PIPELINE` |
| `error` | String | Error message in case of failure |

### `OTP`
Stores short-lived OTPs for email verification and password resets (TTL-managed).

---

## Middleware

| Middleware | File | Description |
|---|---|---|
| `authenticate` | `middlewares/authenticate.js` | Validates signed `sid` cookie via Redis. Populates `req.user`. Rejects with `401` if missing or expired. |
| `optionalAuthenticate` | `middlewares/optionalAuthenticate.js` | Same as `authenticate` but does **not** reject unauthenticated requests. Used on routes that serve tiered responses. |
| `authorize` | `middlewares/authorize.js` | Role guard. Rejects with `403` if `req.user.role` is not in the allowed roles list. |
| `checkLessonAccess` | `middlewares/lessonAccess.js` | LMS access control middleware. Enforces the Creator → Preview → Enrolled hierarchy. |
| `customRateLimit` | `middlewares/rateLimit.js` | Wraps `express-rate-limit`. Called as `customRateLimit(windowMinutes, maxRequests)`. |
| Error Handler | `app.js` (global) | Catches Mongoose validation errors, duplicate key errors (`11000`), operational errors, and unknown errors. |

---

## API Routes

> **Auth Legend:**
> - 🔓 Public
> - 🔑 Requires authentication (`authenticate`)
> - 👁️ Optional authentication (`optionalAuthenticate`)
> - 🛡️ Requires `CREATOR` role

---

### User Routes — `/user`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/user/register` | 🔓 | 2/min | Register a new user |
| `POST` | `/user/login` | 🔓 | 5/min | Login with email + password |
| `POST` | `/user/forgotPassword` | 🔓 | 3/min | Send password reset OTP |
| `GET` | `/user/` | 🔑 | 20/min | Verify session & get current user info |
| `POST` | `/user/logout` | 🔑 | — | Logout current device |
| `POST` | `/user/logoutall` | 🔑 | — | Logout all devices |
| `PATCH` | `/user/changePassword` | 🔑 | 3/min | Change current password |
| `PATCH` | `/user/setPassword` | 🔑 | 3/min | Set a password (for OAuth users) |

---

### Auth Routes — `/auth`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/auth/send-otp` | 🔓 | 2/min | Send OTP to email |
| `POST` | `/auth/verify-otp` | 🔓 | 2/min | Verify OTP |
| `POST` | `/auth/google` | 🔓 | 5/min | Login / register via Google OAuth |

---

### Creator Routes — `/users` and `/admin`

> All routes require `authenticate` + `authorize(roles.CREATOR)`. The same routes are mounted at both `/users` and `/admin` prefixes in `app.js`.

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/users/` | 🔑🛡️ | 5/min | Get all users (paginated) |
| `GET` | `/users/session/:id` | 🔑🛡️ | 20/min | Get session status for a user |
| `POST` | `/users/logout` | 🔑🛡️ | 1/min | Force-logout a user |
| `DELETE` | `/users/delete` | 🔑🛡️ | 1/min | Permanently delete a user |
| `PATCH` | `/users/block` | 🔑🛡️ | 5/min | Block or unblock a user |
| `PATCH` | `/users/users/:userId/promote` | 🔑🛡️ | 1/min | Promote a student to CREATOR (irreversible through API) |

**Dashboard & Payment Analytics (mounted at `/admin`):**

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/admin/dashboard/summary` | 🔑🛡️ | 10/min | Get admin dashboard summary |
| `GET` | `/admin/payments/summary` | 🔑🛡️ | 10/min | Get payment summary stats |
| `GET` | `/admin/payments/revenue-by-course` | 🔑🛡️ | 10/min | Get revenue breakdown by course |
| `GET` | `/admin/payments/successful` | 🔑🛡️ | 10/min | Get successful payment records |
| `GET` | `/admin/payments/:paymentId/invoice` | 🔑🛡️ | 10/min | Get invoice for a specific payment |

---

### Course Routes — `/course`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/course/` | 🔑🛡️ | 5/min | Create a new course |
| `GET` | `/course/` | 🔓 | — | List published courses (paginated only) |
| `GET` | `/course/creator/me` | 🔑🛡️ | — | List creator's own courses. Supports `?status=Draft\|Published\|All` |
| `GET` | `/course/:id` | 🔓 | — | Get a single course by ID |
| `GET` | `/course/:id/details` | 👁️ | — | Get full structured course details (video field stripped for non-creators/non-enrolled) |
| `POST` | `/course/:id/thumbnail/upload-url` | 🔑🛡️ | 10/min | Generate thumbnail upload S3 URL + draft Media asset |
| `POST` | `/course/:id/thumbnail/confirm` | 🔑🛡️ | 10/min | Confirm thumbnail upload on AWS S3, link to course |
| `DELETE` | `/course/:id/thumbnail` | 🔑🛡️ | 10/min | Delete thumbnail from AWS S3, remove Media, clear Course field |
| `POST` | `/course/:id/trailer/upload-url` | 🔑🛡️ | 10/min | Generate course trailer S3 upload URL + draft Media asset |
| `POST` | `/course/:id/trailer/confirm` | 🔑🛡️ | 10/min | Confirm trailer upload on AWS S3, link to course |
| `DELETE` | `/course/:id/trailer` | 🔑🛡️ | 10/min | Delete trailer from AWS S3, remove Media, clear Course field |
| `POST` | `/course/:id/enroll` | 🔑 | 10/min | Enroll user directly (for free courses) |
| `GET` | `/course/enrollments/me` | 🔑 | — | Get all enrollments of current user |
| `GET` | `/course/:id/enrollment` | 🔑 | — | Get a single enrollment of the current user using course ID |
| `PATCH` | `/course/:id/publish` | 🔑🛡️ | 10/min | Publish a course. Validates section & lesson count and videos |
| `PATCH` | `/course/:id/unpublish` | 🔑🛡️ | 10/min | Unpublish a course (set status back to Draft) |
| `PATCH` | `/course/:id` | 🔑🛡️ | 10/min | Update course metadata (excluding status) |
| `DELETE` | `/course/:id` | 🔑🛡️ | 5/min | Delete a course and its sections, lessons, progress, and media |

---

### Section Routes — `/section`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/section/` | 🔑🛡️ | 10/min | Create a section (order must be unique within course) |
| `GET` | `/section/course/:courseId` | 👁️ | — | Get all sections for a course (Draft courses restricted to creator) |
| `GET` | `/section/creator/course/:courseId` | 🔑🛡️ | — | Get creator's sections for a course |
| `GET` | `/section/creator/:id` | 🔑🛡️ | — | Get a specific section (creator view) |
| `GET` | `/section/:id` | 👁️ | — | Get a section by ID (Draft courses restricted to creator) |
| `PATCH` | `/section/:id` | 🔑🛡️ | 10/min | Update a section (order conflict check on change) |
| `DELETE` | `/section/:id` | 🔑🛡️ | 10/min | Delete a section and all its lessons |

---

### Lesson Routes — `/lesson`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/lesson/` | 🔑🛡️ | 10/min | Create a lesson (order must be unique within section) |
| `GET` | `/lesson/section/:sectionId` | 👁️ | — | Get all lesson metadata for a section (video info stripped for unauthorized) |
| `GET` | `/lesson/creator/section/:sectionId` | 🔑🛡️ | — | Get creator's lessons for a section |
| `GET` | `/lesson/creator/:id` | 🔑🛡️ | — | Get a specific lesson (creator view) |
| `GET` | `/lesson/:id` | 🔑 + `checkLessonAccess` | 60/min | Get a lesson (strictly access-controlled by hierarchy) |
| `GET` | `/lesson/:id/play` | 🔑 + `checkLessonAccess` | 30/min | Generate lesson playback tokens/URL |
| `GET` | `/lesson/:id/progress` | 🔑 + `checkLessonAccess` | — | Get current user's progress for a lesson |
| `PATCH` | `/lesson/:id/progress` | 🔑 + `checkLessonAccess` | — | Update/save user's progress for a lesson |
| `PATCH` | `/lesson/:id` | 🔑🛡️ | 10/min | Update a lesson (order conflict check on change) |
| `DELETE` | `/lesson/:id` | 🔑🛡️ | 10/min | Delete a lesson |

---

### Media Routes — `/media`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/media/internal/processing-complete` | 🔓 | — | Webhook called when transcoder finishes a job (updates status to READY/FAILED, updates duration) |
| `POST` | `/media/s3/lesson/:lessonId/upload-url` | 🔑🛡️ | 15/min | Create a draft Media and generate S3 presigned upload URL |
| `POST` | `/media/s3/lesson/:lessonId/confirm` | 🔑🛡️ | 15/min | Verify S3 upload (size check & type check), starts processing pipeline |
| `POST` | `/media/manual` | 🔑🛡️ | 15/min | Ingest manually prepared HLS/dash files into database |
| `POST` | `/media/manual/:mediaId/verify` | 🔑🛡️ | 15/min | Verify files of manually ingested media on storage bucket |
| `POST` | `/media/:id/retry-transfer` | 🔑🛡️ | 5/min | Retry pending file transfers for `COPY_PENDING` media |

---

### Learning Routes — `/learning`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/learning/courses/:courseId/sections/:sectionId` | 🔑 | — | Get section learning data: course summary, access flags, enrollment, course-level progress, section with lessons and per-lesson progress merged inline |
| `GET` | `/learning/courses/:courseId/progress` | 🔑 | — | Get minimal course completion summary (total lessons, completed lessons, percentage) |

---

### Payment Routes — `/payment`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/payment/order` | 🔑 | 10/min | Create a Razorpay payment order for purchasing a course |
| `POST` | `/payment/webhook` | 🔓 | 30/min | Razorpay payment webhook endpoint to automatically enroll users |

---

## Error Handling

The global error handler in `app.js` normalises all error types into consistent JSON responses:

| Error Type | HTTP Status | Triggered By |
|---|---|---|
| Mongoose `ValidationError` | `400` | Schema validation failures |
| MongoDB Duplicate Key (`11000`) | `409` | Unique index violations (e.g., duplicate email, duplicate order) |
| Operational errors (`isOperational: true`) | Varies | Custom app errors thrown with a status code |
| Unknown / programming errors | `500` | Unexpected exceptions |
