# veoLMS — Backend Overview

A comprehensive reference for the features, architecture, middleware pipeline, data models, and API routes of the veoLMS backend.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM / `"type": "module"`) |
| Framework | Express.js v5 |
| Database | MongoDB via Mongoose v8 |
| Session Store | Redis (JSON + FT Search index) |
| File Storage | Backblaze B2 (S3-compatible) via `@aws-sdk/client-s3` |
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
Three roles are defined in `config/roles.js`:

| Role | Capabilities |
|---|---|
| `STUDENT` | Enroll in courses, access allowed lessons |
| `CREATOR` | All STUDENT abilities + create/manage their own courses, sections, lessons |
| `ADMIN` | Full access to everything including user management |

**Admin operations:**
- View all users (paginated)
- Check a specific user's session status
- Force-logout any user's session
- Block / Unblock users
- Change a user's role
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
- Cascading delete: deleting a course also deletes all its sections, lessons, and associated media from B2.

#### Sections
- Scoped to a course. Ordered by `order` field.
- **Order validation**: Duplicate `order` values within the same course are rejected (`409 Conflict`) at both the controller level and the DB level (compound unique index on `{ course, order }`).
- Cascading delete: deleting a section also deletes all its lessons.

#### Lessons
- Scoped to a section (and course). Ordered by `order` field.
- **Order validation**: Duplicate `order` values within the same section are rejected (`409 Conflict`) at both the controller level and the DB level (compound unique index on `{ section, order }`).
- `isPreview` flag marks a lesson as accessible to any authenticated user without enrollment.

### 🎟️ Enrollment System
- Students can enroll in any `Published` course.
- **Business rules enforced:**
  - User must be authenticated.
  - Course must exist and be `Published` (not `Draft`).
  - The course creator cannot enroll in their own course.
  - A user can only enroll once (compound unique index on `{ user, course }`).
- Enrollment status: `Active` or `Completed`.

### 🔒 Lesson and Media Access Control
Lesson and course resource access is determined by strict middleware and controller logic. The authorization hierarchy and rules are:

#### 1. General Access Rules
- **Creator / Admin Access**: The course creator (or an admin) always retains full access to manage and read their own courses, sections, lessons, and media files, regardless of whether the course `status` is `Draft` or `Published`.
- **Draft Restriction**: All course metadata, sections, lesson metadata, and media of a `Draft` course are entirely private to the creator/admin. Non-creators (including enrolled students) will be blocked with a `403 Forbidden` error.
- **Temporary Lock (Draft State)**: If a creator changes a published course back to `Draft`, existing enrollments are preserved, but students temporarily lose all access to read the course, sections, lessons, or media. Access is restored once the course is published again.

#### 2. Media Playback Authorization
Media playback and token generation are authorized under the following conditions:
- The requester is the course creator or an admin.
- **OR** The requester is **authenticated**, the parent course `status` is `Published` **AND** one of:
  - The lesson is marked as a preview lesson (`isPreview === true`).
  - The user has an `Active` enrollment in the course.

Unauthenticated guest users cannot watch any media (neither preview nor normal lessons).

#### 3. Metadata Omission (Media ID Stripping)
To prevent unauthorized media downloads, the media ID (`video` field) is omitted/stripped from the lesson metadata payloads returned in `GET /course/:id/details` and `GET /lesson/section/:sectionId` unless the user meets the media playback authorization rules above.

### 🖼️ Media Management
- **Media** is a standalone, reusable module that tracks uploaded-file metadata. It has no knowledge of lessons, courses, or sections — business models (Lesson) reference Media documents.
- **B2 key = `_id`**: Each Media document's `_id` (converted to string via `.toString()`) is used directly as the B2 object key. There is no separate `storageKey` field.
- **Upload flow**: Lesson-scoped. `POST /media/lesson/:lessonId/upload-url` creates a draft Media document and returns a presigned PUT URL. The frontend uploads directly to B2. After success, the frontend calls `POST /media/lesson/:lessonId/confirm` to verify and finalize.
- **Replace flow**: `POST /media/lesson/:lessonId/replace-url` deletes the existing video from B2, creates a new Media document, and returns a fresh presigned PUT URL.
- **Robust Verification**: When confirming, the backend queries B2/S3 using `HeadObjectCommand` to verify the file exists on the storage server and that its actual size matches the claimed size. If verification fails, the B2 object is cleaned up, the Media document is deleted, and a `400` error is returned.
- **Deletion**: Only the original uploader or an ADMIN may delete. Deletes the object from B2 (including all versions/markers) and removes the Media document.

### 📦 File Storage (Backblaze B2)
- Generate **pre-signed upload URLs** so clients upload directly to B2, not through the server.
- Permanent deletion utility (`permanentlyDeleteMultipleFromB2`) handles versioned objects and delete markers.
- **Important**: All B2 keys passed to the delete utility must be **strings** (e.g., `_id.toString()`), not ObjectId objects.

---

## Connections

