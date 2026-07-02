import { createHmac, timingSafeEqual } from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encodes a Buffer or string to a URL-safe base64 string (no padding).
 * @param {Buffer|string} data
 * @returns {string}
 */
const toBase64Url = (data) =>
  Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Decodes a URL-safe base64 string back to a plain string.
 * @param {string} str
 * @returns {string}
 */
const fromBase64Url = (str) =>
  Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );

/**
 * Returns the configured token TTL in seconds.
 * Defaults to 7200 (2 hours) if the env var is not set or invalid.
 * @returns {number}
 */
const getTtl = () => {
  const val = parseInt(process.env.PLAYBACK_TOKEN_TTL_SECONDS, 10);
  return Number.isFinite(val) && val > 0 ? val : 7200;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a short-lived HMAC-SHA256 signed playback token.
 *
 * Token format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`
 *
 * The payload carries only the minimum required fields:
 *   { userId, mediaId, courseId, exp }
 *
 * @param {{ userId: string, mediaId: string, courseId: string }} params
 * @returns {string} Signed token string
 * @throws {Error} If PLAYBACK_TOKEN_SECRET is not configured
 */
export const generatePlaybackToken = ({ userId, mediaId, courseId }) => {
  const secret = process.env.PLAYBACK_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      "[playbackTokenService] PLAYBACK_TOKEN_SECRET is not configured.",
    );
  }

  const exp = Math.floor(Date.now() / 1000) + getTtl();
  const payload = { userId, mediaId, courseId, exp };
  const encodedPayload = toBase64Url(JSON.stringify(payload));

  const sig = createHmac("sha256", secret).update(encodedPayload).digest();
  const encodedSig = toBase64Url(sig);

  return `${encodedPayload}.${encodedSig}`;
};

/**
 * Verifies a playback token.
 *
 * Checks (in order):
 *   1. Token structure is valid (two dot-separated parts).
 *   2. HMAC signature is valid (timing-safe comparison).
 *   3. Token has not expired.
 *   4. mediaId in the token matches the requested mediaId.
 *
 * @param {string} token          - The token string from the query param
 * @param {string} expectedMediaId - The mediaId extracted from the request URL
 * @returns {{ valid: true, payload: object } | { valid: false, reason: string }}
 */
export const verifyPlaybackToken = (token, expectedMediaId) => {
  const secret = process.env.PLAYBACK_TOKEN_SECRET;
  if (!secret) {
    return { valid: false, reason: "Token secret not configured on server." };
  }

  // 1. Structure check
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "Malformed token." };
  }

  const [encodedPayload, encodedSig] = parts;

  // 2. Signature verification (timing-safe)
  const expectedSig = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest();
  const expectedSigEncoded = toBase64Url(expectedSig);

  const sigA = Buffer.from(encodedSig);
  const sigB = Buffer.from(expectedSigEncoded);

  if (
    sigA.length !== sigB.length ||
    !timingSafeEqual(sigA, sigB)
  ) {
    return { valid: false, reason: "Invalid token signature." };
  }

  // 3. Parse payload
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    return { valid: false, reason: "Token payload could not be parsed." };
  }

  // 4. Expiry check
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || nowSeconds > payload.exp) {
    return { valid: false, reason: "Token has expired." };
  }

  // 5. mediaId match
  if (payload.mediaId !== expectedMediaId) {
    return { valid: false, reason: "Token mediaId does not match resource." };
  }

  return { valid: true, payload };
};
