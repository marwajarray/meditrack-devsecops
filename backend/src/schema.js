const bcrypt = require('bcryptjs');

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  full_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  full_name TEXT NOT NULL,
  birth_date DATE,
  diagnosis TEXT DEFAULT '',
  treatment TEXT DEFAULT '',
  doctor_id INT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  patient_id INT REFERENCES patients(id),
  doctor_id INT REFERENCES users(id),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS security_events (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  event TEXT NOT NULL,
  detail TEXT DEFAULT ''
);`;

async function addUser(pool, email, pwd, role, name) {
  const hash = await bcrypt.hash(pwd, 10);
  const r = await pool.query(
    'INSERT INTO users(email,password_hash,role,full_name) VALUES($1,$2,$3,$4) RETURNING id',
    [email, hash, role, name]
  );
  return r.rows[0].id;
}

// Données entièrement fictives
// VULN V3 : mots de passe de test écrits en clair dans le code source
async function init(pool) {
  await pool.query(DDL);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  await addUser(pool, 'admin@meditrack.test', 'Admin123!', 'admin', 'Admin Fictif');
  const doc = await addUser(pool, 'doctor1@meditrack.test', 'Doctor123!', 'doctor', 'Dr. Sami Ben Ali');
  const patients = [
    ['patient1@meditrack.test', 'Amel Trabelsi', '1990-04-12', 'Hypertension', 'Amlodipine 5 mg'],
    ['patient2@meditrack.test', 'Karim Gharbi', '1985-09-30', 'Diabète de type 2', 'Metformine 850 mg'],
    ['patient3@meditrack.test', 'Salma Jebali', '1978-01-22', 'Asthme', 'Salbutamol']
  ];
  for (const [email, name, bd, dg, tr] of patients) {
    const uid = await addUser(pool, email, 'Patient123!', 'patient', name);
    await pool.query(
      'INSERT INTO patients(user_id,full_name,birth_date,diagnosis,treatment,doctor_id) VALUES($1,$2,$3,$4,$5,$6)',
      [uid, name, bd, dg, tr, doc]
    );
  }
}

module.exports = { init };