| Service | Purpose | Config File |
|---|---|---|
| **MongoDB** | Primary database (users, courses, sections, lessons, media, OTPs, enrollments) | `config/db.js` |
| **Redis** | Session storage, FT search index for logout-all-devices | `config/redis.js`, `config/redisSetup.js` |
| **Backblaze B2** | S3-compatible object storage for course media | `config/s3Client.js` |
| **Resend** | Transactional email (OTPs, password resets) | Used in `authController.js` / `userController.js` |
| **Google OAuth** | Third-party login via ID token validation | Used in `authController.js` |

---

## Data Models

### `User`
| Field | Type | Notes |
|---|---|---|
| `username` | String | 3–100 chars, required |
| `email` | String | Unique, validated format |
| `password` | String | Optional (Google users may not have one) |
| `role` | String | `STUDENT` \| `CREATOR` \| `ADMIN`, default `STUDENT` |
| `isBlocked` | Boolean | Default `false` |

### `Course`
| Field | Type | Notes |
|---|---|---|
| `title` | String | Required |
| `description` | String | Required |
| `creator` | ObjectId → User | Required |
| `thumbnail` | ObjectId → Media | References a Media document representing the course thumbnail |
| `price` | Number | Default `0` |
| `level` | String | `Beginner` \| `Intermediate` \| `Advanced` |
| `status` | String | `Draft` \| `Published`, default `Draft` |

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
| `video` | ObjectId → Media | Required, references a Media document |
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

### `Media`
| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Auto-generated. Used as the object key (via `.toString()`) for the storage provider |
| `uploadedBy` | ObjectId → User | Required, indexed |
| `mimeType` | String | Required |
| `size` | Number | Bytes, required |
| `status` | String | `UPLOADING` \| `PROCESSING` \| `READY` \| `FAILED` \| `COPY_PENDING`, default `UPLOADING` |
| `failedUploadLog` | String | Absolute path to `failed-upload.log` when status is `COPY_PENDING`, otherwise `null` |
| `copyAttempts` | Number | Number of rclone pipeline runs attempted (default `0`) |
| `type` | String | `VIDEO` \| `THUMBNAIL`, default `VIDEO` |
| `storageProvider` | String | `BACKBLAZE` \| `AWS_S3`, default `BACKBLAZE` |

> **`COPY_PENDING`**: MediaConvert succeeded and the HLS output was partially transferred to B2. Some files are still in S3 awaiting recovery. An admin can call `POST /media/:id/retry-transfer` to attempt recovery without rerunning MediaConvert.

### `OTP`
Stores short-lived OTPs for email verification and password resets (TTL-managed).

---

## Middleware

| Middleware | File | Description |
|---|---|---|
| `authenticate` | `middlewares/authenticate.js` | Validates signed `sid` cookie via Redis. Populates `req.user`. Rejects with `401` if missing or expired. |
| `optionalAuthenticate` | `middlewares/optionalAuthenticate.js` | Same as `authenticate` but does **not** reject unauthenticated requests. Used on routes that serve tiered responses (e.g. lesson list). |
| `authorize` | `middlewares/authorize.js` | Role guard. Rejects with `403` if `req.user.role` is not in the allowed roles list. |
| `checkLessonAccess` | `middlewares/lessonAccess.js` | LMS access control middleware. Enforces the Admin → Creator → Preview → Enrolled hierarchy. |
| `customRateLimit` | `middlewares/rateLimit.js` | Wraps `express-rate-limit`. Called as `customRateLimit(windowMinutes, maxRequests)`. |
| Error Handler | `app.js` (global) | Catches Mongoose validation errors, duplicate key errors (`11000`), operational errors (`isOperational`), and unknown errors. |

---

## API Routes

> **Auth Legend:**
> - 🔓 Public
> - 🔑 Requires authentication (`authenticate`)
> - 👁️ Optional authentication (`optionalAuthenticate`)
> - 🛡️ Requires role (`CREATOR` or `ADMIN`)
> - 👑 Requires `ADMIN` role only

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

### RBAC / Admin Routes — `/users`

