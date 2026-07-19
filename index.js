// Vercel wraps this file as a serverless function. It just re-exports the
// Express app from server.js — vercel.json routes every request here.
module.exports = require('../server');
