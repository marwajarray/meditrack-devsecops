import { useEffect, useState } from 'react';
import { getMyRecord, getAppointments, addNote } from './api';

export default function PatientView() {
  const [record, setRecord] = useState(null);
  const [appts, setAppts] = useState([]);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState(null);

  async function refresh() {
    setRecord(await getMyRecord());
    setAppts(await getAppointments());
  }
  useEffect(() => {
    let active = true;
    Promise.all([getMyRecord(), getAppointments()])
      .then(([r, a]) => { if (active) { setRecord(r); setAppts(a); } })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function submitNote(e) {
    e.preventDefault();
    if (!selected) return;
    await addNote(selected, note);
    setNote('');
    refresh();
  }

  return (
    <div className="card">
      <h2>Mon dossier médical</h2>
      {record && (
        <div className="record-box">
          <span className="name">{record.full_name}</span>
          <span className="meta">{record.diagnosis || 'Aucun diagnostic'} · {record.treatment || 'Aucun traitement'}</span>
        </div>
      )}

      <h3>Mes rendez-vous</h3>
      {appts.length === 0 && <div className="empty-state">Aucun rendez-vous pour le moment.</div>}
      <ul className="appt-list">
        {appts.map((a) => (
          <li key={a.id} className="appt-item">
            <div className="appt-top">
              <button className={"appt-id" + (selected === a.id ? " selected" : "")} onClick={() => setSelected(a.id)}>#{a.id}</button>
              <span className="appt-date">{new Date(a.scheduled_at).toLocaleString('fr-FR')}</span>
              <span className={"status-pill " + (a.status === 'cancelled' ? 'status-cancelled' : 'status-planned')}>
                {a.status === 'cancelled' ? 'Annulé' : 'Planifié'}
              </span>
            </div>
            {/* VULN V5 : la note est injectée telle quelle dans le HTML, sans échappement */}
            {a.notes && <div className="note">{a.notes}</div>}
          </li>
        ))}
      </ul>

      <form onSubmit={submitNote}>
        <label htmlFor="note">Ajouter une note au rendez-vous sélectionné</label>
        <input id="note" placeholder="Sélectionnez un rendez-vous ci-dessus, puis écrivez votre note"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="submit">Ajouter la note</button>
      </form>
    </div>
  );
}
