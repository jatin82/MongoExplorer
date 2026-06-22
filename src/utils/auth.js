const crypto = require('crypto');
const { EncryptJWT, jwtDecrypt } = require('jose');

/**
 * Authentication layer for MongoExplorer.
 *
 * A single shared access key (APP_ACCESS_KEY) gates the whole app. When a user
 * supplies the correct key we mint an *encrypted* JWT (JWE: `dir` key wrapping
 * + AES-256-GCM content encryption) and hand it back in an httpOnly cookie.
 * Every protected request must present a token that decrypts and validates
 * server-side. Because the token is encrypted (not merely signed) its claims
 * are opaque to the client and cannot be read or tampered with.
 */

const ISSUER = 'mongo-explorer';
const AUDIENCE = 'mongo-explorer-app';

const ACCESS_KEY = process.env.APP_ACCESS_KEY || '';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'mongoExplorerAuth';

/**
 * Parse a human duration ("30m", "8h", "7d", "500ms") or bare seconds ("3600")
 * into milliseconds. Falls back to `fallbackMs` when the input is missing or
 * malformed.
 *
 * @param {string|undefined} input
 * @param {number} fallbackMs
 * @returns {number}
 */
function parseDurationMs(input, fallbackMs) {
  if (input == null || String(input).trim() === '') return fallbackMs;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000; // bare seconds
  const m = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(s);
  if (!m) return fallbackMs;
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  return parseInt(m[1], 10) * mult;
}

const TTL_MS = parseDurationMs(process.env.JWT_TTL, 8 * 60 * 60 * 1000);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.AUTH_MAX_ATTEMPTS || '8', 10) || 8);
const ATTEMPT_WINDOW_MS = parseDurationMs(process.env.AUTH_ATTEMPT_WINDOW, 15 * 60 * 1000);
const LOCK_MS = parseDurationMs(process.env.AUTH_LOCK_DURATION, 15 * 60 * 1000);

/**
 * Resolve the 32-byte content-encryption key from JWT_ENCRYPTION_KEY. Accepts
 * 64 hex chars, base64 that decodes to 32 bytes, or any passphrase (from which
 * a 256-bit key is derived). Returns null when the variable is unset.
 *
 * @returns {Buffer|null}
 */
function loadConfiguredKey() {
  const raw = (process.env.JWT_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    /* fall through to passphrase derivation */
  }
  return crypto.scryptSync(raw, 'mongo-explorer:jwt-enc:v1', 32);
}

// Resolve the encryption key once. If none is configured, derive a stable key
// from the access key so the app still runs (sessions reset if the key rotates).
let keyDerivedFromAccessKey = false;
let ENCRYPTION_KEY = loadConfiguredKey();
if (!ENCRYPTION_KEY) {
  keyDerivedFromAccessKey = true;
  ENCRYPTION_KEY = crypto.scryptSync(
    ACCESS_KEY || 'mongo-explorer:insecure-fallback',
    'mongo-explorer:jwt-enc:fallback:v1',
    32
  );
}

/**
 * Validate that the auth layer is configured well enough to start. Throws on
 * fatal misconfiguration (so the server can fail closed) and warns on weak
 * setups.
 *
 * @returns {void}
 */
function assertReady() {
  if (!ACCESS_KEY || ACCESS_KEY.trim() === '') {
    throw new Error(
      'APP_ACCESS_KEY is not set. Define it in your .env file (copy .env.example) before starting.'
    );
  }
  if (ACCESS_KEY.length < 8 || ACCESS_KEY === 'change-this-access-key' || ACCESS_KEY === 'change-this-to-a-strong-secret') {
    console.warn(
      '[auth] WARNING: APP_ACCESS_KEY is weak or still set to a default. Use a long, random secret.'
    );
  }
  if (keyDerivedFromAccessKey) {
    console.warn(
      '[auth] JWT_ENCRYPTION_KEY not set; deriving the token key from APP_ACCESS_KEY. ' +
        'Set an explicit JWT_ENCRYPTION_KEY for stable sessions.'
    );
  }
}

