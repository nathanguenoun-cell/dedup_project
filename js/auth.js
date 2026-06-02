// ═══════════════════════════════════════════════════════════════
// AUTH VIEW — login / register for operating partners
// ═══════════════════════════════════════════════════════════════

let _authMode = 'login'; // 'login' | 'register'

function renderAuth() {
  const v = document.getElementById('viewAuth');
  const isLogin = _authMode === 'login';
  v.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="logo">Deduplication Platform</div>
          <div class="logo-badge">OPERATING PARTNER</div>
        </div>
        <div class="auth-title">${isLogin ? 'Sign in' : 'Create your account'}</div>
        <div class="auth-sub">${isLogin
          ? 'Sign in to your operating partner account.'
          : 'Register as an operating partner to create and join projects.'}</div>

        <form class="auth-form" onsubmit="return submitAuth(event)">
          ${isLogin ? '' : `
            <label class="auth-label">Full name</label>
            <input class="filter-input auth-input" id="authName" type="text" placeholder="Jane Partner" autocomplete="name">
          `}
          <label class="auth-label">Email</label>
          <input class="filter-input auth-input" id="authEmail" type="email" placeholder="you@firm.com" autocomplete="email" required>

          <label class="auth-label">Password</label>
          <input class="filter-input auth-input" id="authPassword" type="password" placeholder="••••••••" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required>
          ${isLogin ? '' : '<div class="auth-hint">At least 8 characters.</div>'}

          <div class="auth-error" id="authError" style="display:none;"></div>

          <button class="btn-primary auth-submit" type="submit" id="authSubmit">
            ${isLogin ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div class="auth-switch">
          ${isLogin
            ? `No account yet? <a href="#" onclick="return toggleAuthMode()">Create one</a>`
            : `Already registered? <a href="#" onclick="return toggleAuthMode()">Sign in</a>`}
        </div>
      </div>
    </div>`;
}

function toggleAuthMode() {
  _authMode = _authMode === 'login' ? 'register' : 'login';
  renderAuth();
  return false;
}

function authError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.style.display = 'block';
}

async function submitAuth(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const btn = document.getElementById('authSubmit');
  btn.disabled = true;
  try {
    let res;
    if (_authMode === 'login') {
      res = await api.login(email, password);
    } else {
      const name = document.getElementById('authName').value.trim();
      res = await api.register(email, name, password);
    }
    onAuthenticated(res.user);
  } catch (err) {
    authError(err.message || 'Something went wrong.');
    btn.disabled = false;
  }
  return false;
}
