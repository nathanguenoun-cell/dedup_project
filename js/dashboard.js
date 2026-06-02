// ═══════════════════════════════════════════════════════════════
// DASHBOARD VIEW — projects you created + projects you were invited to
// ═══════════════════════════════════════════════════════════════

function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const STATUS_LABEL = { draft: 'Draft', review: 'In review', completed: 'Completed' };

async function renderDashboard() {
  const v = document.getElementById('viewDashboard');
  v.innerHTML = `
    <div class="header">
      <div class="header-top">
        <div class="logo">Deduplication Platform</div>
        <div class="logo-badge">PROJECTS</div>
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
        <span class="${statusClass}">${STATUS_LABEL[p.status] || p.status}</span>
      </div>
      <div class="project-card-meta">
        <span>${p.issue_count} issues</span>
        <span>·</span>
        <span>${p.member_count} member${p.member_count > 1 ? 's' : ''}</span>
        <span>·</span>
        <span>${p.role === 'owner' ? 'Owner' : 'Member'}</span>
      </div>
    </div>`;
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
