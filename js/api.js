// ═══════════════════════════════════════════════════════════════
// API — thin fetch wrappers (session cookie is sent automatically)
// ═══════════════════════════════════════════════════════════════

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && path !== '/api/auth/me' && path !== '/api/auth/login') {
    // Session expired/invalid → bounce to auth.
    if (typeof onSessionExpired === 'function') onSessionExpired();
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const api = {
  // auth
  register: (email, name, password) => apiFetch('POST', '/api/auth/register', { email, name, password }),
  login:    (email, password)       => apiFetch('POST', '/api/auth/login', { email, password }),
  logout:   ()                      => apiFetch('POST', '/api/auth/logout'),
  me:       ()                      => apiFetch('GET',  '/api/auth/me'),

  // projects
  listProjects:  ()              => apiFetch('GET',    '/api/projects'),
  createProject: (name)          => apiFetch('POST',   '/api/projects', { name }),
  getProject:    (id)            => apiFetch('GET',    `/api/projects/${id}`),
  patchProject:  (id, patch)     => apiFetch('PATCH',  `/api/projects/${id}`, patch),
  deleteProject: (id)            => apiFetch('DELETE', `/api/projects/${id}`),
  saveData:      (id, data)      => apiFetch('PUT',    `/api/projects/${id}/data`, data),
  addMember:     (id, email)     => apiFetch('POST',   `/api/projects/${id}/members`, { email }),
  removeMember:  (id, userId)    => apiFetch('DELETE', `/api/projects/${id}/members/${userId}`),
};

//to redeploy