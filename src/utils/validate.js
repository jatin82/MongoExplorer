/**
 * Name validation helpers for MongoDB databases and collections. These mirror
 * the server-side naming rules so we can reject obviously invalid input early
 * with a clear 400 instead of a cryptic driver error.
 */

/**
 * @param {string} name
 * @returns {boolean}
 */
function isValidDbName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (Buffer.byteLength(name, 'utf8') > 64) return false;
  // Disallowed characters: / \ . " $ * < > : | ? whitespace and the null char.
  return !/[/\\."$*<>:|?\s\u0000]/.test(name);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isValidCollectionName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('system.')) return false;
  if (name.includes('$') || name.includes('\u0000')) return false;
  return true;
}

/**
 * @param {string} name
 * @returns {void}
 * @throws {Error & { status: number }}
 */
function assertDbName(name) {
  if (!isValidDbName(name)) {
    const err = new Error(`Invalid database name: "${name}"`);
    err.status = 400;
    throw err;
  }
}

/**
 * @param {string} name
 * @returns {void}
 * @throws {Error & { status: number }}
 */
function assertCollectionName(name) {
  if (!isValidCollectionName(name)) {
    const err = new Error(`Invalid collection name: "${name}"`);
    err.status = 400;
    throw err;
  }
}

module.exports = {
  isValidDbName,
  isValidCollectionName,
  assertDbName,
  assertCollectionName,
};
