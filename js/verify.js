// ═══════════════════════════════════════════════════════════════
// VERIFICATION PASS (precision)
//
// The clustering pass (Stage 2) can over-merge: a "group" may actually contain
// two distinct problems, or a member that doesn't really belong. For groups the
// model was unsure about (low confidence) or that are large, we ask the LLM to
// re-examine the members and return only the subset(s) that are TRULY the same
// underlying problem. A group can split into several, shrink, or dissolve.
//
// Relies on callMessages() (defined in stage2-llm.js) for retry/backoff.
// ═══════════════════════════════════════════════════════════════

const VERIFY_CONF_BELOW = 0.75;   // verify groups the model was unsure about…
const VERIFY_SIZE_ATLEAST = 5;    // …or groups large enough to risk mixing problems

function needsVerification(group) {
  return (group.similarity ?? group.confidence ?? 1) < VERIFY_CONF_BELOW
      || (group.duplicates.length + 1) >= VERIFY_SIZE_ATLEAST;
}

// Re-examine one finalized group {block, primary, duplicates, reasoning, similarity}.
// Returns an array of refined groups in the SAME finalized shape (0, 1 or more).
async function verifyGroup(group) {
  const members = [group.primary, ...group.duplicates];
  if (members.length < 2) return [group];

  const list = members.map(m => {
    const init = m.initiative ? ` || ${m.initiative}` : '';
    return `[${m.id}] ${m.takeaway}${init}`;
  }).join('\n');

  const prompt = `You are auditing a proposed cluster of "duplicate" audit findings to make sure it is correct.

Building block: "${group.block}"
Proposed cluster (id: "Key Takeaway || Initiative"):
${list}

These were grouped as the SAME underlying problem, but the grouping may be too loose.
Return ONLY the subset(s) that genuinely describe the SAME root problem AND would be
resolved by the SAME corrective action. Rules:
- Split into multiple subgroups if the cluster actually mixes 2+ distinct problems.
- Drop any id that does not truly belong with the others.
- A valid subgroup has 2+ ids. Ignore singletons (a lone id = not a duplicate).

Respond with ONLY valid JSON (no markdown):
{"subgroups":[[id,id,...],[id,id,...]],"reason":"one short sentence"}
If none of the members are true duplicates, return {"subgroups":[],"reason":"..."}`;

  let parsed;
  try {
    const res = await callMessages({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const data = await res.json();
    const raw = data.content?.find(b => b.type === 'text')?.text || '{"subgroups":[]}';
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    // On any failure, keep the original group rather than losing it.
    console.warn('verifyGroup failed, keeping original:', e.message);
    return [group];
  }

  // Missing `subgroups` key entirely → treat as malformed and KEEP the original
  // (only an explicit array, even empty, is honored as the model's verdict).
  if (!parsed || !Array.isArray(parsed.subgroups)) return [group];

  const byId = new Map(members.map(m => [m.id, m]));
  const subgroups = parsed.subgroups;
  const reason = parsed.reason || group.reasoning;

  const refined = [];
  for (const ids of subgroups) {
    const mem = (ids || []).map(id => byId.get(id)).filter(Boolean);
    const uniq = [...new Map(mem.map(m => [m.id, m])).values()];
    if (uniq.length < 2) continue;
    // richest member as primary (mirror finalizeGroups' ranking)
    const ranked = [...uniq].sort((a, b) => scoreRichness(b) - scoreRichness(a));
    refined.push({
      block: group.block,
      primary: ranked[0],
      duplicates: ranked.slice(1),
      reasoning: reason,
      similarity: Math.max(group.similarity ?? 0.8, 0.8), // verified → confident
      needsReview: false,
    });
  }
  return refined; // may be [] (cluster rejected), 1, or several
}

if (typeof module !== 'undefined') {
  module.exports = { verifyGroup, needsVerification, VERIFY_CONF_BELOW, VERIFY_SIZE_ATLEAST };
}
