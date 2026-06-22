const { EJSON } = require('bson');

/**
 * Parse Extended JSON input into native BSON types (ObjectId, Date, etc.).
 * Accepts either a raw EJSON string (typed by the user in the UI) or an
 * already-parsed plain object (when the body was JSON-decoded by Express).
 *
 * @param {string|object|undefined|null} input
 * @param {*} [fallback] value returned when input is empty
 * @returns {*}
 */
function parse(input, fallback = {}) {
  if (input === undefined || input === null) return fallback;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return fallback;
    return EJSON.parse(trimmed);
  }
  if (typeof input === 'object') {
    // Convert {$oid}/{$date} style keys in a plain object into real BSON types.
    return EJSON.deserialize(input);
  }
  return fallback;
}

/**
 * Convert BSON documents into a relaxed Extended JSON string that is safe and
 * readable to send to the browser (Date -> {"$date": "ISO"}, numbers stay
 * plain, ObjectId -> {"$oid": "..."}).
 *
 * @param {*} value
 * @returns {string}
 */
function stringify(value) {
  return EJSON.stringify(value);
}

/**
 * Serialize a value to a relaxed EJSON-compatible plain object that Express can
 * send with res.json while preserving BSON type hints such as $oid.
 *
 * @param {*} value
 * @returns {*}
 */
function serialize(value) {
  return EJSON.serialize(value);
}

module.exports = { parse, stringify, serialize };
