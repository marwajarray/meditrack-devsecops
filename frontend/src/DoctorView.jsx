import { useState } from 'react';
import { searchPatients, getPatient } from './api';

export default function DoctorView() {
  const [name, setName] = useState('');
  const [results, setResults] = useState([]);
  const [detail, setDetail] = useState(null);

  async function search(e) {
    e.preventDefault();
    setResults(await searchPatients(name));
  }
  async function open(id) {
    setDetail(await getPatient(id));
  }

  return (
    <div className="card">
      <h2>Recherche de patients</h2>
      <form onSubmit={search}>
        <label htmlFor="q">Nom du patient</label>
        <input id="q" placeholder="Ex. Amel" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Rechercher</button>
      </form>

      {results.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {results.map((p) => (
            <div key={p.id} className="patient-row">
              <span>{p.full_name}</span>
              <button onClick={() => open(p.id)}>Voir le dossier</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <div className="record-box" style={{ marginTop: 16 }}>
          <span className="name">{detail.full_name}</span>
          <span className="meta">{detail.diagnosis || '—'} · {detail.treatment || '—'}</span>
        </div>
      )}
    </div>
  );
}
