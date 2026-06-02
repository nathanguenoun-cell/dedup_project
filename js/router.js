// ═══════════════════════════════════════════════════════════════
// ROUTER — view switching + session bootstrap
//   Views: auth | dashboard | project. Hash routes:
//     #/login              → auth
//     #/projects           → dashboard
//     #/project/:id        → project workspace
// ═══════════════════════════════════════════════════════════════

let CURRENT_USER = null;

function showView(name) {
  document.getElementById('viewAuth').style.display      = name === 'auth'      ? '' : 'none';
  document.getElementById('viewDashboard').style.display = name === 'dashboard' ? '' : 'none';
  document.getElementById('viewProject').style.display   = name === 'project'   ? '' : 'none';
}

function navigate(hash) {
  if (location.hash === hash) handleRoute();
  else location.hash = hash;
}

function goDashboard() { navigate('#/projects'); }

function onSessionExpired() {
  CURRENT_USER = null;
  navigate('#/login');
}

async function handleRoute() {
  const hash = location.hash || '#/projects';

  // Always need to know if we have a session.
  if (!CURRENT_USER) {
    try {
      const { user } = await api.me();
      CURRENT_USER = user;
    } catch {
      CURRENT_USER = null;
    }
  }

  if (!CURRENT_USER) {
    showView('auth');
    renderAuth();
    return;
  }

  const projMatch = hash.match(/^#\/project\/(\d+)$/);
  if (projMatch) {
    showView('project');
    openProject(parseInt(projMatch[1], 10));
    return;
  }

  // default: dashboard
  showView('dashboard');
  renderDashboard();
}

// Called by auth.js after successful login/register.
function onAuthenticated(user) {
  CURRENT_USER = user;
  navigate('#/projects');
}

async function doLogout() {
  try { await api.logout(); } catch { /* ignore */ }
  CURRENT_USER = null;
  navigate('#/login');
}

window.addEventListener('hashchange', handleRoute);
window.addEventListener('DOMContentLoaded', handleRoute);
