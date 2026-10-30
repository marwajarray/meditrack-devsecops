const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const client = require('prom-client');

// VULN V3 : identifiants de base de données en dur dans le code
const DB_URL = process.env.DATABASE_URL ||
  'postgres://meditrack:meditrack123@localhost:5432/meditrack';
// VULN V4 : secret JWT trivial et jeton valable 30 jours
const JWT_SECRET = process.env.JWT_SECRET || 'secret';
const JWT_EXPIRES = '30d';

const pool = new Pool({ connectionString: DB_URL });

// ---------- Journaux JSON (sans mot de passe ni donnée de santé) ----------
function log(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...extra }));
}
function audit(event, detail = '') {
  log('warn', event, { detail });
  pool.query('INSERT INTO security_events(event, detail) VALUES($1,$2)', [event, detail])
    .catch(() => {});
}

// ---------- Métriques Prometheus ----------
client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Durée des requêtes HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2]
});

const app = express();
app.use(express.json());
// VULN V6 : CORS ouvert à tous, pas de helmet, en-tête X-Powered-By actif
app.use(cors());

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: (req.route && req.route.path) || 'inconnue', status: res.statusCode });
  });
  next();
});

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Authentification et rôles (BF1, BF3) ----------
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

// ---------- Santé et métriques (BF11) ----------
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/metrics', ah(async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}));

// ---------- Comptes (BF1, BF2) ----------
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

// ---------- Patient : dossier et rendez-vous (BF4, BF5) ----------
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

// Notes de rendez-vous (BF8)
// VULN V5 : la note est stockée telle quelle ; le frontend l'affichera sans échappement
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

// ---------- Médecin : recherche et dossiers (BF6, BF7) ----------
app.get('/api/patients', auth, role('doctor'), ah(async (req, res) => {
  const name = req.query.name || '';
  // VULN V1 : injection SQL, la saisie est concaténée dans la requête
  const sql = "SELECT id, full_name, birth_date FROM patients WHERE full_name ILIKE '%" + name + "%'";
  const r = await pool.query(sql);
  res.json(r.rows);
}));

// VULN V2 : IDOR, aucun contrôle que le dossier appartient à l'utilisateur
// ou que le patient est affecté à ce médecin
app.get('/api/patients/:id', auth, role('patient', 'doctor'), ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'patient introuvable' });
  res.json(r.rows[0]);
}));

app.put('/api/patients/:id/record', auth, role('doctor'), ah(async (req, res) => {
  const { diagnosis, treatment } = req.body || {};
  const r = await pool.query(
    'UPDATE patients SET diagnosis = $1, treatment = $2 WHERE id = $3 AND doctor_id = $4 RETURNING *',
    [diagnosis, treatment, req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'patient non affecté ou introuvable' });
  res.json(r.rows[0]);
}));

// ---------- Administrateur (BF9, BF10) ----------
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

// VULN V6 : le message d'erreur et la pile d'appels sont renvoyés au client
app.use((err, req, res, next) => {
  log('error', 'unhandled_error', { message: err.message });
  res.status(500).json({ error: err.message, stack: err.stack });
});

module.exports = app;
module.exports.pool = pool;
