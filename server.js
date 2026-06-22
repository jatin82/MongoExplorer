const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requireConnection, closeAll } = require('./src/connectionManager');

const connectionRoutes = require('./src/routes/connection');
const databaseRoutes = require('./src/routes/databases');
const collectionRoutes = require('./src/routes/collections');
const documentRoutes = require('./src/routes/documents');
const indexRoutes = require('./src/routes/indexes');
const userRoutes = require('./src/routes/users');
const statsRoutes = require('./src/routes/stats');

const app = express();

// Body + cookie parsing. The 5mb limit comfortably covers large documents.
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Static frontend.
app.use(express.static(path.join(__dirname, 'public')));

// Connection lifecycle is open (it is how you obtain a session); everything
// else requires an active connection resolved from the mongoConnId cookie.
app.use('/api', connectionRoutes);
app.use('/api/databases', requireConnection, databaseRoutes);
app.use('/api/databases', requireConnection, collectionRoutes);
app.use('/api/databases', requireConnection, documentRoutes);
app.use('/api/databases', requireConnection, indexRoutes);
app.use('/api/users', requireConnection, userRoutes);
app.use('/api/stats', requireConnection, statsRoutes);

// 404 for unknown API routes (after all route handlers, before the error
// handler so unmatched paths get a clean JSON 404).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler — converts thrown/rejected errors into JSON. Mongo
// driver errors carry useful codeName/codes that we pass through.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // If a response (e.g. a CSV stream) already began, we cannot send JSON.
  if (res.headersSent) {
    console.error('[MongoExplorer] Error after response started:', err);
    return res.end();
  }
  const status = err.status || 500;
  const payload = { error: err.message || 'Internal Server Error' };
  if (err.codeName) payload.codeName = err.codeName;
  if (typeof err.code === 'number' || typeof err.code === 'string') payload.code = err.code;
  if (status >= 500) {
    // Log server-side faults without leaking them to clients verbatim.
    console.error('[MongoExplorer] Unhandled error:', err);
  }
  res.status(status).json(payload);
});

const PORT = process.env.PORT || 3000;
// Bind to loopback only: this server brokers raw database credentials and must
// not be exposed on the network.
const HOST = process.env.HOST || '127.0.0.1';

// Loopback-only HTTP is intentional: traffic never leaves the machine. Switch
// `scheme` (and add a TLS terminator) only if you expose this beyond localhost.
const scheme = process.env.SCHEME || 'http';
const server = app.listen(PORT, HOST, () => {
  console.log(`MongoExplorer running at ${scheme}://${HOST}:${PORT}`);
});

// Graceful shutdown: close DB connections so mongod sees clean disconnects.
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await closeAll();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
