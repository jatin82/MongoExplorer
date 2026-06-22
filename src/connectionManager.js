const crypto = require('crypto');
const { MongoClient } = require('mongodb');

/**
 * In-memory registry of live MongoDB connections keyed by an opaque connection
 * id. The id is handed to the browser in an httpOnly cookie; the connection
 * string itself never leaves the server.
 *
 * @typedef {Object} ConnectionEntry
 * @property {import('mongodb').MongoClient} client
 * @property {string} label    Sanitized host description for display.
 * @property {number} lastUsed Epoch ms of the last activity (for idle reaping).
 */

/** @type {Map<string, ConnectionEntry>} */
const connections = new Map();

// Close connections that have been idle for longer than this to avoid leaks.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const REAP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of connections) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      entry.client.close().catch(() => {});
      connections.delete(id);
    }
  }
}, REAP_INTERVAL_MS);
// Do not keep the event loop alive solely for the reaper.
reaper.unref();

/**
 * Derive a non-sensitive label (host list + default db) from a connection
 * string so the UI can show *where* it is connected without exposing the
 * credentials.
 *
 * @param {string} uri
 * @returns {string}
 */
function describeUri(uri) {
  try {
    // mongodb:// and mongodb+srv:// are URL-parseable once credentials are
    // stripped of characters that break the WHATWG URL parser.
    const parsed = new URL(uri);
    const host = parsed.host || parsed.hostname || 'unknown-host';
    const db = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : '';
    return db ? `${host}/${db}` : host;
  } catch {
    return 'mongodb';
  }
}

/**
 * Open a new MongoDB connection, verify it with a ping and register it.
 *
 * @param {string} uri
 * @returns {Promise<{ connId: string, label: string }>}
 */
async function connect(uri) {
  if (typeof uri !== 'string' || uri.trim() === '') {
    const err = new Error('A MongoDB connection string is required.');
    err.status = 400;
    throw err;
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri.trim())) {
    const err = new Error('Connection string must start with mongodb:// or mongodb+srv://');
    err.status = 400;
    throw err;
  }

  const client = new MongoClient(uri.trim(), {
    serverSelectionTimeoutMS: 8000,
  });

  try {
    await client.connect();
    // Confirm the server is actually reachable and credentials are valid.
    await client.db('admin').command({ ping: 1 });
  } catch (err) {
    await client.close().catch(() => {});
    err.status = err.status || 502;
    // Never surface the raw connection string in error output.
    err.message = `Failed to connect: ${err.message}`;
    throw err;
  }

  const connId = crypto.randomUUID();
  connections.set(connId, {
    client,
    label: describeUri(uri.trim()),
    lastUsed: Date.now(),
  });
  return { connId, label: describeUri(uri.trim()) };
}

/**
 * Look up a live client by id, refreshing its last-used timestamp.
 *
 * @param {string|undefined} connId
 * @returns {import('mongodb').MongoClient | null}
 */
function getClient(connId) {
  if (!connId) return null;
  const entry = connections.get(connId);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.client;
}

/**
 * Return the display label for a connection id, if any.
 *
 * @param {string|undefined} connId
 * @returns {string|null}
 */
function getLabel(connId) {
  const entry = connId ? connections.get(connId) : undefined;
  return entry ? entry.label : null;
}

/**
 * Close and forget a connection.
 *
 * @param {string|undefined} connId
 * @returns {Promise<boolean>} true if a connection was closed
 */
async function disconnect(connId) {
  const entry = connId ? connections.get(connId) : undefined;
  if (!entry) return false;
  connections.delete(connId);
  await entry.client.close().catch(() => {});
  return true;
}

/**
 * Express middleware that attaches the active MongoClient to req.mongoClient
 * based on the mongoConnId cookie. Rejects requests without a live connection.
 *
 * @type {import('express').RequestHandler}
 */
function requireConnection(req, res, next) {
  const connId = req.cookies ? req.cookies.mongoConnId : undefined;
  const client = getClient(connId);
  if (!client) {
    return res.status(401).json({ error: 'Not connected. Please connect to a MongoDB instance first.' });
  }
  req.mongoClient = client;
  req.mongoConnId = connId;
  next();
}

/**
 * Close every open connection. Used on graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function closeAll() {
  clearInterval(reaper);
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map((entry) => entry.client.close().catch(() => {})));
}

module.exports = {
  connect,
  disconnect,
  getClient,
  getLabel,
  requireConnection,
  closeAll,
};