/**
 * Constant-time comparison of a candidate access key against the configured
 * one. Both sides are SHA-256 hashed first so the comparison is fixed-length
 * and does not leak the key length through timing.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
function verifyAccessKey(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!ACCESS_KEY) return false;
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const b = crypto.createHash('sha256').update(ACCESS_KEY, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Mint an encrypted JWT (JWE) carrying the supplied claims.
 *
 * @param {Record<string, unknown>} [claims]
 * @returns {Promise<string>}
 */
async function issueToken(claims = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return new EncryptJWT({ ...claims })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(nowSec)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(crypto.randomUUID())
    .setExpirationTime(nowSec + Math.floor(TTL_MS / 1000))
    .encrypt(ENCRYPTION_KEY);
}

/**
 * Decrypt and validate a token. Throws if the token is missing, tampered with,
 * expired, or issued for a different issuer/audience.
 *
 * @param {string} token
 * @returns {Promise<import('jose').JWTPayload>}
 */
async function verifyToken(token) {
  const { payload } = await jwtDecrypt(token, ENCRYPTION_KEY, {
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance: 5,
  });
  return payload;
}

/**
 * Cookie attributes for the auth token. `secure` is opt-in via COOKIE_SECURE so
 * the app works over plain http on localhost but can be hardened for HTTPS.
 *
 * @returns {import('express').CookieOptions}
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
    maxAge: TTL_MS,
    path: '/',
  };
}

/**
 * Cookie attributes used when clearing the auth cookie. Mirrors cookieOptions
 * but omits maxAge (Express sets an immediate expiry itself).
 *
 * @returns {import('express').CookieOptions}
 */
function clearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.COOKIE_SECURE).toLowerCase() === 'true',
    path: '/',
  };
}

/**
 * Express middleware: require a valid encrypted-JWT session. Attaches the
 * decoded claims to req.auth. Responds 401 with a machine-readable `code` so
 * the frontend can distinguish "show the login gate" from other errors.
 *
 * @type {import('express').RequestHandler}
 */
function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : undefined;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.', code: 'AUTH_REQUIRED' });
  }
  verifyToken(token)
    .then((payload) => {
      req.auth = payload;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'AUTH_INVALID' });
    });
}

/* ---------- Login brute-force guard (in-memory, per client) ---------- */

/** @type {Map<string, { count: number, first: number, lockedUntil: number }>} */
const attempts = new Map();

function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Periodically drop stale records so the map cannot grow unbounded.
const attemptsReaper = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (rec.lockedUntil < now && now - rec.first > ATTEMPT_WINDOW_MS) {
      attempts.delete(key);
    }
  }
}, Math.max(60000, ATTEMPT_WINDOW_MS));
attemptsReaper.unref();

/**
 * Express middleware: reject login attempts from a client that is currently
 * locked out after too many failures.
 *
 * @type {import('express').RequestHandler}
 */
function loginGuard(req, res, next) {
  const rec = attempts.get(clientKey(req));
  const now = Date.now();
  if (rec && rec.lockedUntil > now) {
    const retry = Math.ceil((rec.lockedUntil - now) / 1000);
    res.set('Retry-After', String(retry));
    return res
      .status(429)
      .json({ error: `Too many failed attempts. Try again in ${retry}s.`, code: 'RATE_LIMITED' });
  }
  next();
}

/**
 * Record the outcome of a login attempt. Success clears the counter; repeated
 * failures eventually trigger a temporary lockout.
 *
 * @param {import('express').Request} req
 * @param {boolean} success
 * @returns {void}
 */
function noteLoginResult(req, success) {
  const key = clientKey(req);
  if (success) {
    attempts.delete(key);
    return;
  }
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) {
    rec = { count: 0, first: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
  }
  attempts.set(key, rec);
}

module.exports = {
  COOKIE_NAME,
  assertReady,
  verifyAccessKey,
  issueToken,
  verifyToken,
  cookieOptions,
  clearCookieOptions,
  requireAuth,
  loginGuard,
  noteLoginResult,
};
