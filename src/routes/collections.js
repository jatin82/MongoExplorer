const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName, assertCollectionName } = require('../utils/validate');

const router = express.Router();

// GET /api/databases/:db/collections — list collections in a database.
router.get(
  '/:db/collections',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    assertDbName(db);
    const collections = await req.mongoClient.db(db).listCollections().toArray();
    res.json({ collections });
  })
);

// POST /api/databases/:db/collections — create a collection.
router.post(
  '/:db/collections',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    const { name, options } = req.body || {};
    assertDbName(db);
    assertCollectionName(name);
    await req.mongoClient.db(db).createCollection(name, options && typeof options === 'object' ? options : {});
    res.status(201).json({ created: true, collection: name });
  })
);

// DELETE /api/databases/:db/collections/:coll — drop a collection.
router.delete(
  '/:db/collections/:coll',
  asyncHandler(async (req, res) => {
    const { db, coll } = req.params;
    assertDbName(db);
    assertCollectionName(coll);
    await req.mongoClient.db(db).collection(coll).drop();
    res.json({ dropped: true, collection: coll });
  })
);

module.exports = router;
