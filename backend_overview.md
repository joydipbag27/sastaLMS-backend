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
- `GET /course/creator/me` supports `?status=Draft`, `?status=Published`, or `?status=All` to fetch all in a single call.
- All list endpoints support cursor-based pagination (`?cursor=<id>&limit=<n>`).
- Cascading delete: deleting a course also deletes all its sections and lessons.

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

### 🔒 Lesson Access Control
Lesson access is determined by a strict middleware chain. The exact priority order is:

```
Is user authenticated?
    NO  → 401 Unauthorized
    YES ↓
Is user ADMIN?
    YES → Allow (full access)
    NO  ↓
Is user the course Creator?
    YES → Allow (full access)
    NO  ↓
Is the lesson marked isPreview?
    YES → Allow (any authenticated user)
    NO  ↓
Is user Enrolled (Active) in this course?
    YES → Allow
    NO  → 403 Forbidden
```

This logic applies to:
- `GET /lesson/:id` — via `checkLessonAccess` middleware.
- `GET /lesson/section/:sectionId` — inline access control in the controller, using `optionalAuthenticate` to handle both logged-in and logged-out users gracefully.

### 🖼️ Media Management
- **Media** is a standalone, reusable module that tracks uploaded-file metadata. It has no knowledge of lessons, courses, or sections — business models reference Media documents.
- **Upload flow**: Backend generates a presigned PUT URL + unique `storageKey`. The frontend uploads directly to Backblaze B2. After success, the frontend calls `confirm-upload` to confirm the upload.
- **Robust Verification**: When confirming, the backend queries B2/S3 using `HeadObjectCommand` to verify the file exists on the storage server and that its actual size matches the claimed size. If verification fails, the B2 object is cleaned up, database creation is aborted, and a `400` error is returned.
- **Download flow**: Backend generates a presigned GET URL on-the-fly from the stored `storageKey`. The URL is never persisted in MongoDB.
- **Deletion**: Only the original uploader or an ADMIN may delete. Deletes the object from B2 (including all versions/markers) and removes the Media document.

### 📦 File Storage (Backblaze B2)
- Generate **pre-signed upload URLs** so clients upload directly to B2, not through the server.
- Generate **pre-signed download URLs** for secure, time-limited file access.
- Permanent deletion utility (`permanentlyDeleteMultipleFromB2`) handles versioned objects and delete markers.

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
| `thumbnail` | String | S3 key |
| `creator` | ObjectId → User | Required |
| `price` | Number | Default `0` |
| `category` | String | Required |
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
| `uploadedBy` | ObjectId → User | Required, indexed |
| `storageKey` | String | Required, unique |
| `mimeType` | String | Required |
| `size` | Number | Bytes, required |
| `status` | String | `UPLOADING` \| `READY` \| `FAILED`, default `UPLOADING` |

> Media is a standalone entity. It does **not** store `lessonId`, `courseId`, or `sectionId`. Business models (Course, Lesson) reference Media documents.

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

---

### File Routes — `/file`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/file/upload-url` | 🔑 | 15/min | Get a pre-signed URL to upload a file to B2 |
| `GET` | `/file/download-url/:key` | 🔑 | 30/min | Get a pre-signed URL to download a file from B2 |

---

### Course Routes — `/course`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/course/` | 🔑🛡️ | 5/min | Create a new course |
| `GET` | `/course/` | 🔓 | — | List published courses (paginated, filterable by `category`, `level`, `status`) |
| `GET` | `/course/creator/me` | 🔑🛡️ | — | List creator's own courses. Supports `?status=Draft\|Published\|All` |
| `GET` | `/course/:id` | 🔓 | — | Get a single course by ID |
| `GET` | `/course/:id/details` | 🔓 | — | Get full structured course details: course + sections + lessons (video field stripped) |
| `POST` | `/course/:id/enroll` | 🔑 | 10/min | Enroll the current user in a published course |
| `GET` | `/course/enrollments/me` | 🔑 | — | Get all enrollments of the current logged-in user |
| `GET` | `/course/:id/enrollment` | 🔑 | — | Get a single enrollment of the current user using course ID |
| `PATCH` | `/course/:id` | 🔑🛡️ | 10/min | Update a course (creator or admin only) |
| `DELETE` | `/course/:id` | 🔑🛡️ | 5/min | Delete a course and all its sections and lessons (creator or admin only) |


---

### Section Routes — `/section`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/section/` | 🔑🛡️ | 10/min | Create a section (order must be unique within course) |
| `GET` | `/section/course/:courseId` | 🔓 | — | Get all sections for a course |
| `GET` | `/section/creator/course/:courseId` | 🔑🛡️ | — | Get creator's sections for a course |
| `GET` | `/section/creator/:id` | 🔑🛡️ | — | Get a specific section (creator view) |
| `GET` | `/section/:id` | 🔓 | — | Get a section by ID |
| `PATCH` | `/section/:id` | 🔑🛡️ | 10/min | Update a section (order conflict check on change) |
| `DELETE` | `/section/:id` | 🔑🛡️ | 10/min | Delete a section and all its lessons |

---

### Lesson Routes — `/lesson`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/lesson/` | 🔑🛡️ | 10/min | Create a lesson (order must be unique within section) |
| `GET` | `/lesson/section/:sectionId` | 👁️ | — | Get lessons for a section. Access-controlled: enrolled/creator/admin get all; others get preview-only, no `video` field |
| `GET` | `/lesson/creator/section/:sectionId` | 🔑🛡️ | — | Get creator's lessons for a section |
| `GET` | `/lesson/creator/:id` | 🔑🛡️ | — | Get a specific lesson (creator view) |
| `GET` | `/lesson/:id` | 🔑 + `checkLessonAccess` | — | Get a lesson (strictly access-controlled by Admin → Creator → Preview → Enrolled chain) |
| `PATCH` | `/lesson/:id` | 🔑🛡️ | 10/min | Update a lesson (order conflict check on change) |
| `DELETE` | `/lesson/:id` | 🔑🛡️ | 10/min | Delete a lesson |

---

### Media Routes — `/media`

| Method | Path | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `POST` | `/media/upload-url` | 🔑 | 15/min | Generate a presigned PUT URL + unique `storageKey` for direct B2 upload |
| `POST` | `/media/confirm-upload` | 🔑 | 15/min | Create a Media document after successful upload (`status: READY`) |
| `GET` | `/media/:id/download` | 🔑 | 30/min | Generate a presigned GET URL for a media file |
| `DELETE` | `/media/:id` | 🔑 | 10/min | Delete media from B2 + MongoDB (uploader or ADMIN only) |

---

## Error Handling

The global error handler in `app.js` normalises all error types into consistent JSON responses:

| Error Type | HTTP Status | Triggered By |
|---|---|---|
| Mongoose `ValidationError` | `400` | Schema validation failures |
| MongoDB Duplicate Key (`11000`) | `409` | Unique index violations (e.g., duplicate email, duplicate order) |
| Operational errors (`isOperational: true`) | Varies | Custom app errors thrown with a status code |
| Unknown / programming errors | `500` | Unexpected exceptions |
