const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function call(path, options = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

export const login = (email, password) =>
  call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const getPatient = (id) => call('/api/patients/' + id);
export const searchPatients = (name) => call('/api/patients?name=' + encodeURIComponent(name));
export const getMyRecord = () => call('/api/me/patient');
export const getAppointments = () => call('/api/appointments');
export const addNote = (apptId, notes) =>
  call('/api/appointments/' + apptId + '/notes', { method: 'POST', body: JSON.stringify({ notes }) });
export const createAppointment = (doctor_id, scheduled_at) =>
  call('/api/appointments', { method: 'POST', body: JSON.stringify({ doctor_id, scheduled_at }) });
