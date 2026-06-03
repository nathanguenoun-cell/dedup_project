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

const EMB_THRESHOLD = 0.55;   // cosine ≥ this → candidate pair (recall-oriented; the LLM filters)
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

if (typeof module !== 'undefined') {
  module.exports = { embedAll, cosineDense, embeddingCandidatePairs, unionPairs, EMB_THRESHOLD };
}
