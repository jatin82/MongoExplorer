const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const connectionManager = require('../connectionManager');

const router = express.Router();

const COOKIE_NAME = 'mongoConnId';
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  // `secure` is intentionally omitted: the app is served over http on
  // localhost. Do not deploy this remotely without enabling TLS.
};

// POST /api/connect — open a new connection from a runtime connection string.
router.post(
  '/connect',
  asyncHandler(async (req, res) => {
    const { uri } = req.body || {};
    const { connId, label } = await connectionManager.connect(uri);
    res.cookie(COOKIE_NAME, connId, cookieOptions);
    res.json({ connected: true, label });
  })
);

// POST /api/disconnect — close the current connection.
router.post(
  '/disconnect',
  asyncHandler(async (req, res) => {
    const connId = req.cookies ? req.cookies[COOKIE_NAME] : undefined;
    await connectionManager.disconnect(connId);
    res.clearCookie(COOKIE_NAME, cookieOptions);
    res.json({ connected: false });
  })
);

// GET /api/status — report whether the current cookie maps to a live client.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const connId = req.cookies ? req.cookies[COOKIE_NAME] : undefined;
    const client = connectionManager.getClient(connId);
    if (!client) {
      return res.json({ connected: false });
    }
    res.json({ connected: true, label: connectionManager.getLabel(connId) });
  })
);

module.exports = router;
