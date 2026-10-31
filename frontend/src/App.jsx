import { useState } from 'react';
import Login from './Login';
import PatientView from './PatientView';
import DoctorView from './DoctorView';

const ROLE_LABEL = { patient: 'Patient', doctor: 'Médecin', admin: 'Admin' };

export default function App() {
  const [role, setRole] = useState(localStorage.getItem('role'));

  function logout() {
    localStorage.clear();
    setRole(null);
  }

  if (!role) return <Login onLogin={setRole} />;

  return (
    <div className="app">
      <header className="topbar">
        <h1>MediTrack</h1>
        <div className="user-chip">
          {localStorage.getItem('full_name')}
          <span className="role-badge">{ROLE_LABEL[role] || role}</span>
        </div>
        <button className="btn-ghost" onClick={logout}>Déconnexion</button>
      </header>
      {role === 'patient' && <PatientView />}
      {role === 'doctor' && <DoctorView />}
      {role === 'admin' && <div className="card"><p>Espace administrateur (à venir).</p></div>}
    </div>
  );
}
