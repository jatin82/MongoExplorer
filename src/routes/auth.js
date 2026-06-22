const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const auth = require('../utils/auth');

const router = express.Router();

// POST /api/auth/login — exchange the access key for an encrypted-JWT session.
router.post(
  '/login',
  auth.loginGuard,
  asyncHandler(async (req, res) => {
    const { key } = req.body || {};
    const ok = auth.verifyAccessKey(key);
    auth.noteLoginResult(req, ok);
    if (!ok) {
      // Generic message — never reveal whether the length/format was "close".
      const err = new Error('Invalid access key.');
      err.status = 401;
      err.code = 'AUTH_FAILED';
      throw err;
    }
    const token = await auth.issueToken({ role: 'admin' });
    res.cookie(auth.COOKIE_NAME, token, auth.cookieOptions());
    res.json({ authenticated: true });
  })
);

// POST /api/auth/logout — clear the session cookie.
router.post('/logout', (req, res) => {
  res.clearCookie(auth.COOKIE_NAME, auth.clearCookieOptions());
  res.json({ authenticated: false });
});

// GET /api/auth/status — report whether the current cookie is a valid session.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const token = req.cookies ? req.cookies[auth.COOKIE_NAME] : undefined;
    if (!token) return res.json({ authenticated: false });
    try {
      await auth.verifyToken(token);
      return res.json({ authenticated: true });
    } catch {
      return res.json({ authenticated: false });
    }
  })
);

module.exports = router;
