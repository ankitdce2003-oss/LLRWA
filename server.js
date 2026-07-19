require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./db');

// Creates the tasks table/sequence if they don't exist yet. Safe to run
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
// The frontend is a single HTML file with an inline <script> and <style>
// block (no build step / bundler), so the default CSP — which blocks
// inline scripts and styles — has to be relaxed for those two directives.
// img-src allows data: URIs since photos are stored/sent as base64.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);
// Raised from Express's 100kb default to accommodate a handful of
// compressed photos per request (photos are compressed client-side before
// upload, but several at once can still add up).
app.use(express.json({ limit: '20mb' }));
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

  const sessionUser = { role, displayName: name.trim(), checkerType: resolvedCheckerType };
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

// ---------- task constants ----------
const CATEGORIES = [
  'Exterior Walls', 'Common Area / Corridors', 'Compound Wall', 'Clubhouse',
  'Parking Area', 'Terrace / Roof', 'Garden / Landscape Structures',
  'Main Gate / Entrance', 'Staircase', 'Other',
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const MAX_PHOTOS_PER_ACTION = 6;
const MAX_PHOTO_CHARS = 2_000_000; // ~1.5MB raw per photo after base64 overhead

function validatePhotos(photos) {
  if (photos === undefined || photos === null) return [];
  if (!Array.isArray(photos)) return null;
  if (photos.length > MAX_PHOTOS_PER_ACTION) return null;
  for (const p of photos) {
    if (typeof p !== 'string' || !p.startsWith('data:image/') || p.length > MAX_PHOTO_CHARS) {
      return null;
    }
  }
  return photos;
}

function makeAudit(action, user, remark, photos) {
  return {
    action,
    actor: user.displayName,
    role: user.role,
    checkerType: user.checkerType || null,
    remark: remark || '',
    photos: photos || [],
    timestamp: new Date().toISOString(),
  };
}

// ---------- task routes ----------
app.get('/api/tasks', requireAuth, async (req, res) => {
  const tasks = await db.getTasks();
  res.json({ tasks, categories: CATEGORIES, priorities: PRIORITIES });
});

app.post('/api/tasks', requireRole('staff'), async (req, res) => {
  const { category, tower, locationDetail, contractorName, priority, description, photos } = req.body || {};
  if (!category || !locationDetail || !priority || !description) {
    return res.status(400).json({ error: 'Category, location, priority and scope of work are all required.' });
  }
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });
  const validPhotos = validatePhotos(photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });

  const task = await db.createTask({
    category,
    tower: (tower || '').trim(),
    locationDetail: String(locationDetail).trim(),
    contractorName: (contractorName || '').trim(),
    priority,
    description: String(description).trim(),
    loggedBy: req.user.displayName,
    auditEntry: makeAudit('Task assigned', req.user, 'Task created and assigned to contractor.', validPhotos),
  });
  res.status(201).json({ task });
});

app.post('/api/tasks/:id/mark-ready', requireRole('staff'), async (req, res) => {
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  if (validPhotos.length === 0) {
    return res.status(400).json({ error: 'Please attach at least one photo of the completed work.' });
  }
  const result = await db.updateTask(req.params.id, ['Assigned', 'Rework Needed'], () => ({
    status: 'Submitted for Inspection',
    auditEntry: makeAudit('Submitted for inspection', req.user, req.body?.remark || '', validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only assigned or rework-needed tasks can be submitted for inspection.' });
  res.json({ task: result.task });
});

app.post('/api/tasks/:id/approve', requireRole('checker'), async (req, res) => {
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  const result = await db.updateTask(req.params.id, ['Submitted for Inspection'], () => ({
    status: 'Approved',
    checker: req.user.displayName,
    auditEntry: makeAudit('Approved', req.user, req.body?.remark || '', validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only tasks submitted for inspection can be approved.' });
  res.json({ task: result.task });
});

app.post('/api/tasks/:id/return', requireRole('checker'), async (req, res) => {
  const remark = (req.body?.remark || '').trim();
  if (!remark) return res.status(400).json({ error: 'Please explain what needs rework.' });
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  const result = await db.updateTask(req.params.id, ['Submitted for Inspection'], () => ({
    status: 'Rework Needed',
    checker: req.user.displayName,
    auditEntry: makeAudit('Returned — rework needed', req.user, remark, validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only tasks submitted for inspection can be returned.' });
  res.json({ task: result.task });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`La Lagune painting project tracker running on port ${PORT}`);
  });
}

module.exports = app;
