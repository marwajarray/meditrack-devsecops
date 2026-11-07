const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const client = require('prom-client');

const DB_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
if (!DB_URL || !JWT_SECRET) {
  console.error('DATABASE_URL et JWT_SECRET sont obligatoires');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL });

function log(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...extra }));
}
function audit(event, detail = '') {
  log('warn', event, { detail });
  pool.query('INSERT INTO security_events(event, detail) VALUES($1,$2)', [event, detail]).catch(() => {});
}

client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const app = express();
app.disable('x-powered-by');
app.use(helmet());
const allowed = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allowed.length ? allowed : false, credentials: true }));
app.use(express.json());

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: (req.route && req.route.path) || 'inconnue', status: res.statusCode });
  });
  next();
});

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'token manquant' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'token invalide' });
  }
  next();
}
function role(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.user.role)) return next();
    audit('access_denied', `user=${req.user.id} role=${req.user.role} path=${req.path}`);
    return res.status(403).json({ error: 'interdit' });
  };
}

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/metrics', ah(async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}));

app.post('/api/auth/register', ah(async (req, res) => {
  const { email, password, full_name } = req.body || {};
  if (!email || !password || !full_name) return res.status(400).json({ error: 'champs manquants' });
  const hash = await bcrypt.hash(password, 10);
  const u = await pool.query(
    "INSERT INTO users(email,password_hash,role,full_name) VALUES($1,$2,'patient',$3) RETURNING id",
    [email, hash, full_name]
  );
  await pool.query('INSERT INTO patients(user_id, full_name) VALUES($1,$2)', [u.rows[0].id, full_name]);
  log('info', 'register', { user: u.rows[0].id });
  res.status(201).json({ id: u.rows[0].id });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const u = r.rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password || '', u.password_hash))) {
    audit('login_failed', `email=${email}`);
    return res.status(401).json({ error: 'identifiants invalides' });
  }
  const token = jwt.sign({ id: u.id, role: u.role, email: u.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  log('info', 'login_success', { user: u.id, role: u.role });
  res.json({ token, role: u.role, full_name: u.full_name });
}));

app.get('/api/me/patient', auth, role('patient'), ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM patients WHERE user_id = $1', [req.user.id]);
  res.json(r.rows[0] || null);
}));

app.get('/api/appointments', auth, ah(async (req, res) => {
  let r;
  if (req.user.role === 'patient') {
    r = await pool.query(
      `SELECT a.* FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE p.user_id = $1 ORDER BY a.scheduled_at`, [req.user.id]);
  } else if (req.user.role === 'doctor') {
    r = await pool.query('SELECT * FROM appointments WHERE doctor_id = $1 ORDER BY scheduled_at', [req.user.id]);
  } else {
    r = await pool.query('SELECT * FROM appointments ORDER BY scheduled_at');
  }
  res.json(r.rows);
}));

app.post('/api/appointments', auth, role('patient'), ah(async (req, res) => {
  const { doctor_id, scheduled_at } = req.body || {};
  if (!doctor_id || !scheduled_at) return res.status(400).json({ error: 'champs manquants' });
  const p = await pool.query('SELECT id FROM patients WHERE user_id = $1', [req.user.id]);
  if (!p.rows[0]) return res.status(404).json({ error: 'dossier introuvable' });
  const r = await pool.query(
    'INSERT INTO appointments(patient_id, doctor_id, scheduled_at) VALUES($1,$2,$3) RETURNING *',
    [p.rows[0].id, doctor_id, scheduled_at]);
  res.status(201).json(r.rows[0]);
}));

app.delete('/api/appointments/:id', auth, role('patient'), ah(async (req, res) => {
  const r = await pool.query(
    `UPDATE appointments SET status = 'cancelled'
     WHERE id = $1 AND patient_id = (SELECT id FROM patients WHERE user_id = $2) RETURNING id`,
    [req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'rendez-vous introuvable' });
  res.json({ cancelled: r.rows[0].id });
}));

app.post('/api/appointments/:id/notes', auth, role('patient', 'doctor'), ah(async (req, res) => {
  const a = await pool.query(
    `SELECT a.*, p.user_id AS patient_user FROM appointments a
     JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`, [req.params.id]);
  const row = a.rows[0];
  if (!row) return res.status(404).json({ error: 'rendez-vous introuvable' });
  const ok = (req.user.role === 'patient' && row.patient_user === req.user.id) ||
             (req.user.role === 'doctor' && row.doctor_id === req.user.id);
  if (!ok) {
    audit('access_denied', `user=${req.user.id} appointment=${row.id}`);
    return res.status(403).json({ error: 'interdit' });
  }
  const note = (req.body && req.body.notes) || '';
  const r = await pool.query(
    "UPDATE appointments SET notes = COALESCE(notes,'') || $1 || E'\\n' WHERE id = $2 RETURNING *",
    [note, req.params.id]);
  res.json(r.rows[0]);
}));

app.get('/api/patients', auth, role('doctor'), ah(async (req, res) => {
  const name = req.query.name || '';
  const r = await pool.query(
    "SELECT id, full_name, birth_date FROM patients WHERE full_name ILIKE '%' || $1 || '%'",
    [name]);
  res.json(r.rows);
}));

app.get('/api/patients/:id', auth, role('patient', 'doctor'), ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
  const p = r.rows[0];
  if (!p) return res.status(404).json({ error: 'patient introuvable' });
  const ok = (req.user.role === 'patient' && p.user_id === req.user.id) ||
             (req.user.role === 'doctor' && p.doctor_id === req.user.id);
  if (!ok) {
    audit('access_denied', `user=${req.user.id} patient=${p.id}`);
    return res.status(403).json({ error: 'interdit' });
  }
  res.json(p);
}));

app.put('/api/patients/:id/record', auth, role('doctor'), ah(async (req, res) => {
  const { diagnosis, treatment } = req.body || {};
  const r = await pool.query(
    'UPDATE patients SET diagnosis = $1, treatment = $2 WHERE id = $3 AND doctor_id = $4 RETURNING *',
    [diagnosis, treatment, req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'patient non affecte ou introuvable' });
  res.json(r.rows[0]);
}));

app.get('/api/admin/users', auth, role('admin'), ah(async (req, res) => {
  const r = await pool.query('SELECT id, email, role, full_name, active FROM users ORDER BY id');
  res.json(r.rows);
}));

app.post('/api/admin/users', auth, role('admin'), ah(async (req, res) => {
  const { email, password, role: newRole, full_name } = req.body || {};
  if (!email || !password || !newRole || !full_name) return res.status(400).json({ error: 'champs manquants' });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    'INSERT INTO users(email,password_hash,role,full_name) VALUES($1,$2,$3,$4) RETURNING id, email, role',
    [email, hash, newRole, full_name]);
  res.status(201).json(r.rows[0]);
}));

app.patch('/api/admin/users/:id', auth, role('admin'), ah(async (req, res) => {
  const { active, role: newRole } = req.body || {};
  const r = await pool.query(
    'UPDATE users SET active = COALESCE($1, active), role = COALESCE($2, role) WHERE id = $3 RETURNING id, email, role, active',
    [active, newRole, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'utilisateur introuvable' });
  res.json(r.rows[0]);
}));

app.get('/api/admin/events', auth, role('admin'), ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM security_events ORDER BY ts DESC LIMIT 200');
  res.json(r.rows);
}));

app.use((err, req, res, next) => {
  log('error', 'unhandled_error', { message: err.message });
  res.status(500).json({ error: 'erreur interne' });
});

module.exports = app;
module.exports.pool = pool;
