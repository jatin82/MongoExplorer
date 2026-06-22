const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName } = require('../utils/validate');
const { serialize } = require('../utils/ejson');

const router = express.Router();

// GET /api/stats/server — full serverStatus for the connected node.
// Defined before the "/:db" route so the literal path takes precedence.
router.get(
  '/server',
  asyncHandler(async (req, res) => {
    const status = await req.mongoClient.db('admin').admin().serverStatus();
    res.json({ status: serialize(status) });
  })
);

// GET /api/stats/databases — server-wide database size overview.
router.get(
  '/databases',
  asyncHandler(async (req, res) => {
    const result = await req.mongoClient.db('admin').admin().listDatabases();
    res.json(result);
  })
);

// GET /api/stats/:db — storage statistics for a single database.
router.get(
  '/:db',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    assertDbName(db);
    const stats = await req.mongoClient.db(db).command({ dbStats: 1 });
    res.json({ stats: serialize(stats) });
  })
);

module.exports = router;