> All routes require `authenticate` + `authorize`.

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/users/` | 🔑🛡️ | 5/min | Get all users (paginated) |
| `GET` | `/users/session/:id` | 🔑🛡️ | 20/min | Get session status for a user |
| `POST` | `/users/logout` | 🔑🛡️ | 1/min | Force-logout a user |
| `DELETE` | `/users/delete` | 🔑👑 | 1/min | Permanently delete a user |
| `PATCH` | `/users/block` | 🔑👑 | 5/min | Block or unblock a user |
| `PATCH` | `/users/role` | 🔑👑 | 1/min | Change a user's role |



### Course Routes — `/course`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/course/` | 🔑🛡️ | 5/min | Create a new course |
| `GET` | `/course/` | 🔓 | — | List published courses (paginated only) |
| `GET` | `/course/creator/me` | 🔑🛡️ | — | List creator's own courses. Supports `?status=Draft\|Published\|All` |
| `GET` | `/course/:id` | 🔓 | — | Get a single course by ID |
| `GET` | `/course/:id/details` | 👁️ | — | Get full structured course details: course + sections + lessons (video field stripped for non-creators) |
| `POST` | `/course/:id/thumbnail/upload-url` | 🔑🛡️ | 10/min | Generate a presigned AWS S3 upload URL + draft Media asset for the course thumbnail |
| `POST` | `/course/:id/thumbnail/confirm` | 🔑🛡️ | 10/min | Confirm and verify thumbnail upload on AWS S3 (HeadObject + 2MB limit), link to course |
| `DELETE` | `/course/:id/thumbnail` | 🔑🛡️ | 10/min | Delete thumbnail from AWS S3, remove Media document, clear Course association |
| `POST` | `/course/:id/enroll` | 🔑 | 10/min | Enroll the current user in a published course |
| `GET` | `/course/enrollments/me` | 🔑 | — | Get all enrollments of the current logged-in user |
| `GET` | `/course/:id/enrollment` | 🔑 | — | Get a single enrollment of the current user using course ID |
| `PATCH` | `/course/:id/publish` | 🔑🛡️ | 10/min | Publish a course. Validates: ≥1 section, each section has ≥1 lesson, each lesson has a video |
| `PATCH` | `/course/:id/unpublish` | 🔑🛡️ | 10/min | Unpublish a course (set status back to Draft) |
| `PATCH` | `/course/:id` | 🔑🛡️ | 10/min | Update course metadata (cannot change status — use publish/unpublish endpoints) |
| `DELETE` | `/course/:id` | 🔑🛡️ | 5/min | Delete a course and all its sections, lessons, and media (creator or admin only) |


---

### Section Routes — `/section`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/section/` | 🔑🛡️ | 10/min | Create a section (order must be unique within course) |
| `GET` | `/section/course/:courseId` | 👁️ | — | Get all sections for a course (Draft courses restricted to creator/admin) |
| `GET` | `/section/creator/course/:courseId` | 🔑🛡️ | — | Get creator's sections for a course |
| `GET` | `/section/creator/:id` | 🔑🛡️ | — | Get a specific section (creator view) |
| `GET` | `/section/:id` | 👁️ | — | Get a section by ID (Draft courses restricted to creator/admin) |
| `PATCH` | `/section/:id` | 🔑🛡️ | 10/min | Update a section (order conflict check on change) |
| `DELETE` | `/section/:id` | 🔑🛡️ | 10/min | Delete a section and all its lessons |

---

### Lesson Routes — `/lesson`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/lesson/` | 🔑🛡️ | 10/min | Create a lesson (order must be unique within section) |
| `GET` | `/lesson/section/:sectionId` | 👁️ | — | Get all lesson metadata for a section. Media/video info is stripped for unauthorized lessons (e.g. guests/non-enrolled) |
| `GET` | `/lesson/creator/section/:sectionId` | 🔑🛡️ | — | Get creator's lessons for a section |
| `GET` | `/lesson/creator/:id` | 🔑🛡️ | — | Get a specific lesson (creator view) |
| `GET` | `/lesson/:id` | 🔑 + `checkLessonAccess` | 60/min | Get a lesson (strictly access-controlled by Admin → Creator → Preview → Enrolled chain) |
| `PATCH` | `/lesson/:id` | 🔑🛡️ | 10/min | Update a lesson (order conflict check on change) |
| `DELETE` | `/lesson/:id` | 🔑🛡️ | 10/min | Delete a lesson |

---

### Media Routes — `/media`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/media/lesson/:lessonId/upload-url` | 🔑🛡️ | 15/min | Create a draft Media document and generate a presigned PUT URL for direct B2 upload |
| `POST` | `/media/lesson/:lessonId/replace-url` | 🔑🛡️ | 15/min | Delete existing video, create new Media document, and generate a presigned PUT URL |
| `POST` | `/media/lesson/:lessonId/confirm` | 🔑🛡️ | 15/min | Verify upload on B2 (HeadObject + size check), finalize Media document, and associate with lesson |
| `DELETE` | `/media/:id` | 🔑 | 10/min | Delete media from B2 + MongoDB (uploader or ADMIN only) |
| `POST` | `/media/:id/retry-transfer` | 🔑👑 | 5/min | Retry pending file transfers for a `COPY_PENDING` media (ADMIN only). Reads `failed-upload.log`, retries missing files, promotes to `READY` on success |

---

## Error Handling

The global error handler in `app.js` normalises all error types into consistent JSON responses:

| Error Type | HTTP Status | Triggered By |
|---|---|---|
| Mongoose `ValidationError` | `400` | Schema validation failures |
| MongoDB Duplicate Key (`11000`) | `409` | Unique index violations (e.g., duplicate email, duplicate order) |
| Operational errors (`isOperational: true`) | Varies | Custom app errors thrown with a status code |
| Unknown / programming errors | `500` | Unexpected exceptions |
