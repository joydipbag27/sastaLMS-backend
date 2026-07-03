//
// Proxy Backblaze S3 compatible API requests, sending notifications to a webhook
//
// Adapted from https://github.com/obezuk/worker-signed-s3-template
//
import { AwsClient } from 'aws4fetch'

const UNSIGNABLE_HEADERS = [
    // These headers appear in the request, but are never passed upstream
    'x-forwarded-proto',
    'x-real-ip',
    // We can't include accept-encoding in the signature because Cloudflare
    // sets the incoming accept-encoding header to "gzip, br", then modifies
    // the outgoing request to set accept-encoding to "gzip".
    // Not cool, Cloudflare!
    'accept-encoding',
    // Conditional headers are not consistently passed upstream
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
];

// URL needs colon suffix on protocol, and port as a string
const HTTPS_PROTOCOL = "https:";
const HTTPS_PORT = "443";

// How many times to retry a range request where the response is missing content-range
const RANGE_RETRY_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Cache API helper
//
// .ts segments are immutable (same bytes for a given mediaId + segment number).
// We cache them at the Cloudflare edge using a token-stripped URL as the key,
// so all users share the same cached bytes regardless of their unique token.
//
// .m3u8 manifests are NEVER cached here — we rewrite them per-request to
// inject the active token into every URI line.
//
// Requires: Workers Paid plan (caches.default.put is not available on Free).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a token-stripped URL string suitable for use as a cache key.
 * Removes the `token` query parameter so all users share the same cache entry
 * for identical segment files.
 * @param {URL} url
 * @returns {string}
 */
