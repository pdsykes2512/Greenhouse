const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const apiRoutes = require('./routes/api');
const db = require('./database');
const alerts = require('./alerts');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// API routes
app.use('/api', apiRoutes);

// Serve static files (web UI). For files that frequently change (HTML shell,
// service worker, app code, manifest), tell the browser AND Cloudflare not
// to cache — this prevents stale versions sticking around at the edge.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const name = path.basename(filePath);
    if (name === 'sw.js' || name === 'index.html' || name === 'app.js' || name === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Root endpoint
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: 'Not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log('=================================');
  console.log('Greenhouse Control Server');
  console.log('=================================');
  console.log(`Server running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log('=================================');
});

// Start alert engine (scans every 60s for important events, fires push notifications)
alerts.start(60);

// Auto-clear pump override after 5 minutes
const PUMP_OVERRIDE_TIMEOUT_MINS = 5;
setInterval(() => {
  db.clearExpiredPumpOverride(PUMP_OVERRIDE_TIMEOUT_MINS, (err, cleared) => {
    if (err) return console.error('Pump timeout check error:', err);
    if (cleared > 0) console.log(`Pump override timed out after ${PUMP_OVERRIDE_TIMEOUT_MINS} minutes — auto-cleared`);
  });
}, 30 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});
