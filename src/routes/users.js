const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { assertDbName } = require('../utils/validate');

const router = express.Router();

router.param('db', (req, res, next, db) => {
  try {
    assertDbName(db);
    next();
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:db — list users defined on a database.
router.get(
  '/:db',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    const result = await req.mongoClient.db(db).command({ usersInfo: 1 });
    res.json({ users: result.users || [] });
  })
);

// POST /api/users/:db — create a user on a database.
// Body: { username, password, roles } where roles is an array of strings or
// { role, db } objects.
router.post(
  '/:db',
  asyncHandler(async (req, res) => {
    const { db } = req.params;
    const { username, password, roles } = req.body || {};
    if (!username || typeof username !== 'string') {
      const err = new Error('"username" is required.');
      err.status = 400;
      throw err;
    }
    if (!password || typeof password !== 'string') {
      const err = new Error('"password" is required.');
      err.status = 400;
      throw err;
    }
    const rolesArr = Array.isArray(roles) ? roles : [];
    await req.mongoClient.db(db).command({
      createUser: username,
      pwd: password,
      roles: rolesArr,
    });
    res.status(201).json({ created: true, user: username });
  })
);

// PUT /api/users/:db/:username/roles — grant and/or revoke roles.
// Body: { grant: [...], revoke: [...] }.
router.put(
  '/:db/:username/roles',
  asyncHandler(async (req, res) => {
    const { db, username } = req.params;
    const { grant, revoke } = req.body || {};
    const database = req.mongoClient.db(db);
    if (Array.isArray(grant) && grant.length) {
      await database.command({ grantRolesToUser: username, roles: grant });
    }
    if (Array.isArray(revoke) && revoke.length) {
      await database.command({ revokeRolesFromUser: username, roles: revoke });
    }
    res.json({ updated: true, user: username });
  })
);

// DELETE /api/users/:db/:username — drop a user.
router.delete(
  '/:db/:username',
  asyncHandler(async (req, res) => {
    const { db, username } = req.params;
    await req.mongoClient.db(db).command({ dropUser: username });
    res.json({ dropped: true, user: username });
  })
);

module.exports = router;
