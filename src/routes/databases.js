const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName, assertCollectionName } = require('../utils/validate');

const router = express.Router();

// GET /api/databases — list all databases on the server.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const admin = req.mongoClient.db('admin').admin();
    const result = await admin.listDatabases();
    res.json(result);
  })
);

// POST /api/databases — create a database. MongoDB materializes a database
// only once it contains a collection, so a first collection is required.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, collection } = req.body || {};
    assertDbName(name);
    const firstCollection = collection && String(collection).trim() ? String(collection).trim() : 'default';
    assertCollectionName(firstCollection);
    await req.mongoClient.db(name).createCollection(firstCollection);
    res.status(201).json({ created: true, database: name, collection: firstCollection });
  })
);

// DELETE /api/databases/:db — drop an entire database.
router.delete(
  '/:db',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    assertDbName(db);
    await req.mongoClient.db(db).dropDatabase();
    res.json({ dropped: true, database: db });
  })
);

module.exports = router;
