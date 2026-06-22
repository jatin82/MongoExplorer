const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName, assertCollectionName } = require('../utils/validate');
const { parse, serialize, stringify } = require('../utils/ejson');

const router = express.Router();

// ---------- CSV export helpers ----------

// Format a single (non-plain-object) value into a CSV-friendly string.
// BSON types (ObjectId, Decimal128, ...) stringify to their natural form;
// arrays are kept as compact EJSON so no information is lost.
function formatCsvValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return stringify(value);
  if (typeof value === 'object') {
    if (value._bsontype) {
      return typeof value.toString === 'function' ? value.toString() : stringify(value);
    }
    return stringify(value);
  }
  return String(value);
}

// Recursively flatten a document into { 'a.b.c': value } scalar cells using
// dot notation for nested plain objects. Arrays and BSON values stay whole.
function flattenDocument(doc, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(doc)) {
    const col = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !value._bsontype
    ) {
      flattenDocument(value, col, out);
    } else {
      out[col] = formatCsvValue(value);
    }
  }
  return out;
}

// Escape a value for a single CSV cell per RFC 4180.
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Validate the db/collection segments once for every route in this router.
router.param('db', (req, res, next, db) => {
  try {
    assertDbName(db);
    next();
  } catch (err) {
    next(err);
  }
});
router.param('coll', (req, res, next, coll) => {
  try {
    assertCollectionName(coll);
    next();
  } catch (err) {
    next(err);
  }
});

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// POST /:db/collections/:coll/documents/find — query documents.
// Body: { filter, projection, sort, limit, skip } where each is EJSON text.
router.post(
  '/:db/collections/:coll/documents/find',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const body = req.body || {};
    const filter = parse(body.filter, {});
    const projection = parse(body.projection, {});
    const sort = parse(body.sort, {});
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 50, 1), 1000);
    const skip = Math.max(parseInt(body.skip, 10) || 0, 0);

    const collection = req.mongoClient.db(db).collection(coll);
    const documents = await collection
      .find(filter, { projection })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .toArray();
    const total = await collection.countDocuments(filter);

    res.json({ documents: serialize(documents), total, limit, skip });
  })
);

// POST /:db/collections/:coll/documents/count — count matching documents.
router.post(
  '/:db/collections/:coll/documents/count',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const filter = parse((req.body || {}).filter, {});
    const count = await req.mongoClient.db(db).collection(coll).countDocuments(filter);
    res.json({ count });
  })
);

// GET /:db/collections/:coll/documents/export — stream all matching documents
// as a CSV download. Optional filter/projection/sort are EJSON in the query
// string; with no filter this exports the entire collection. Nested objects
// are flattened with dot notation and the column set is the union of keys
// across every document.
router.get(
  '/:db/collections/:coll/documents/export',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const filter = parse(req.query.filter, {});
    const projection = parse(req.query.projection, {});
    const sort = parse(req.query.sort, {});
    const sortSpec = sort && Object.keys(sort).length ? sort : null;
    const collection = req.mongoClient.db(db).collection(coll);

    // Pass 1: scan to build the ordered union of flattened column names. This
    // runs before any output is written so failures still yield a JSON error.
    const headers = [];
    const seen = new Set();
    const headerCursor = collection.find(filter, { projection });
    if (sortSpec) headerCursor.sort(sortSpec);
    for await (const doc of headerCursor) {
      for (const key of Object.keys(flattenDocument(doc))) {
        if (!seen.has(key)) {
          seen.add(key);
          headers.push(key);
        }
      }
    }
    // Keep _id as the leading column when present; guarantee at least one.
    const idIdx = headers.indexOf('_id');
    if (idIdx > 0) {
      headers.splice(idIdx, 1);
      headers.unshift('_id');
    }
    if (headers.length === 0) headers.push('_id');

    const safeName = coll.replace(/[^A-Za-z0-9._-]/g, '_') || 'export';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);

    try {
      // UTF-8 BOM so Excel opens non-ASCII content correctly.
      res.write('\uFEFF');
      res.write(headers.map(csvCell).join(',') + '\r\n');

      // Pass 2: stream every matching document as a CSV row.
      const cursor = collection.find(filter, { projection });
      if (sortSpec) cursor.sort(sortSpec);
      for await (const doc of cursor) {
        const flat = flattenDocument(doc);
        res.write(headers.map((h) => csvCell(flat[h])).join(',') + '\r\n');
      }
      res.end();
    } catch (err) {
      // Headers/rows are already on the wire, so we cannot switch to a JSON
      // error response — log and close the stream instead.
      console.error('[MongoExplorer] CSV export failed mid-stream:', err);
      res.end();
    }
  })
);

// POST /:db/collections/:coll/documents — insert one or many documents.
// Body: { document } (EJSON text) or { documents } (EJSON array text).
router.post(
  '/:db/collections/:coll/documents',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const body = req.body || {};
    const collection = req.mongoClient.db(db).collection(coll);

    if (body.documents !== undefined && body.documents !== '') {
      const docs = parse(body.documents, []);
      if (!Array.isArray(docs) || docs.length === 0) {
        throw badRequest('"documents" must be a non-empty array.');
      }
      const result = await collection.insertMany(docs);
      return res.status(201).json({
        insertedCount: result.insertedCount,
        insertedIds: serialize(result.insertedIds),
      });
    }

    const doc = parse(body.document, null);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw badRequest('"document" must be a JSON object.');
    }
    const result = await collection.insertOne(doc);
    res.status(201).json({ insertedId: serialize(result.insertedId) });
  })
);

// PUT /:db/collections/:coll/documents — update or replace documents.
// Body: { filter, update, many, upsert }. If `update` contains operators
// ($set, $inc, ...) it is an update; otherwise it is a full replacement.
router.put(
  '/:db/collections/:coll/documents',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const body = req.body || {};
    const filter = parse(body.filter, null);
    const update = parse(body.update, null);
    if (!filter || typeof filter !== 'object') throw badRequest('"filter" is required.');
    if (!update || typeof update !== 'object') throw badRequest('"update" is required.');

    const many = body.many === true;
    const upsert = body.upsert === true;
    const collection = req.mongoClient.db(db).collection(coll);
    const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));

    let result;
    if (hasOperators) {
      result = many
        ? await collection.updateMany(filter, update, { upsert })
        : await collection.updateOne(filter, update, { upsert });
    } else {
      // A document with no update operators is treated as a replacement.
      result = await collection.replaceOne(filter, update, { upsert });
    }

    res.json({
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ? serialize(result.upsertedId) : null,
    });
  })
);

// DELETE /:db/collections/:coll/documents — delete one or many documents.
// Body: { filter, many, confirmDeleteAll }. A non-empty filter is required to
// avoid wiping a whole collection by accident. An empty filter is permitted
// only as a deliberate bulk "delete all" (many + confirmDeleteAll both true).
router.delete(
  '/:db/collections/:coll/documents',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const body = req.body || {};
    const filter = parse(body.filter, {});
    const many = body.many === true;
    const isEmptyFilter = !filter || typeof filter !== 'object' || Object.keys(filter).length === 0;
    if (isEmptyFilter && !(many && body.confirmDeleteAll === true)) {
      throw badRequest(
        'A non-empty "filter" is required, or pass many + confirmDeleteAll to delete every document.'
      );
    }
    const collection = req.mongoClient.db(db).collection(coll);
    const result = many
      ? await collection.deleteMany(filter)
      : await collection.deleteOne(filter);
    res.json({ deletedCount: result.deletedCount });
  })
);

module.exports = router;
