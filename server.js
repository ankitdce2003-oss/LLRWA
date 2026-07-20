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
function requireAnyRole(...roles) {
  return (req, res, next) => {
    const user = readUserFromCookie(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: `Only ${roles.join(' or ')} accounts can do this.` });
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
  if (!['staff', 'checker', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const CODE_ENV = { staff: 'STAFF_ACCESS_CODE', checker: 'CHECKER_ACCESS_CODE', admin: 'ADMIN_ACCESS_CODE' }[role];
  const expected = process.env[CODE_ENV];
  if (!expected) {
    return res.status(503).json({ error: `${CODE_ENV} is not set up yet. Add it in Vercel's Environment Variables.` });
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
const WORK_LOCATIONS = [
  'Balcony Front', 'Balcony Back', 'Refuge Area', 'External Wall', 'Flat Grill',
  'Tower Lobby', 'Staircases', 'Basement 1', 'Basement 2', 'Others',
];
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
  res.json({ tasks, workLocations: WORK_LOCATIONS });
});

app.post('/api/tasks', requireAnyRole('staff', 'admin'), async (req, res) => {
  const { workLocation, workLocationOther, tower, flatNumber, contractorName, description, photos } = req.body || {};
  if (!workLocation || !description) {
    return res.status(400).json({ error: 'Work location and scope of work are required.' });
  }
  if (!WORK_LOCATIONS.includes(workLocation)) {
    return res.status(400).json({ error: 'Invalid work location.' });
  }
  const otherText = (workLocationOther || '').trim();
  if (workLocation === 'Others' && !otherText) {
    return res.status(400).json({ error: 'Please specify the work location.' });
  }
  const validPhotos = validatePhotos(photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });

  const payload = {
    workLocation,
    workLocationOther: workLocation === 'Others' ? otherText : '',
    tower: (tower || '').trim(),
    flatNumber: (flatNumber || '').trim(),
    contractorName: (contractorName || '').trim(),
    description: String(description).trim(),
  };

  // Admins can intentionally create a duplicate (e.g. a correction or a
  // deliberate re-do); the duplicate guard only applies to normal staff use.
  if (req.user.role !== 'admin') {
    const duplicateId = await db.findActiveDuplicate(payload);
    if (duplicateId) {
      return res.status(409).json({ error: `An identical task is already active (${duplicateId}). Please check the register before logging it again.` });
    }
  }

  const task = await db.createTask({
    ...payload,
    loggedBy: req.user.displayName,
    auditEntry: makeAudit('Task created', req.user, 'Task created — not yet sent for inspection.', validPhotos),
  });
  res.status(201).json({ task });
});

app.post('/api/tasks/:id/mark-ready', requireAnyRole('staff', 'admin'), async (req, res) => {
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  const gate = req.user.role === 'admin' ? null : ['Assigned to Contractor', 'Rework Needed'];
  const result = await db.updateTask(req.params.id, gate, () => ({
    status: 'Submitted for Inspection',
    auditEntry: makeAudit('Sent for inspection', req.user, req.body?.remark || '', validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only tasks assigned to the contractor or needing rework can be sent for inspection.' });
  res.json({ task: result.task });
});

app.post('/api/tasks/:id/approve', requireAnyRole('checker', 'admin'), async (req, res) => {
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  const gate = req.user.role === 'admin' ? null : ['Submitted for Inspection'];
  const result = await db.updateTask(req.params.id, gate, () => ({
    status: 'Approved',
    checker: req.user.displayName,
    auditEntry: makeAudit('Approved', req.user, req.body?.remark || '', validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only tasks submitted for inspection can be approved.' });
  res.json({ task: result.task });
});

app.post('/api/tasks/:id/return', requireAnyRole('checker', 'admin'), async (req, res) => {
  const remark = (req.body?.remark || '').trim();
  if (!remark) return res.status(400).json({ error: 'Please explain what needs rework.' });
  const validPhotos = validatePhotos(req.body?.photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });
  const gate = req.user.role === 'admin' ? null : ['Submitted for Inspection'];
  const result = await db.updateTask(req.params.id, gate, () => ({
    status: 'Rework Needed',
    checker: req.user.displayName,
    auditEntry: makeAudit('Returned — rework needed', req.user, remark, validPhotos),
  }));
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
  if (result.error === 'bad_status') return res.status(409).json({ error: 'Only tasks submitted for inspection can be returned.' });
  res.json({ task: result.task });
});

// Admin-only: edit any field on a task and/or force its status directly,
// regardless of the normal workflow order. Used for corrections — e.g.
// fixing a typo in an already-Approved task, or reversing a mistaken
// approval.
const ALL_STATUSES = ['Assigned to Contractor', 'Submitted for Inspection', 'Approved', 'Rework Needed'];

app.patch('/api/tasks/:id', requireRole('admin'), async (req, res) => {
  const { workLocation, workLocationOther, tower, flatNumber, contractorName, description, status, remark, photos } = req.body || {};

  if (workLocation !== undefined && !WORK_LOCATIONS.includes(workLocation)) {
    return res.status(400).json({ error: 'Invalid work location.' });
  }
  if (workLocation === 'Others' && !((workLocationOther || '').trim())) {
    return res.status(400).json({ error: 'Please specify the work location.' });
  }
  if (status !== undefined && !ALL_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (description !== undefined && !String(description).trim()) {
    return res.status(400).json({ error: 'Scope of work cannot be blank.' });
  }
  const validPhotos = validatePhotos(photos);
  if (validPhotos === null) return res.status(400).json({ error: `Please attach at most ${MAX_PHOTOS_PER_ACTION} photos.` });

  const fields = {
    workLocation,
    workLocationOther: workLocation === 'Others' ? (workLocationOther || '').trim() : (workLocation !== undefined ? '' : undefined),
    tower: tower !== undefined ? tower.trim() : undefined,
    flatNumber: flatNumber !== undefined ? flatNumber.trim() : undefined,
    contractorName: contractorName !== undefined ? contractorName.trim() : undefined,
    description: description !== undefined ? String(description).trim() : undefined,
    status,
  };

  const result = await db.adminUpdateTask(
    req.params.id,
    fields,
    makeAudit('Edited by admin', req.user, remark || '', validPhotos)
  );
  if (result.error === 'not_found') return res.status(404).json({ error: 'Task not found.' });
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
