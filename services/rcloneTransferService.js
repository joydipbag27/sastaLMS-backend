/**
 * rcloneTransferService.js
 *
 * Production-grade S3 → Backblaze B2 HLS transfer pipeline built on rclone.
 *
 * Design goals:
 *   - Delegate all file transfer work to rclone (parallelism, checksums, built-in retries).
 *   - Add application-level fault tolerance on top:
 *       Round 1: bulk copy of entire prefix via `rclone copy`
 *       Round 2-N: targeted per-object retry via `rclone copyto` for any stragglers
 *   - Verify final B2 presence before declaring success.
 *   - Never delete an S3 object unless confirmed in B2.
 *   - On partial failure: write failed-upload.log and return COPY_PENDING.
 *   - Support future recovery: retryFailedTransfers() reads the log and re-runs.
 *
 * @module rcloneTransferService
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { awsS3Client } from "../config/awsS3Client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the rclone binary path — defaults to "rclone" on PATH. */
const getRcloneBin = () => process.env.RCLONE_PATH || "rclone";

/** Remote names used in rclone invocations. */
const S3_REMOTE = () => process.env.RCLONE_S3_REMOTE || "veolms-s3";
const B2_REMOTE = () => process.env.RCLONE_B2_REMOTE || "veolms-b2";

/** Max application-level retry rounds (beyond rclone's own --retries). */
const APP_RETRY_ROUNDS = () =>
  parseInt(process.env.RCLONE_APP_RETRY_ROUNDS || "3", 10);

/** Parallel transfer slots for the bulk copy phase. */
const TRANSFERS = () => parseInt(process.env.RCLONE_TRANSFERS || "16", 10);
const CHECKERS = () => parseInt(process.env.RCLONE_CHECKERS || "8", 10);

// ─────────────────────────────────────────────────────────────────────────────
// rclone config file (generated at runtime from env vars)
//
// The RCLONE_CONFIG_<REMOTE>_<KEY> env var approach only OVERRIDES keys for
// remotes already defined in a config file — it does NOT create new remotes
// from scratch. The correct approach is to write a minimal rclone.conf INI
// file at runtime and point rclone to it via the RCLONE_CONFIG env var.
// ─────────────────────────────────────────────────────────────────────────────

/** Cached absolute path to the generated rclone config file. */
let _cachedConfigPath = null;

/**
 * Generates the INI content for a minimal rclone.conf defining two remotes:
 *   - S3_REMOTE: AWS S3 (source — MediaConvert output bucket)
 *   - B2_REMOTE: Backblaze B2 via S3-compatible API (destination)
 *
 * @returns {string}
 */
const generateRcloneConfigContent = () => {
  const s3Remote = S3_REMOTE();
  const b2Remote = B2_REMOTE();

  const b2Endpoint = process.env.BLACK_BLAZE_ENDPOINT || "";
  const b2RegionMatch = b2Endpoint.match(/s3\.([^.]+)\.backblazeb2\.com/);
  const b2Region = b2RegionMatch
    ? b2RegionMatch[1]
    : process.env.BLACK_BLAZE_REGION || "us-west-000";

  return [
    `[${s3Remote}]`,
    `type = s3`,
    `provider = AWS`,
    `access_key_id = ${process.env.LOCAL_AWS_ACCESS_KEY_ID || ""}`,
    `secret_access_key = ${process.env.LOCAL_AWS_SECRET_ACCESS_KEY || ""}`,
    `region = ${process.env.AWS_REGION || "us-east-1"}`,
    ``,
    `[${b2Remote}]`,
    `type = s3`,
    `provider = Other`,
    `access_key_id = ${process.env.BLACK_BLAZE_ACCESS_KEY_ID || ""}`,
    `secret_access_key = ${process.env.BLACK_BLAZE_SECRET || ""}`,
    `endpoint = ${b2Endpoint}`,
    `region = ${b2Region}`,
    ``,
  ].join("\n");
};

/**
 * Writes the rclone config to logs/.rclone.conf (once per process lifetime)
 * and returns the absolute path. Subsequent calls return the cached path.
 *
 * @returns {Promise<string>}
 */
const ensureRcloneConfig = async () => {
  if (_cachedConfigPath) return _cachedConfigPath;

  const logDir = process.env.LOG_DIR || process.cwd();
  const configDir = path.join(logDir, "logs");
  const configPath = path.join(configDir, ".rclone.conf");

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, generateRcloneConfigContent(), "utf8");

  console.log(
    `[rcloneTransferService] Generated rclone config at: ${configPath}`,
  );
  _cachedConfigPath = configPath;
  return configPath;
};

