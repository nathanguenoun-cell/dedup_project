// ═══════════════════════════════════════════════════════════════
// FILE LOADER — Excel/CSV import + column mapping
// ═══════════════════════════════════════════════════════════════

const COL_ALIASES = {
  block:      ['building block', 'block', 'bb', 'building_block', 'theme', 'category', 'pillar', 'thème'],
  takeaway:   ['key takeaway', 'takeaway', 'issue', 'finding', 'observation', 'insight', 'problem', 'key finding', 'observation principale'],
  initiative: ['initiative', 'initiatives recommended', 'initiative recommended', 'recommendation', 'initiatives', 'action', 'how can', 'solution', 'how can the issue be addressed'],
  type:       ['type'],
  importance: ['importance', 'priority', 'criticality', 'priorité'],
  quickWin:   ['quick win', 'quick_win', 'quickwin', 'gain rapide'],
};

function guessColumn(cols, field) {
  const aliases = COL_ALIASES[field] || [];
  const lower = cols.map(c => c.toLowerCase().trim());
  for (const alias of aliases) {
    const idx = lower.findIndex(c => c === alias);
    if (idx >= 0) return cols[idx];
  }
  for (const alias of aliases) {
    const idx = lower.findIndex(c => c.includes(alias));
    if (idx >= 0) return cols[idx];
  }
  return '(ignore)';
}

let _pendingRows = null;
let _pendingCols = null;

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
}

function handleFileInput(e) {
  const file = e.target.files[0];
  if (file) loadFile(file);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      let rows;
      if (file.name.endsWith('.csv')) {
        const wb = XLSX.read(e.target.result, { type: 'string' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      } else {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      }
      if (!rows.length) { setFileStatus('Empty file or unrecognized format.', 'error'); return; }
      _pendingRows = rows;
      _pendingCols = Object.keys(rows[0]);
      window._loadedFileName = file.name;
      setFileStatus(`✓ ${file.name} — ${rows.length} rows`, 'ok');
      showColumnMapper(_pendingCols);
    } catch (err) {
      setFileStatus('Error: ' + err.message, 'error');
    }
  };
  if (file.name.endsWith('.csv')) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}

function setFileStatus(msg, type) {
  const el = document.getElementById('fileStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : 'var(--green)';
}

function showColumnMapper(cols) {
  const section = document.getElementById('columnMapSection');
  if (!section) return;
  section.style.display = 'block';

  const fields = [
    { key: 'block',      label: 'Building Block',         required: true  },
    { key: 'takeaway',   label: 'Key Takeaway',            required: true  },
    { key: 'initiative', label: 'Initiative / Recommendation', required: false },
    { key: 'type',       label: 'Type',                    required: false },
    { key: 'importance', label: 'Importance',              required: false },
    { key: 'quickWin',   label: 'Quick Win',               required: false },
  ];

  document.getElementById('columnMapFields').innerHTML = fields.map(f => {
    const guess = guessColumn(cols, f.key);
    const options = ['(ignore)', ...cols]
      .map(c => `<option value="${escHtml(c)}" ${c === guess ? 'selected' : ''}>${escHtml(c)}</option>`)
      .join('');
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);">
        <div style="flex:0 0 40%;max-width:200px;font-size:12px;color:${f.required ? 'var(--text)' : 'var(--muted)'};">
          ${f.label}${f.required ? ' <span style="color:var(--red)">*</span>' : ''}
        </div>
        <select id="map_${f.key}" class="filter-select" style="flex:1 1 0;min-width:0;">${options}</select>
      </div>`;
  }).join('');
}

function applyColumnMap() {
  const get = key => {
    const el = document.getElementById('map_' + key);
    return el ? el.value : '(ignore)';
  };

  const blockCol     = get('block');
  const takeawayCol  = get('takeaway');
  if (blockCol === '(ignore)' || takeawayCol === '(ignore)') {
    alert('The "Building Block" and "Key Takeaway" columns are required.');
    return;
  }

  const initCol       = get('initiative');
  const typeCol       = get('type');
  const importanceCol = get('importance');
  const quickWinCol   = get('quickWin');

  const parsed = _pendingRows
    .map((r, i) => ({
      id:         i + 1,
      block:      String(r[blockCol]     || '').trim(),
      type:       String(r[typeCol]      || 'Issue').trim() || 'Issue',
      takeaway:   String(r[takeawayCol]  || '').trim(),
      initiative: initCol       !== '(ignore)' ? String(r[initCol]       || '').trim() : '',
      importance: importanceCol !== '(ignore)' ? String(r[importanceCol] || '').trim() : '',
      quickWin:   quickWinCol   !== '(ignore)' ? String(r[quickWinCol]   || '').trim() : '',
    }))
    .filter(r => r.block && r.takeaway);

  if (!parsed.length) {
    alert('No valid rows after filtering. Please check your column mapping.');
    return;
  }

  // Hand off to app
  onDataLoaded(parsed, window._loadedFileName || 'file.xlsx');
}

// Minimal escape used only in this file
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
