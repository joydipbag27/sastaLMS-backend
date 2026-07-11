/**
 * promoteToCreator.js
 *
 * One-time bootstrap script: promotes a single STUDENT account to CREATOR.
 *
 * Use this to provision the first trusted platform operator on a fresh deployment
 * where no CREATOR accounts exist yet.
 *
 * Run explicitly from the project root:
 *   PROMOTE_EMAIL=operator@example.com node scripts/promoteToCreator.js
 *
 * DO NOT add this to application startup or any automated pipeline.
 * DO NOT hardcode credentials in this file.
 *
 * What it does:
 *   1. Reads the target email from the PROMOTE_EMAIL environment variable.
 *   2. Connects to MongoDB using MONGO_URI from environment.
 *   3. Finds the user by email.
 *   4. Rejects if user does not exist or is already CREATOR.
 *   5. Updates role to CREATOR.
 *   6. Invalidates Redis sessions + profile cache for the promoted account.
 *   7. Reports result and exits.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { createClient } from "redis";

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------

const PROMOTE_EMAIL = process.env.PROMOTE_EMAIL?.trim();
if (!PROMOTE_EMAIL) {
  console.error("[promote] ERROR: PROMOTE_EMAIL environment variable is required.");
  console.error("  Usage: PROMOTE_EMAIL=operator@example.com node scripts/promoteToCreator.js");
  process.exit(1);
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("[promote] ERROR: MONGO_URI environment variable is not set.");
  process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("[promote] ERROR: REDIS_URL environment variable is not set.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  // 1. Connect to MongoDB
  await mongoose.connect(MONGO_URI);
  console.log("[promote] Connected to MongoDB.");

  // 2. Connect to Redis
  const redis = createClient({ url: REDIS_URL });
  redis.on("error", (err) => console.error("[promote] Redis error:", err));
  await redis.connect();
  console.log("[promote] Connected to Redis.");

  try {
    const { default: User } = await import("../Models/userModel.js");

    // 3. Find target user by email
    const user = await User.findOne({ email: PROMOTE_EMAIL });
    if (!user) {
      console.error(`[promote] ERROR: No account found with email "${PROMOTE_EMAIL}".`);
      return;
    }

    // 4. Guard: reject if already CREATOR
    if (user.role === "CREATOR") {
      console.log(`[promote] "${PROMOTE_EMAIL}" is already a CREATOR. Nothing to do.`);
      return;
    }

    console.log(`[promote] Promoting: ${user._id}  ${user.username}  <${user.email}>  (currently: ${user.role})`);

    // 5. Promote to CREATOR
    user.role = "CREATOR";
    await user.save();
    console.log(`[promote] Role updated to CREATOR.`);

    const userId = user._id.toString();

    // 6. Invalidate Redis sessions
    try {
      const data = await redis.ft.search("userIdIndex", `@userId:{${userId}}`);
      const keys = data.documents.map((doc) => doc.id);
      if (keys.length > 0) {
        await redis.del(keys);
        console.log(`[promote] Invalidated ${keys.length} session(s). User must log in again.`);
      } else {
        console.log(`[promote] No active sessions found for this user.`);
      }
    } catch (err) {
      console.warn(`[promote] Could not invalidate sessions:`, err.message);
    }

    // Invalidate profile cache
    try {
      await redis.del(`profile:${userId}`);
    } catch (err) {
      console.warn(`[promote] Could not invalidate profile cache:`, err.message);
    }

    console.log(`[promote] Done. "${PROMOTE_EMAIL}" is now a CREATOR (platform operator).`);
  } finally {
    await mongoose.disconnect();
    await redis.quit();
    console.log("[promote] Connections closed.");
  }
}

run().catch((err) => {
  console.error("[promote] Fatal error:", err);
  process.exit(1);
});