/**
 * Builds the environment object for rclone child processes.
 * Sets RCLONE_CONFIG to our generated config file so rclone finds the remotes.
 *
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
const buildRcloneEnv = async () => {
  const configPath = await ensureRcloneConfig();
  return {
    ...process.env,
    HOME: process.env.HOME || process.env.USERPROFILE || "/tmp",
    RCLONE_CONFIG: configPath,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// rclone process wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RcloneRunResult
 * @property {number} exitCode
 * @property {string[]} stdoutLines
 * @property {string[]} stderrLines
 */

/**
 * Spawns rclone with the given arguments and collects all output.
 * Resolves when the process exits (regardless of exit code).
 *
 * @param {string[]} args - rclone CLI arguments
 * @param {object}  [opts]
 * @param {string}  [opts.label] - label for log messages
 * @returns {Promise<RcloneRunResult>}
 */
const spawnRclone = async (args, { label = "rclone" } = {}) => {
  const env = await buildRcloneEnv();
  const bin = getRcloneBin();

  console.log(`[rcloneTransferService] ${label}: ${bin} ${args.join(" ")}`);

  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutLines = [];
    const stderrLines = [];
    let stdoutBuf = "";
    let stderrBuf = "";

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) stdoutLines.push(line.trim());
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) stderrLines.push(line.trim());
      }
    });

    proc.on("close", (code) => {
      // Flush remaining buffer content
      if (stdoutBuf.trim()) stdoutLines.push(stdoutBuf.trim());
      if (stderrBuf.trim()) stderrLines.push(stderrBuf.trim());

      console.log(`[rcloneTransferService] ${label}: exited with code ${code}`);

      // Log the full rclone output whenever it exits non-zero so we can
      // see the actual error message (credentials wrong, bucket not found, etc.)
      if (code !== 0) {
        if (stderrLines.length > 0) {
          console.error(
            `[rcloneTransferService] ${label}: rclone stderr:\n` +
              stderrLines.join("\n"),
          );
        }
        if (stdoutLines.length > 0) {
          console.error(
            `[rcloneTransferService] ${label}: rclone stdout:\n` +
              stdoutLines.join("\n"),
          );
        }
      }

      resolve({ exitCode: code ?? 1, stdoutLines, stderrLines });
    });

    proc.on("error", (err) => {
      console.error(
        `[rcloneTransferService] ${label}: failed to spawn rclone:`,
        err.message,
      );
      resolve({ exitCode: 1, stdoutLines, stderrLines: [err.message] });
    });
  });
};


// ─────────────────────────────────────────────────────────────────────────────
// rclone output parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses rclone's JSON log output (--use-json-log) for error-level entries.
 * Extracts the object key from the "msg" field where possible.
 *
 * Error entries look like:
 *   {"level":"error","msg":"Failed to copy: ...","object":"videos/abc/seg.ts",...}
 *
 * Also handles non-JSON stderr lines by scanning for known error patterns.
 *
 * @param {string[]} logLines - stdout or stderr lines from rclone
 * @param {string}   prefix   - S3 prefix used in this operation (for key extraction)
 * @returns {string[]} Object keys that rclone reported as failed
 */
