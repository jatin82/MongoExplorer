const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName, assertCollectionName } = require('../utils/validate');
const { parse } = require('../utils/ejson');

const router = express.Router();

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

// GET /:db/collections/:coll/indexes — list indexes.
router.get(
  '/:db/collections/:coll/indexes',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const indexes = await req.mongoClient.db(db).collection(coll).indexes();
    res.json({ indexes });
  })
);

// POST /:db/collections/:coll/indexes — create an index.
// Body: { keys, options } where keys is EJSON like {"field":1,"other":-1}.
router.post(
  '/:db/collections/:coll/indexes',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    const body = req.body || {};
    const keys = parse(body.keys, null);
    if (!keys || typeof keys !== 'object' || Object.keys(keys).length === 0) {
      const err = new Error('"keys" is required, e.g. {"fieldName": 1}.');
      err.status = 400;
      throw err;
    }
    const options = parse(body.options, {});
    const name = await req.mongoClient.db(db).collection(coll).createIndex(keys, options);
    res.status(201).json({ created: true, name });
  })
);

// DELETE /:db/collections/:coll/indexes/:name — drop an index by name.
router.delete(
  '/:db/collections/:coll/indexes/:name',
  asyncHandler(async (req, res) => {
    const { db, coll, name } = req.params;
    if (name === '_id_') {
      const err = new Error('The default _id index cannot be dropped.');
      err.status = 400;
      throw err;
    }
    await req.mongoClient.db(db).collection(coll).dropIndex(name);
    res.json({ dropped: true, name });
  })
);

module.exports = router;
