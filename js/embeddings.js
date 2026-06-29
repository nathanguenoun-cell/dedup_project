// ═══════════════════════════════════════════════════════════════
// EMBEDDINGS — semantic candidate generation
//
// Lexical similarity (Stage 1) misses duplicates phrased with different words.
// Dense embeddings capture MEANING, so "No PIP process" and "Underperformance
// management is unclear" land close together even with no shared tokens.
//
// embedAll() fetches one vector per issue from the server proxy (/api/embeddings,
// backed by Voyage or OpenAI). If embeddings are unavailable (no key / error),
// it returns null and the caller falls back to lexical-only candidates.
// ═══════════════════════════════════════════════════════════════

const EMB_THRESHOLD = 0.45;   // cosine ≥ this → candidate pair; lowered from 0.55 to catch paraphrased duplicates (LLM filters FPs)
const EMB_BATCH = 96;         // texts per request (kept under provider input limits)

function _issueText(i) {
  return ((i.takeaway || '') + ' ' + (i.initiative || '')).trim();
}

// Returns Map<issueId, number[]> or null if embeddings are unavailable.
async function embedAll(issues) {
  if (!issues.length) return new Map();
  const texts = issues.map(_issueText);
  const vectors = [];

  for (let start = 0; start < texts.length; start += EMB_BATCH) {
    const chunk = texts.slice(start, start + EMB_BATCH);
    let res;
    try {
      res = await fetch('/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ texts: chunk }),
      });
    } catch {
      return null; // network error → lexical fallback
    }
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch { return null; }
    if (!data || data.available === false || !Array.isArray(data.embeddings)) {
      return null; // provider not configured / errored → lexical fallback
    }
    vectors.push(...data.embeddings);
  }

  if (vectors.length !== issues.length) return null; // safety: shape mismatch
  const byId = new Map();
  issues.forEach((iss, i) => byId.set(iss.id, vectors[i]));
  return byId;
}

// Cosine similarity for dense vectors (handles un-normalized inputs).
function cosineDense(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Candidate pairs within one block, by embedding similarity.
// Returns [{idxA, idxB, score}] (indices into `issues`).
function embeddingCandidatePairs(issues, vecById, threshold = EMB_THRESHOLD) {
  if (!vecById || issues.length < 2) return [];
  const vecs = issues.map(i => vecById.get(i.id));
  const pairs = [];
  for (let a = 0; a < issues.length; a++) {
    if (!vecs[a]) continue;
    for (let b = a + 1; b < issues.length; b++) {
      if (!vecs[b]) continue;
      const score = cosineDense(vecs[a], vecs[b]);
      if (score >= threshold) pairs.push({ idxA: a, idxB: b, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

// Merge embedding + lexical candidate pairs, keeping the max score per index pair.
function unionPairs(a, b) {
  const key = p => p.idxA < p.idxB ? `${p.idxA},${p.idxB}` : `${p.idxB},${p.idxA}`;
  const map = new Map();
  for (const p of [...(a || []), ...(b || [])]) {
    const k = key(p);
    const prev = map.get(k);
    if (!prev || p.score > prev.score) map.set(k, p);
  }
  return [...map.values()].sort((x, y) => y.score - x.score);
}

// Transitive closure: if A≈B and B≈C, add an implied A≈C hint pair so the LLM
// explicitly sees the full connected component rather than just the direct edges.
function transitivePairs(pairs) {
  if (pairs.length < 2) return pairs;

  // Union-find over indices
  const parent = new Map();
  const find = id => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  };
  pairs.forEach(p => {
    const ra = find(p.idxA), rb = find(p.idxB);
    if (ra !== rb) parent.set(ra, rb);
  });

  // Group members by component root
  const components = new Map();
  [...new Set(pairs.flatMap(p => [p.idxA, p.idxB]))].forEach(i => {
    const r = find(i);
    (components.get(r) || components.set(r, []).get(r)).push(i);
  });

  // Add missing cross-edges within each component (marked as implied)
  const existing = new Set(pairs.map(p => `${p.idxA},${p.idxB}`));
  const extra = [];
  for (const members of components.values()) {
    if (members.length < 3) continue;
    members.sort((a, b) => a - b);
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const key = `${members[a]},${members[b]}`;
        if (!existing.has(key)) extra.push({ idxA: members[a], idxB: members[b], score: 0.35 });
      }
    }
  }
  return extra.length ? [...pairs, ...extra].sort((x, y) => y.score - x.score) : pairs;
}

if (typeof module !== 'undefined') {
  module.exports = { embedAll, cosineDense, embeddingCandidatePairs, unionPairs, transitivePairs, EMB_THRESHOLD };
}
