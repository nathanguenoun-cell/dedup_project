// ═══════════════════════════════════════════════════════════════
// STAGE 1 — Fast local pre-filter (Jaccard + bigram + TF-IDF cosine)
//
// Goal: cheaply surface which issues *might* be duplicates, so the LLM
// only reasons over a focused candidate set instead of every N² pair.
// High recall is intentional — the LLM makes the final call.
// ═══════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','must','shall',
  'can','need','to','of','in','on','at','by','for','with','about','against',
  'between','through','during','before','after','above','below','from','up','down',
  'out','off','over','under','again','further','then','once','and','but','or','nor',
  'not','so','yet','both','either','neither','whether','if','when','where','why',
  'how','all','each','every','few','more','most','other','some','such','no','only',
  'same','than','too','very','just','because','as','until','while','although',
  'though','since','unless','however','therefore','thus','hence','this','that',
  'these','those','which','who','whom','whose','their','there','they','them',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function jaccardSim(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function bigramJaccardSim(tokensA, tokensB) {
  const bigrams = toks => {
    const bg = new Set();
    for (let i = 0; i < toks.length - 1; i++) bg.add(toks[i] + '|' + toks[i + 1]);
    return bg;
  };
  const setA = bigrams(tokensA);
  const setB = bigrams(tokensB);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const bg of setA) if (setB.has(bg)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function buildTFIDF(docs) {
  const N = docs.length;
  const df = new Map();
  const tfs = docs.map(tokens => {
    const freq = new Map();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    return freq;
  });
  for (const freq of tfs)
    for (const t of freq.keys()) df.set(t, (df.get(t) || 0) + 1);

  return tfs.map(freq => {
    const vec = new Map();
    let norm = 0;
    for (const [t, f] of freq) {
      const idf = Math.log((N + 1) / (df.get(t) + 1));
      const v = (f / freq.size) * idf;
      vec.set(t, v);
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [t, v] of vec) vec.set(t, v / norm);
    return vec;
  });
}

function cosineSim(vecA, vecB) {
  // iterate the smaller map
  const [small, big] = vecA.size < vecB.size ? [vecA, vecB] : [vecB, vecA];
  let dot = 0;
  for (const [t, v] of small) if (big.has(t)) dot += v * big.get(t);
  return dot;
}

// Returns sorted candidate pairs [{idxA, idxB, score}] for one block's issues.
// threshold: low for recall.
// maxPairs: an anti-explosion safety bound only. Pairs are cheap index tuples,
//   so this is set high enough never to bite realistic blocks (max seen ≈ 340);
//   it exists purely to protect against pathological inputs (e.g. a block of
//   hundreds of near-identical rows producing tens of thousands of pairs).
function getCandidatePairs(issues, threshold = 0.12, maxPairs = 2000) {
  if (issues.length < 2) return [];
  const texts = issues.map(i => tokenize((i.takeaway || '') + ' ' + (i.initiative || '')));
  const vecs  = buildTFIDF(texts);
  const pairs = [];
  for (let a = 0; a < issues.length; a++) {
    for (let b = a + 1; b < issues.length; b++) {
      const score = Math.max(
        jaccardSim(texts[a], texts[b]),
        bigramJaccardSim(texts[a], texts[b]),
        cosineSim(vecs[a], vecs[b]),
      );
      if (score >= threshold) pairs.push({ idxA: a, idxB: b, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, maxPairs);
}

if (typeof module !== 'undefined') module.exports = { tokenize, jaccardSim, bigramJaccardSim, buildTFIDF, cosineSim, getCandidatePairs };
