require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./db');

// Creates the complaints table/sequence if they don't exist yet. Safe to run
// every cold start — CREATE TABLE IF NOT EXISTS is a no-op once it exists.
db.initSchema().catch((err) => console.error('Failed to initialize database schema', err));

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn(
    '\n[WARNING] JWT_SECRET is not set. Set it as an environment variable before deploying, ' +
      'e.g. JWT_SECRET=$(openssl rand -hex 32). Using an insecure fallback for now.\n'
  );
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'insecure-dev-secret-change-me';
const COOKIE_NAME = 'll_session';

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ---------- auth helpers ----------
function setSessionCookie(res, user) {
  const token = jwt.sign(user, EFFECTIVE_JWT_SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12,
  });
}
function readUserFromCookie(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const { role, displayName, checkerType } = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    return { role, displayName, checkerType: checkerType || null };
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const user = readUserFromCookie(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    const user = readUserFromCookie(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    if (user.role !== role) return res.status(403).json({ error: `Only ${role} accounts can do this.` });
    req.user = user;
    next();
  };
}

// ---------- auth routes ----------
// No individual accounts. Two shared access codes gate the two roles;
// each person types their own name (and, for checkers, who they're acting
// as) every time they sign in — that name/role is what lands in the audit
// trail on every action they take.
const CHECKER_TYPES = ['Resident', 'RWA Committee Member', 'Estate Office Staff'];

app.post('/api/login', loginLimiter, async (req, res) => {
  const { role, code, name, checkerType } = req.body || {};
  if (!role || !code || !name) {
    return res.status(400).json({ error: 'Role, access code, and your name are all required.' });
  }
  if (role !== 'staff' && role !== 'checker') {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const STAFF_CODE = process.env.STAFF_ACCESS_CODE;
  const CHECKER_CODE = process.env.CHECKER_ACCESS_CODE;
  const expected = role === 'staff' ? STAFF_CODE : CHECKER_CODE;
  if (!expected) {
    return res.status(503).json({ error: `${role === 'staff' ? 'STAFF_ACCESS_CODE' : 'CHECKER_ACCESS_CODE'} is not set up yet. Add it in Vercel's Environment Variables.` });
  }
  if (code !== expected) {
    return res.status(401).json({ error: 'Incorrect access code.' });
  }

  let resolvedCheckerType = null;
  if (role === 'checker') {
    if (!CHECKER_TYPES.includes(checkerType)) {
      return res.status(400).json({ error: 'Please choose who you are acting as.' });
    }
    resolvedCheckerType = checkerType;
  }

  const sessionUser = {
    role,
    displayName: name.trim(),
    checkerType: resolvedCheckerType,
  };
  setSessionCookie(res, sessionUser);
  res.json({ user: sessionUser });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ user: readUserFromCookie(req) });
});

// ---------- complaint constants ----------
const CATEGORIES = [
  'Plumbing', 'Electricity', 'Paint', 'Car Parking', 'Carpenting',
  'Civil Work', 'Common Area', 'Horticulture', 'Housekeeping', 'Lift', 'Security',
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

function makeAudit(action, user, remark) {
  return {
    action,
    actor: user.displayName,
    role: user.role,
    checkerType: user.checkerType || null,
    remark: remark || '',
    timestamp: new Date().toISOString(),
  };
}

// ---------- complaint routes ----------
app.get('/api/complaints', requireAuth, async (req, res) => {
  const complaints = await db.getComplaints();
  res.json({ complaints, categories: CATEGORIES, priorities: PRIORITIES });
});

app.post('/api/complaints', requireRole('staff'), async (req, res) => {
  const { tower, unit, residentName, category, priority, description } = req.body || {};
  if (!tower || !unit || !description || !category || !priority) {
    return res.status(400).json({ error: 'Tower, unit, category, priority and description are required.' });
  }
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });

  const complaint = await db.createComplaint({
    tower: String(tower).trim(),
    unit: String(unit).trim(),
    residentName: (residentName || '').trim(),
    category,
    priority,
    description: String(description).trim(),
    loggedBy: req.user.displayName,
    auditEntry: makeAudit('Logged', req.user, 'Entry recorded by estate office.'),
  });
  res.status(201).json({ complaint });
});

app.post('/api/complaints/:id/approve', requireRole('checker'), async (req, res) => {
  const result = await db.updateComplaint(req.params.id, ['Pending Review'], () => ({
    status: 'Approved',
    checker: req.user.displayName,
    auditEntry: makeAudit('Approved', req.user, req.body?.remark || ''),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Entry not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only entries pending review can be approved.' });
  res.json({ complaint: result.complaint });
});

app.post('/api/complaints/:id/return', requireRole('checker'), async (req, res) => {
  const remark = (req.body?.remark || '').trim();
  if (!remark) return res.status(400).json({ error: 'A remark is required when returning an entry.' });
  const result = await db.updateComplaint(req.params.id, ['Pending Review', 'Resolved'], () => ({
    status: 'Returned',
    checker: req.user.displayName,
    auditEntry: makeAudit('Returned for correction', req.user, remark),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Entry not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'This entry cannot be returned from its current status.' });
  res.json({ complaint: result.complaint });
});

app.post('/api/complaints/:id/resubmit', requireRole('staff'), async (req, res) => {
  const result = await db.updateComplaint(req.params.id, ['Returned'], () => ({
    status: 'Pending Review',
    auditEntry: makeAudit('Resubmitted', req.user, req.body?.remark || ''),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Entry not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only returned entries can be resubmitted.' });
  res.json({ complaint: result.complaint });
});

app.post('/api/complaints/:id/resolve', requireRole('staff'), async (req, res) => {
  const remark = (req.body?.remark || '').trim();
  if (!remark) return res.status(400).json({ error: 'Please describe how this was resolved.' });
  const result = await db.updateComplaint(req.params.id, ['Approved'], () => ({
    status: 'Resolved',
    resolutionNotes: remark,
    auditEntry: makeAudit('Marked resolved by staff', req.user, remark),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Entry not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only approved entries can be marked resolved.' });
  res.json({ complaint: result.complaint });
});

app.post('/api/complaints/:id/verify', requireRole('checker'), async (req, res) => {
  const result = await db.updateComplaint(req.params.id, ['Resolved'], () => ({
    status: 'Verified & Closed',
    auditEntry: makeAudit('Verified and closed', req.user, req.body?.remark || ''),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Entry not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only resolved entries can be verified and closed.' });
  res.json({ complaint: result.complaint });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// When run directly (`node server.js`, e.g. local dev or a VPS), start listening.
// When imported (e.g. by api/index.js on Vercel), just export the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`La Lagune complaint tracker running on port ${PORT}`);
  });
}

module.exports = app;