function buildCacheKey(url) {
    const key = new URL(url.toString());
    key.searchParams.delete('token');
    return key.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Playback token verification (HMAC-SHA256 via Web Crypto)
//
// Token format (mirrors playbackTokenService.js on the backend):
//   <base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>
//
// Payload shape: { userId, mediaId, courseId, exp }
//
// Required Worker secret: PLAYBACK_TOKEN_SECRET
//   Set via: wrangler secret put PLAYBACK_TOKEN_SECRET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decodes a URL-safe base64 string to a plain UTF-8 string.
 * @param {string} str
 * @returns {string}
 */
function fromBase64Url(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    return decodeURIComponent(
        binary.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
}

/**
 * Verifies the HMAC-SHA256 playback token.
 *
 * Checks (in order):
 *   1. Token has the correct two-part structure.
 *   2. HMAC signature is valid (constant-time via crypto.subtle.verify).
 *   3. Token has not expired.
 *   4. mediaId in the token matches the requested mediaId from the URL path.
 *
 * @param {string} token            - Raw token string from ?token= query param
 * @param {string} expectedMediaId  - mediaId parsed from the URL path (/videos/<mediaId>/...)
 * @param {string} secret           - Value of PLAYBACK_TOKEN_SECRET Worker secret
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function verifyPlaybackToken(token, expectedMediaId, secret) {
    // 1. Structure check
    const parts = token.split('.');
    if (parts.length !== 2) {
        return { valid: false, reason: 'Malformed token' };
    }
    const [encodedPayload, encodedSig] = parts;

    // 2. Import the HMAC key
    let cryptoKey;
    try {
        cryptoKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );
    } catch {
        return { valid: false, reason: 'Failed to import key' };
    }

    // 3. Decode the signature from base64url → Uint8Array
    let sigBytes;
    try {
        const padded = encodedSig.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded);
        sigBytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    } catch {
        return { valid: false, reason: 'Invalid signature encoding' };
    }

    // 4. Verify signature (constant-time)
    const payloadBytes = new TextEncoder().encode(encodedPayload);
    const isValid = await crypto.subtle.verify('HMAC', cryptoKey, sigBytes, payloadBytes);
    if (!isValid) {
        return { valid: false, reason: 'Invalid signature' };
    }

    // 5. Parse payload
    let payload;
    try {
        payload = JSON.parse(fromBase64Url(encodedPayload));
    } catch {
        return { valid: false, reason: 'Payload parse error' };
    }

    // 6. Expiry check
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!payload.exp || nowSeconds > payload.exp) {
        return { valid: false, reason: 'Token expired' };
    }

    // 7. mediaId match
    if (payload.mediaId !== expectedMediaId) {
        return { valid: false, reason: 'mediaId mismatch' };
    }

    return { valid: true };
}

// Filter out cf-* and any other headers we don't want to include in the signature
function filterHeaders(headers, env) {
    // Suppress irrelevant IntelliJ warning
    // noinspection JSCheckFunctionSignatures
    return new Headers(Array.from(headers.entries())
        .filter(pair => !(
            UNSIGNABLE_HEADERS.includes(pair[0])
            || pair[0].startsWith('cf-')
            || ('ALLOWED_HEADERS' in env && !env['ALLOWED_HEADERS'].includes(pair[0]))
        ))
    );
}

function createHeadResponse(response) {
    return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
    });
}

function isListBucketRequest(env, path) {
    const pathSegments = path.split('/');

    return (env['BUCKET_NAME'] === "$path" && pathSegments.length < 2) // https://endpoint/bucket-name/
        || (env['BUCKET_NAME'] !== "$path" && path.length === 0); // https://bucket-name.endpoint/ or https://endpoint/
}

// Supress IntelliJ's "unused default export" warning
// noinspection JSUnusedGlobalSymbols
export default {
    async fetch(request, env) {

        console.log("WORKER STARTED");

        // Entry-point security gate: only allow .m3u8 and .ts requests under /videos/
        const checkUrl = new URL(request.url);
        const pathLower = checkUrl.pathname.toLowerCase();
        if (!pathLower.startsWith('/videos/') || (!pathLower.endsWith('.m3u8') && !pathLower.endsWith('.ts'))) {
            return new Response('Not Found', { status: 404 });
        }

        // ── Playback Token Verification ───────────────────────────────────────
        // Only enforce token verification on /videos/<mediaId>/... paths.
        // All other paths are blocked by the existing isListBucketRequest guard.
        const requestUrl = new URL(request.url);
        const videoPathMatch = requestUrl.pathname.match(/^\/videos\/([a-f0-9]{24})\/.+$/i);

        let activeToken = null;

        if (videoPathMatch) {
            const mediaId = videoPathMatch[1];
            const token = requestUrl.searchParams.get('token');

            if (!token) {
                return new Response('Forbidden: missing token', { status: 403 });
            }

            if (!env.PLAYBACK_TOKEN_SECRET) {
                console.error('[b2-worker] PLAYBACK_TOKEN_SECRET is not configured');
                return new Response('Internal Server Error', { status: 500 });
            }

            const { valid, reason } = await verifyPlaybackToken(token, mediaId, env.PLAYBACK_TOKEN_SECRET);
            if (!valid) {
                console.log(`[b2-worker] Token rejected — ${reason} — path: ${requestUrl.pathname}`);
                return new Response('Forbidden', { status: 403 });
            }

            activeToken = token;
            // Strip the token from the URL before forwarding to B2
            requestUrl.searchParams.delete('token');
        }
        // ── End Token Verification ─────────────────────────────────────────────

        // Only allow GET and HEAD methods
        if (!['GET', 'HEAD'].includes(request.method)) {
            return new Response(null, {
                status: 405,
                statusText: "Method Not Allowed"
            });
        }

        const url = requestUrl;

        console.log("1:", request.url);

        // Incoming protocol and port is taken from the worker's environment.
        // Local dev mode uses plain http on 8787, and it's possible to deploy
        // a worker on plain http. B2 only supports https on 443
        url.protocol = HTTPS_PROTOCOL;
        url.port = HTTPS_PORT;

        // Remove leading slashes from path
        let path = url.pathname.replace(/^\//, '');
        // Remove trailing slashes
        path = path.replace(/\/$/, '');

        // Reject list bucket requests unless configuration allows it
        if (isListBucketRequest(env, path) && String(env['ALLOW_LIST_BUCKET']) !== "true") {
            return new Response(null, {
                status: 404,
                statusText: "Not Found"
            });
        }

        // Set RCLONE_DOWNLOAD to "true" to use rclone with --b2-download-url
        // See https://rclone.org/b2/#b2-download-url
        const rcloneDownload = String(env["RCLONE_DOWNLOAD"]) === 'true';

        // Set upstream target hostname.
        switch (env['BUCKET_NAME']) {
            case "$path":
                // Bucket name is initial segment of URL path
                url.hostname = env['B2_ENDPOINT'];
                break;
            case "$host":
                // Bucket name is initial subdomain of the incoming hostname
                url.hostname = url.hostname.split('.')[0] + '.' + env['B2_ENDPOINT'];
                break;
            default:
                // Bucket name is specified in the BUCKET_NAME variable
                url.hostname = env['BUCKET_NAME'] + "." + env['B2_ENDPOINT'];
                break;
        }

        // Certain headers, such as x-real-ip, appear in the incoming request but
        // are removed from the outgoing request. If they are in the outgoing
        // signed headers, B2 can't validate the signature.
        const headers = filterHeaders(request.headers, env);
        console.log("2:", request.headers);

        // Create an S3 API client that can sign the outgoing request
        const client = new AwsClient({
            "accessKeyId": env['B2_APPLICATION_KEY_ID'],
            "secretAccessKey": env['B2_APPLICATION_KEY'],
            "service": "s3",
        });

        console.log("5:", client);


        // Save the request method, so we can process responses for HEAD requests appropriately
        const requestMethod = request.method;

        if (rcloneDownload) {
            if (env['BUCKET_NAME'] === "$path") {
                // Remove leading file/ prefix from the path
                url.pathname = path.replace(/^file\//, "");
            } else {
                // Remove leading file/{bucket_name}/ prefix from the path 
                url.pathname = path.replace(/^file\/[^/]+\//, "");
            }
        }
        console.log("Hostname after switch:", url.hostname);
        // Sign the outgoing request
        //
        // For HEAD requests Cloudflare appears to change the method on the outgoing request to GET (#18), which
        // breaks the signature, resulting in a 403. So, change all HEADs to GETs. This is not too inefficient,
        // since we won't read the body of the response if the original request was a HEAD.
        const signedRequest = await client.sign(url.toString(), {
            method: 'GET',
            headers: headers
        });

        console.log("3:", signedRequest.headers.has("range"));
        console.log("4:", signedRequest.url);

        // For large files, Cloudflare will return the entire file, rather than the requested range
        // So, if there is a range header in the request, check that the response contains the
        // content-range header. If not, abort the request and try again.
        // See https://community.cloudflare.com/t/cloudflare-worker-fetch-ignores-byte-request-range-on-initial-request/395047/4
        if (signedRequest.headers.has("range")) {
            let attempts = RANGE_RETRY_ATTEMPTS;
            let response;
            do {
                let controller = new AbortController();

                response = await fetch(signedRequest.url, {
                    method: signedRequest.method,
                    headers: signedRequest.headers,
                    signal: controller.signal,
                });


                console.log(signedRequest);




                if (response.headers.has("content-range")) {
                    // Only log if it didn't work first time
                    if (attempts < RANGE_RETRY_ATTEMPTS) {
                        console.log(`Retry for ${signedRequest.url} succeeded - response has content-range header`);
                    }
                    // Break out of loop and return the response
                    break;
                } else if (response.ok) {
                    attempts -= 1;
                    console.error(`Range header in request for ${signedRequest.url} but no content-range header in response. Will retry ${attempts} more times`);
                    // Do not abort on the last attempt, as we want to return the response
                    if (attempts > 0) {
                        controller.abort();
                    }
                } else {
                    // Response is not ok, so don't retry
                    break;
                }
            } while (attempts > 0);

            if (attempts <= 0) {
                console.error(`Tried range request for ${signedRequest.url} ${RANGE_RETRY_ATTEMPTS} times, but no content-range in response.`);
            }

            // Return whatever response we have rather than an error response
            // This response cannot be aborted, otherwise it will raise an exception
            return response;
        }

        // Send the signed request to B2
        // For immutable .ts segments, check the Cloudflare Cache API first.
        // This converts DYNAMIC → HIT for all subsequent viewers of the same segment.
        // NOTE: caches.default.put() requires Workers Paid plan.
        //       On the free plan, put() is silently swallowed via .catch().
        //       For free-plan HIT caching, use Cloudflare Cache Rules in the dashboard
        //       (see README for setup instructions).
        if (url.pathname.endsWith('.ts')) {
            const startTime = Date.now();
            const cache = caches.default;
            const cacheKey = buildCacheKey(url);

            // 1. Cache lookup
            const cacheLookupStart = Date.now();
            const cachedResponse = await cache.match(cacheKey);
            const cacheLookupTime = Date.now() - cacheLookupStart;

            if (cachedResponse) {
                const totalTime = Date.now() - startTime;
                console.log(`[b2-worker] CACHE_MATCH = HIT`);
                console.log(`Cache lookup: ${cacheLookupTime}ms`);
                console.log(`Origin fetch: N/A`);
                console.log(`cache.put: N/A`);
                console.log(`Total: ${totalTime}ms`);

                console.log([
                    "========== CACHE DEBUG ==========",
                    `Request:\n${url.pathname}`,
                    ``,
                    `Cache Key:\n${cacheKey}`,
                    ``,
                    `MATCH:\nHIT`,
                    ``,
                    `PUT:\nSKIPPED`,
                    ``,
                    `Total:\n${totalTime}ms`,
                    "================================"
                ].join("\n"));

                const hitHeaders = new Headers(cachedResponse.headers);
                hitHeaders.set('x-worker-cache-match', 'HIT');
                hitHeaders.set('x-worker-cache-put', 'SKIPPED');
                hitHeaders.set('x-worker-origin-fetch-ms', 'N/A');
                hitHeaders.set('x-worker-total-ms', String(totalTime));

                return new Response(cachedResponse.body, {
                    status: cachedResponse.status,
                    statusText: cachedResponse.statusText,
                    headers: hitHeaders
                });
            }

            // 2. Cache MISS — fetch from B2
            console.log(`[b2-worker] CACHE_MATCH = MISS`);
            const originFetchStart = Date.now();
            const b2Response = await fetch(signedRequest, {
                cf: {
                    cacheEverything: true,
                    cacheTtl: 31536000,
                }
            });
            const originFetchTime = Date.now() - originFetchStart;

            if (b2Response.ok) {
                const responseHeaders = new Headers(b2Response.headers);
                responseHeaders.set('cache-control', 'public, max-age=31536000, immutable');
                responseHeaders.delete('surrogate-control');

                responseHeaders.set('x-worker-cache-match', 'MISS');
                responseHeaders.set('x-worker-origin-fetch-ms', String(originFetchTime));

                const clientResponse = new Response(b2Response.body, {
                    status: b2Response.status,
                    statusText: b2Response.statusText,
                    headers: responseHeaders,
                });

                const cacheResponse = clientResponse.clone();

                const cachePutStart = Date.now();
                let putStatus = "SKIPPED";
                try {
                    await cache.put(cacheKey, cacheResponse);
                    putStatus = "SUCCESS";
                    console.log("CACHE_PUT_SUCCESS");
                } catch (err) {
                    putStatus = "FAILED";
                    console.error("CACHE_PUT_FAILED", err);
                }
                const cachePutTime = Date.now() - cachePutStart;

                const totalTime = Date.now() - startTime;

                console.log(`Cache lookup: ${cacheLookupTime}ms`);
                console.log(`Origin fetch: ${originFetchTime}ms`);
                console.log(`cache.put: ${cachePutTime}ms`);
                console.log(`Total: ${totalTime}ms`);

                console.log([
                    "========== CACHE DEBUG ==========",
                    `Request:\n${url.pathname}`,
                    ``,
                    `Cache Key:\n${cacheKey}`,
                    ``,
                    `MATCH:\nMISS`,
                    ``,
                    `PUT:\n${putStatus}`,
                    ``,
                    `Total:\n${totalTime}ms`,
                    "================================"
                ].join("\n"));

                clientResponse.headers.set('x-worker-cache-put', putStatus);
                clientResponse.headers.set('x-worker-total-ms', String(totalTime));

                return clientResponse;
            }

            const totalTime = Date.now() - startTime;
            console.log(`[b2-worker] Request failed with B2 status ${b2Response.status}`);
            console.log(`Total: ${totalTime}ms`);

            console.log([
                "========== CACHE DEBUG ==========",
                `Request:\n${url.pathname}`,
                ``,
                `Cache Key:\n${cacheKey}`,
                ``,
                `MATCH:\nMISS`,
                ``,
                `PUT:\nN/A`,
                ``,
                `Total:\n${totalTime}ms`,
                "================================"
            ].join("\n"));

            const failHeaders = new Headers(b2Response.headers);
            failHeaders.set('x-worker-cache-match', 'MISS');
            failHeaders.set('x-worker-cache-put', 'N/A');
            failHeaders.set('x-worker-origin-fetch-ms', String(originFetchTime));
            failHeaders.set('x-worker-total-ms', String(totalTime));

            return new Response(b2Response.body, {
                status: b2Response.status,
                statusText: b2Response.statusText,
                headers: failHeaders
            });
        }

        // For all other file types (manifests, etc.) — fetch directly from B2
        const response = await fetch(signedRequest);

        if (requestMethod === 'HEAD') {
            // Original request was HEAD, so return a new Response without a body
            return createHeadResponse(response);
        }

        // If it's a playlist request, rewrite all sub-playlist and segment links to append the token
        if (url.pathname.endsWith('.m3u8') && response.ok && activeToken) {
            let manifestText = await response.text();
            manifestText = manifestText.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed.length === 0 || trimmed.startsWith('#')) {
                    return line;
                }
                const separator = trimmed.includes('?') ? '&' : '?';
                return `${trimmed}${separator}token=${activeToken}`;
            }).join('\n');

            const newHeaders = new Headers(response.headers);
            newHeaders.delete('content-length');
            // Never cache rewritten manifests — they are token-specific
            newHeaders.set('cache-control', 'no-store');

            return new Response(manifestText, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders
            });
        }

        return response;
    },
};
