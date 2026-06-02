// ═══════════════════════════════════════════════════════════════
// STAGE 3 — Finalize groups: dedupe, rank, pick canonical keeper
//
// Stage 2 already returns clusters (groups of issues). This stage:
//   • Enforces that each issue lives in at most ONE group (first wins).
//   • Picks the richest issue as the recommended "primary" (keeper).
//   • Flags low-confidence groups for manual review.
// (No union-find needed anymore — the LLM returns groups directly. We keep
//  a defensive dedupe in case the model places an issue in two groups.)
// ═══════════════════════════════════════════════════════════════

// Score a row by content richness; higher = better keeper candidate.
function scoreRichness(issue) {
  let score = 0;
  const init = issue.initiative || '';
  if (init.length > 80) score += 3;
  else if (init.length > 30) score += 1;
  if ((issue.importance || '').trim()) score += 1;
  if ((issue.quickWin || '').trim()) score += 1;
  const combined = (issue.takeaway || '') + ' ' + init;
  const separators = (combined.match(/[;]|,\s+[A-Z]/g) || []).length;
  if (separators >= 2) score += 1;
  // tie-breaker: longer takeaway carries marginally more detail
  score += Math.min((issue.takeaway || '').length / 400, 0.9);
  return score;
}

// rawGroups: [{block, members:[issueObj...], confidence, reason}]  (from analyzeBlock, all blocks concatenated)
// Returns: [{block, primary, duplicates, reasoning, similarity, needsReview}]
function finalizeGroups(rawGroups) {
  const claimed = new Set();   // issue ids already placed in a group
  const finals = [];

  // Process higher-confidence groups first so they get first claim on shared issues.
  const ordered = [...rawGroups].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  for (const g of ordered) {
    const members = g.members.filter(m => !claimed.has(m.id));
    if (members.length < 2) continue;
    members.forEach(m => claimed.add(m.id));

    const ranked = [...members].sort((a, b) => scoreRichness(b) - scoreRichness(a));
    finals.push({
      block: g.block || ranked[0].block,
      primary: ranked[0],
      duplicates: ranked.slice(1),
      reasoning: g.reason || 'Semantic duplicates detected.',
      similarity: Math.round((g.confidence ?? 0.8) * 100) / 100,
      needsReview: (g.confidence ?? 0.8) < 0.7,
    });
  }

  // Needs-review groups first, then by block for a tidy review queue.
  finals.sort((a, b) => {
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
    return (a.block || '').localeCompare(b.block || '');
  });

  return finals;
}

if (typeof module !== 'undefined') module.exports = { scoreRichness, finalizeGroups };
