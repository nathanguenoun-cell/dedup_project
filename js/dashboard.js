// ═══════════════════════════════════════════════════════════════
// DASHBOARD VIEW — projects you created + projects you were invited to
// ═══════════════════════════════════════════════════════════════

function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const STATUS_LABEL = { draft: 'Draft', review: 'In review', completed: 'Completed' };

// Projects currently shown on the dashboard, keyed by id — populated on each
// render and read by the card action handlers (rename / delete).
let DASH_PROJECTS = {};

// Explicit English month names — avoid toLocaleDateString(), whose formatting
// (and month language) follows the browser's locale.
const DASH_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return `${DASH_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

async function renderDashboard() {
  // Close any open card kebab menu on an outside click (installed once).
  if (!window._cardMenuListener) {
    document.addEventListener('click', closeAllCardMenus);
    window._cardMenuListener = true;
  }
  const v = document.getElementById('viewDashboard');
  v.innerHTML = `
    <div class="header">
      <div class="header-top">
        <div class="logo">
          <div class="logo-hex-mark"></div>
          <div class="logo-wordmark">
            <span class="logo-brand">Atscale</span>
            <span class="logo-product">Deduplication</span>
          </div>
        </div>
        <div class="topbar-user">
          <span class="topbar-name">${esc(CURRENT_USER ? CURRENT_USER.name : '')}</span>
          <button class="nav-btn" onclick="doLogout()">Sign out</button>
        </div>
      </div>
    </div>
    <div class="dashboard">
      <div class="dashboard-head">
        <div class="dashboard-title">Your projects</div>
        <button class="btn-primary" onclick="promptNewProject()">+ New project</button>
      </div>
      <div id="dashCreated"></div>
      <div id="dashInvited"></div>
    </div>`;

  try {
    const { created, invited } = await api.listProjects();
    // Keep a by-id lookup so the card action handlers don't have to smuggle the
    // (possibly quote-containing) project name through inline onclick attributes.
    DASH_PROJECTS = {};
    [...created, ...invited].forEach(p => { DASH_PROJECTS[p.id] = p; });
    document.getElementById('dashCreated').innerHTML = section('My projects', created, true);
    document.getElementById('dashInvited').innerHTML = section('Invited projects', invited, false);
  } catch (err) {
    document.getElementById('dashCreated').innerHTML =
      `<div class="empty-state">Could not load projects: ${esc(err.message)}</div>`;
  }
}

function section(title, projects, isOwnerSection) {
  const cards = projects.length
    ? projects.map(projectCard).join('')
    : `<div class="empty-state">${isOwnerSection
        ? 'No projects yet. Create one to get started.'
        : 'No projects shared with you yet.'}</div>`;
  return `
    <div class="dash-section">
      <div class="dash-section-title">${esc(title)} <span class="dash-count">${projects.length}</span></div>
      <div class="project-grid">${cards}</div>
    </div>`;
}

function projectCard(p) {
  const statusClass = `pstatus pstatus-${p.status}`;
  return `
    <div class="project-card" onclick="navigate('#/project/${p.id}')">
      <div class="project-card-top">
        <div class="project-card-name">${esc(p.name)}</div>
        <div class="project-card-top-right">
          <span class="${statusClass}">${STATUS_LABEL[p.status] || p.status}</span>
          <div class="pcard-menu">
            <button class="pcard-kebab" onclick="toggleCardMenu(event, ${p.id})" aria-label="Project options">⋯</button>
            <div class="pcard-dropdown" id="cardMenu-${p.id}">
              <button class="pcard-menu-item" onclick="renameProjectCard(event, ${p.id})">Rename</button>
              ${p.role === 'owner'
                ? `<button class="pcard-menu-item pcard-menu-item-danger" onclick="deleteProjectCard(event, ${p.id})">Delete</button>`
                : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="project-card-meta">
        <span>${p.issue_count} issues</span>
        <span>·</span>
        <span>${p.member_count} member${p.member_count > 1 ? 's' : ''}</span>
        <span>·</span>
        <span>${p.role === 'owner' ? 'Owner' : 'Member'}</span>
      </div>
      <div class="project-card-dates">
        <span>Created ${fmtDate(p.created_at)}</span>
        <span>·</span>
        <span>Updated ${fmtDate(p.updated_at)}${p.last_modified_by_name ? ' by ' + esc(p.last_modified_by_name) : ''}</span>
      </div>
    </div>`;
}

// Kebab (⋯) menu on each card. Only one open at a time; a document-level click
// (installed once in renderDashboard) closes it. stopPropagation keeps the
// card's navigate() from firing when interacting with the menu.
function toggleCardMenu(event, id) {
  event.stopPropagation();
  const menu = document.getElementById('cardMenu-' + id);
  if (!menu) return;
  const wasOpen = menu.classList.contains('open');
  closeAllCardMenus();
  if (!wasOpen) {
    menu.classList.add('open');
    const card = menu.closest('.project-card');
    if (card) card.classList.add('menu-open');   // lift above sibling cards
  }
}

function closeAllCardMenus() {
  document.querySelectorAll('.pcard-dropdown.open').forEach(m => {
    m.classList.remove('open');
    const card = m.closest('.project-card');
    if (card) card.classList.remove('menu-open');
  });
}

// Rename a project in place. Any member may rename (server-enforced); the button
// is shown on every card. stopPropagation keeps the card's navigate() from firing.
async function renameProjectCard(event, id) {
  event.stopPropagation();
  const p = DASH_PROJECTS[id];
  const name = prompt('New project name:', p ? p.name : '');
  if (name == null) return;                         // cancelled
  const trimmed = name.trim();
  if (!trimmed || (p && trimmed === p.name)) return;
  try {
    await api.patchProject(id, { name: trimmed });
    renderDashboard();
  } catch (err) {
    alert('Could not rename project: ' + err.message);
  }
}

// Delete a project (owner only — the button is only rendered for owners, and the
// server rejects non-owners regardless).
async function deleteProjectCard(event, id) {
  event.stopPropagation();
  const p = DASH_PROJECTS[id];
  const label = p ? `"${p.name}"` : 'this project';
  if (!confirm(`Delete ${label}?\n\nThis permanently removes the project and all its data for everyone. This cannot be undone.`)) return;
  try {
    await api.deleteProject(id);
    renderDashboard();
  } catch (err) {
    alert('Could not delete project: ' + err.message);
  }
}

async function promptNewProject() {
  const name = prompt('Project name:');
  if (!name || !name.trim()) return;
  try {
    const { id } = await api.createProject(name.trim());
    navigate(`#/project/${id}`);
  } catch (err) {
    alert('Could not create project: ' + err.message);
  }
}
