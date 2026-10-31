import { useState } from 'react';
import { login } from './api';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const data = await login(email, password);
      localStorage.setItem('token', data.token);
      localStorage.setItem('role', data.role);
      localStorage.setItem('full_name', data.full_name);
      onLogin(data.role);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">
          <div className="brand-badge">M</div>
          <div>
            <h2>MediTrack</h2>
            <span>Espace sécurisé</span>
          </div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="email">Adresse e-mail</label>
          <input id="email" placeholder="patient1@meditrack.test" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="pwd">Mot de passe</label>
          <input id="pwd" placeholder="••••••••" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit">Se connecter</button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Comptes de test :<br />
          patient1@meditrack.test / Patient123!<br />
          doctor1@meditrack.test / Doctor123!
        </p>
      </div>
    </div>
  );
}