const parseRcloneFailures = (logLines, prefix) => {
  const failed = new Set();

  for (const line of logLines) {
    // Attempt JSON parse first (--use-json-log output)
    try {
      const entry = JSON.parse(line);
      if (entry.level === "error") {
        // "object" field contains the relative path within the remote
        if (entry.object) {
          // entry.object is relative to the remote root, e.g. "videos/abc/seg.ts"
          const key = entry.object.startsWith("/")
            ? entry.object.slice(1)
            : entry.object;
          failed.add(key);
        } else if (entry.msg) {
          // Try to extract an S3-like path from the error message
          const pathMatch = entry.msg.match(/(?:^|[^/\w])(videos\/[^\s"]+)/);
          if (pathMatch) failed.add(pathMatch[1]);
        }
      }
    } catch {
      // Not JSON — scan for rclone error patterns in plain text
      // e.g. "ERROR : videos/abc/seg.ts: Failed to copy..."
      const plainMatch = line.match(/ERROR\s*:\s*(videos\/[^\s:]+)/);
      if (plainMatch) failed.add(plainMatch[1]);
    }
  }

  return Array.from(failed);
};

// ─────────────────────────────────────────────────────────────────────────────
// S3 object listing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists all S3 object keys under the given prefix using paginated ListObjectsV2.
 *
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
const listS3Keys = async (bucket, prefix) => {
  const keys = [];
  let continuationToken = undefined;

  do {
    const res = await awsS3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    if (res.Contents) {
      for (const obj of res.Contents) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
};

// ─────────────────────────────────────────────────────────────────────────────
// B2 verification via rclone lsf
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists all objects in B2 under the given prefix using `rclone lsf`.
 * Returns the set of keys present in B2.
 *
 * @param {string} prefix - e.g. "videos/abc123/"
 * @returns {Promise<Set<string>>}
 */
const listB2Keys = async (prefix) => {
  const b2Remote = B2_REMOTE();
  const b2Bucket = process.env.BUCKET_NAME;
  const remotePath = `${b2Remote}:${b2Bucket}/${prefix}`;

  const { stdoutLines } = await spawnRclone(
    ["lsf", "--recursive", "--format", "p", remotePath],
    { label: `lsf ${prefix}` },
  );

  // lsf --format p outputs one relative path per line
  // We reconstruct the full key by prepending the prefix
  const b2Keys = new Set();
  for (const line of stdoutLines) {
    const rel = line.trim();
    if (rel) b2Keys.add(prefix + rel);
  }
  return b2Keys;
};

/**
 * Cross-references expected keys against what is actually in B2.
 *
 * @param {string[]} expectedKeys
 * @param {string}   prefix
 * @returns {Promise<{ present: string[], missing: string[] }>}
 */
const verifyB2Objects = async (expectedKeys, prefix) => {
  const b2Keys = await listB2Keys(prefix);
  const present = [];
  const missing = [];

  for (const key of expectedKeys) {
    if (b2Keys.has(key)) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  return { present, missing };
};

// ─────────────────────────────────────────────────────────────────────────────
// rclone transfer operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs `rclone copy` to bulk-copy an entire prefix from S3 to B2.
 * rclone's own --retries handles transient failures within this call.
 *
 * @param {string} prefix       - e.g. "videos/abc123/"
 * @param {string} s3Bucket
 * @param {string} b2Bucket
 * @returns {Promise<RcloneRunResult>}
 */
const runBulkCopy = (prefix, s3Bucket, b2Bucket) => {
  const s3Remote = S3_REMOTE();
  const b2Remote = B2_REMOTE();
  const src = `${s3Remote}:${s3Bucket}/${prefix}`;
  const dst = `${b2Remote}:${b2Bucket}/${prefix}`;

  return spawnRclone(
    [
      "copy",
      src,
      dst,
      "--use-json-log",
      "--log-level",
      "INFO",
      "--stats-log-level",
      "NOTICE",
      "--retries",
      "3",
      "--retries-sleep",
      "5s",
      "--low-level-retries",
      "10",
      "--transfers",
      String(TRANSFERS()),
      "--checkers",
      String(CHECKERS()),
      "--s3-upload-concurrency",
      "4",
      "--checksum",
    ],
    { label: `bulk-copy ${prefix}` },
  );
};

/**
 * Runs `rclone copyto` to copy a single named object from S3 to B2.
 * Used for targeted retry of individual failed objects.
 *
 * @param {string} key        - Full S3 key, e.g. "videos/abc123/segment001.ts"
 * @param {string} s3Bucket
 * @param {string} b2Bucket
 * @returns {Promise<RcloneRunResult>}
 */
const runSingleFileCopy = (key, s3Bucket, b2Bucket) => {
  const s3Remote = S3_REMOTE();
  const b2Remote = B2_REMOTE();
  const src = `${s3Remote}:${s3Bucket}/${key}`;
  const dst = `${b2Remote}:${b2Bucket}/${key}`;

  return spawnRclone(
    [
      "copyto",
      src,
      dst,
      "--use-json-log",
      "--log-level",
      "INFO",
      "--retries",
      "5",
      "--retries-sleep",
      "10s",
      "--low-level-retries",
      "15",
      "--checksum",
    ],
    { label: `copyto ${key}` },
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Failed-upload log management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the failed-upload.log for a given mediaId.
 *
 * @param {string} mediaId
 * @returns {string}
 */
const getLogPath = (mediaId) => {
  const logDir = process.env.LOG_DIR || process.cwd();
  return path.join(
    logDir,
    "logs",
    "copy-failures",
    mediaId,
    "failed-upload.log",
  );
};

/**
 * Writes (or overwrites) the failed-upload.log for a mediaId.
 *
 * Format:
 *   # veoLMS failed-upload.log
 *   # mediaId: <id>
 *   # generated: <iso>
 *   # rounds attempted: <n>
 *   videos/abc123/segment234.ts
 *   ...
 *
 * @param {string}   mediaId
 * @param {string[]} failedKeys
 * @param {number}   roundsAttempted
 * @returns {Promise<string>} Absolute path to the written log file
 */
export const writeFailedUploadLog = async (
  mediaId,
  failedKeys,
  roundsAttempted,
) => {
  const logPath = getLogPath(mediaId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });

  const header = [
    `# veoLMS failed-upload.log`,
    `# mediaId: ${mediaId}`,
    `# generated: ${new Date().toISOString()}`,
    `# rounds attempted: ${roundsAttempted}`,
    ``,
  ].join("\n");

  const body = failedKeys.join("\n") + "\n";
  await fs.writeFile(logPath, header + body, "utf8");

  console.log(
    `[rcloneTransferService] Wrote failed-upload.log: ${logPath} (${failedKeys.length} keys)`,
  );
  return logPath;
};

/**
 * Reads and parses a failed-upload.log file.
 * Returns an empty array if the log does not exist.
 *
 * @param {string} mediaId
 * @returns {Promise<string[]>} List of failed object keys
 */
export const readFailedUploadLog = async (mediaId) => {
  const logPath = getLogPath(mediaId);
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
};

/**
 * Deletes the failed-upload.log for a mediaId (called after full recovery).
 *
 * @param {string} mediaId
 * @returns {Promise<void>}
 */
export const deleteFailedUploadLog = async (mediaId) => {
  const logPath = getLogPath(mediaId);
  try {
    await fs.unlink(logPath);
    console.log(
      `[rcloneTransferService] Deleted failed-upload.log for mediaId: ${mediaId}`,
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[rcloneTransferService] Could not delete failed-upload.log for ${mediaId}:`,
        err.message,
      );
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Transfer result logging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends a structured summary entry to logs/media-transfer.log.
 *
 * @param {string} mediaId
 * @param {object} summary
 */
const appendTransferLog = async (mediaId, summary) => {
  const logDir = process.env.LOG_DIR || process.cwd();
  const logPath = path.join(logDir, "logs", "media-transfer.log");
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      mediaId,
      ...summary,
    });
    await fs.appendFile(logPath, entry + "\n", "utf8");
  } catch (err) {
    console.error(
      "[rcloneTransferService] Failed to write transfer log:",
      err.message,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TransferResult
 * @property {"READY"|"COPY_PENDING"} status
 * @property {number}   totalObjects   - Total objects found in S3
 * @property {string[]} copiedKeys     - Keys confirmed present in B2
 * @property {string[]} failedKeys     - Keys still missing from B2 after all rounds
 * @property {string|null} logPath     - Absolute path to failed-upload.log, or null
 * @property {number}   rounds         - Number of retry rounds executed
 */

/**
 * Primary transfer pipeline. Called by mediaController after MediaConvert COMPLETE.
 *
 * Workflow:
 *   1. List all S3 objects under videos/<mediaId>/
 *   2. Round 1: `rclone copy` entire prefix (bulk, parallel, with rclone retries)
 *   3. Verify B2 for any keys rclone reported as failing
 *   4. Rounds 2–N: `rclone copyto` each still-missing key individually
 *   5. Final B2 verification: confirm presence of all originally expected keys
 *   6. If all present → return { status: "READY", ... }
 *   7. If some missing → write failed-upload.log → return { status: "COPY_PENDING", ... }
 *
 * @param {string} mediaId
 * @returns {Promise<TransferResult>}
 */
export const transferHlsToB2 = async (mediaId) => {
  if (!mediaId) throw new Error("[rcloneTransferService] mediaId is required");

  const prefix = `videos/${mediaId}/`;
  const s3Bucket = process.env.MEDIACONVERT_OUTPUT_BUCKET;
  const b2Bucket = process.env.BUCKET_NAME;
  const maxRounds = APP_RETRY_ROUNDS();

  console.log(
    `[rcloneTransferService] Starting transfer pipeline for mediaId: ${mediaId}`,
  );

  // ── Step 1: List all expected S3 keys ─────────────────────────────────────
  console.log(`[rcloneTransferService] Listing S3 objects under ${prefix}`);
  const allKeys = await listS3Keys(s3Bucket, prefix);

  if (allKeys.length === 0) {
    throw new Error(
      `[rcloneTransferService] No S3 objects found under prefix "${prefix}". ` +
        `MediaConvert output may be missing.`,
    );
  }

  console.log(
    `[rcloneTransferService] Found ${allKeys.length} objects to transfer`,
  );

  // ── Step 2: Round 1 — bulk rclone copy ────────────────────────────────────
  console.log(`[rcloneTransferService] Round 1: bulk rclone copy`);
  const round1Result = await runBulkCopy(prefix, s3Bucket, b2Bucket);

  // Collect rclone-reported failures from both stdout and stderr
  const round1ReportedFailed = parseRcloneFailures(
    [...round1Result.stdoutLines, ...round1Result.stderrLines],
    prefix,
  );

  console.log(
    `[rcloneTransferService] Round 1 complete. ` +
      `Exit: ${round1Result.exitCode}, ` +
      `rclone-reported failures: ${round1ReportedFailed.length}`,
  );

  // ── Step 3: Determine which keys need targeted retry ──────────────────────
  // If rclone exited cleanly AND reported no failures, we can do a final
  // verification and likely skip further rounds. If not, we target those keys.
  let stillFailing =
    round1Result.exitCode !== 0 || round1ReportedFailed.length > 0
      ? [...new Set(round1ReportedFailed)]
      : [];

  // If rclone exit code was non-zero but we couldn't parse specific keys,
  // we'll do a full B2 verification below to find the real missing set.
  let roundsExecuted = 1;

  // ── Steps 4+: Targeted per-object retry rounds ────────────────────────────
  for (let round = 2; round <= maxRounds && stillFailing.length > 0; round++) {
    console.log(
      `[rcloneTransferService] Round ${round}: targeted retry of ${stillFailing.length} objects`,
    );

    const roundFailed = [];
    for (const key of stillFailing) {
      const result = await runSingleFileCopy(key, s3Bucket, b2Bucket);
      if (result.exitCode !== 0) {
        // Log the error but continue — we verify B2 at the end
        const errors = parseRcloneFailures(
          [...result.stdoutLines, ...result.stderrLines],
          prefix,
        );
        roundFailed.push(key);
        console.warn(
          `[rcloneTransferService] Round ${round}: still failing: ${key}`,
          errors.length ? errors : result.stderrLines.slice(-2),
        );
      } else {
        console.log(
          `[rcloneTransferService] Round ${round}: recovered: ${key}`,
        );
      }
    }

    stillFailing = roundFailed;
    roundsExecuted = round;
  }

  // ── Step 5: Final B2 verification ─────────────────────────────────────────
  // Regardless of rclone exit codes and parsed failures, we ask B2 directly
  // which keys are present. This is the ground truth.
  console.log(
    `[rcloneTransferService] Final B2 verification for ${allKeys.length} expected keys`,
  );

  const { present: copiedKeys, missing: failedKeys } = await verifyB2Objects(
    allKeys,
    prefix,
  );

  console.log(
    `[rcloneTransferService] Verification result: ` +
      `${copiedKeys.length} present, ${failedKeys.length} missing`,
  );

  // ── Step 6: Build and return result ───────────────────────────────────────
  const baseResult = {
    totalObjects: allKeys.length,
    copiedKeys,
    failedKeys,
    rounds: roundsExecuted,
  };

  if (failedKeys.length === 0) {
    // Full success
    await appendTransferLog(mediaId, {
      outcome: "READY",
      totalObjects: allKeys.length,
      copiedCount: copiedKeys.length,
      failedCount: 0,
      rounds: roundsExecuted,
    });

    return { status: "READY", logPath: null, ...baseResult };
  }

  // Partial failure — write the log
  const logPath = await writeFailedUploadLog(
    mediaId,
    failedKeys,
    roundsExecuted,
  );

  await appendTransferLog(mediaId, {
    outcome: "COPY_PENDING",
    totalObjects: allKeys.length,
    copiedCount: copiedKeys.length,
    failedCount: failedKeys.length,
    rounds: roundsExecuted,
    logPath,
  });

  console.warn(
    `[rcloneTransferService] Transfer incomplete for mediaId ${mediaId}. ` +
      `${failedKeys.length}/${allKeys.length} objects failed after ${roundsExecuted} rounds. ` +
      `Log: ${logPath}`,
  );

  return { status: "COPY_PENDING", logPath, ...baseResult };
};

/**
 * Recovery pipeline. Called by the retry-transfer admin endpoint.
 *
 * Reads failed-upload.log for the given mediaId and retries only those keys.
 * If all keys are recovered → returns { status: "READY" }.
 * If some still fail → updates failed-upload.log → returns { status: "COPY_PENDING" }.
 *
 * @param {string} mediaId
 * @returns {Promise<TransferResult>}
 */
export const retryFailedTransfers = async (mediaId) => {
  if (!mediaId) throw new Error("[rcloneTransferService] mediaId is required");

  const s3Bucket = process.env.MEDIACONVERT_OUTPUT_BUCKET;
  const b2Bucket = process.env.BUCKET_NAME;
  const prefix = `videos/${mediaId}/`;
  const maxRounds = APP_RETRY_ROUNDS();

  // Read the list of keys that still need to be copied
  let pendingKeys = await readFailedUploadLog(mediaId);

  if (pendingKeys.length === 0) {
    // Log file is gone or empty — do a full B2 verification to find out
    // what is still actually missing (defensive: handles manual log deletion)
    console.warn(
      `[rcloneTransferService] retryFailedTransfers: failed-upload.log is empty or missing ` +
        `for mediaId ${mediaId}. Performing full B2 verification.`,
    );
    const allKeys = await listS3Keys(s3Bucket, prefix);
    const { present: copiedKeys, missing: failedKeys } = await verifyB2Objects(
      allKeys,
      prefix,
    );
    pendingKeys = failedKeys;
    if (pendingKeys.length === 0) {
      return {
        status: "READY",
        totalObjects: allKeys.length,
        copiedKeys,
        failedKeys: [],
        logPath: null,
        rounds: 0,
      };
    }
  }

  console.log(
    `[rcloneTransferService] retryFailedTransfers: ${pendingKeys.length} pending keys for mediaId ${mediaId}`,
  );

  // Run targeted retry rounds
  let stillFailing = [...pendingKeys];
  let roundsExecuted = 0;

  for (let round = 1; round <= maxRounds && stillFailing.length > 0; round++) {
    console.log(
      `[rcloneTransferService] Retry round ${round}: copying ${stillFailing.length} objects`,
    );

    const roundFailed = [];
    for (const key of stillFailing) {
      const result = await runSingleFileCopy(key, s3Bucket, b2Bucket);
      if (result.exitCode !== 0) {
        roundFailed.push(key);
      } else {
        console.log(
          `[rcloneTransferService] Retry round ${round}: recovered: ${key}`,
        );
      }
    }

    stillFailing = roundFailed;
    roundsExecuted = round;
  }

  // Final B2 verification against the originally pending set
  const allKeys = await listS3Keys(s3Bucket, prefix);
  const { present: copiedKeys, missing: failedKeys } = await verifyB2Objects(
    allKeys,
    prefix,
  );

  const baseResult = {
    totalObjects: allKeys.length,
    copiedKeys,
    failedKeys,
    rounds: roundsExecuted,
  };

  if (failedKeys.length === 0) {
    // Full recovery — clean up the log
    await deleteFailedUploadLog(mediaId);
    await appendTransferLog(mediaId, {
      outcome: "RECOVERED_TO_READY",
      totalObjects: allKeys.length,
      copiedCount: copiedKeys.length,
      failedCount: 0,
      rounds: roundsExecuted,
    });
    return { status: "READY", logPath: null, ...baseResult };
  }

  // Still partial — update the log with the remaining failures
  const logPath = await writeFailedUploadLog(
    mediaId,
    failedKeys,
    roundsExecuted,
  );
  await appendTransferLog(mediaId, {
    outcome: "STILL_COPY_PENDING",
    totalObjects: allKeys.length,
    copiedCount: copiedKeys.length,
    failedCount: failedKeys.length,
    rounds: roundsExecuted,
    logPath,
  });

  console.warn(
    `[rcloneTransferService] Retry still incomplete for mediaId ${mediaId}. ` +
      `${failedKeys.length} objects still missing.`,
  );

  return { status: "COPY_PENDING", logPath, ...baseResult };
};
