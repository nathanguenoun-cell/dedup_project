// ═══════════════════════════════════════════════════════════════
// STAGE 2 — LLM semantic grouping (ONE call per Building Block)
//
// Token-optimized design:
//   • Only issues that appear in ≥1 candidate pair are sent (others are
//     unique by definition — no need to spend tokens on them).
//   • Each issue's text is sent ONCE in a numbered list (not repeated per
//     pair as before → ~76% fewer input tokens on the real dataset).
//   • Candidate pairs are passed as compact index tuples to focus the model.
//   • The model returns GROUPS of indices directly → native support for
//     duplicate groups of any size (>2), and a tiny, truncation-proof output.
// ═══════════════════════════════════════════════════════════════

// POST to the LLM proxy with retry + backoff. The proxy can return a transient
// 502/503/504 (Railway edge timeout under concurrent load) or 429 (rate limit);
// those are retried. Other statuses (401, 400, …) fail immediately.
const _sleep = ms => new Promise(r => setTimeout(r, ms));
const _backoff = attempt => 800 * Math.pow(2, attempt - 1) + Math.random() * 400; // ~0.8s, 1.6s, 3.2s (+jitter)
const _RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function callMessages(body, attempts = 3) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    let res;
    try {
      res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch (e) {                       // network / connection drop
      lastErr = new Error('Network error: ' + e.message);
      if (a < attempts) { await _sleep(_backoff(a)); continue; }
      throw lastErr;
    }
    if (res.ok) return res;
    if (_RETRYABLE.has(res.status) && a < attempts) {
      lastErr = new Error(`API ${res.status} (retrying)`);
      await _sleep(_backoff(a));
      continue;
    }
    const err = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${(err || '').slice(0, 200)}`);
  }
  throw lastErr || new Error('request failed');
}

// Resolve which issues are involved in candidate pairs, returns:
//   { involved: [issueObj...], localPairs: [[localA, localB]...], idxToLocal }
function buildBlockPayload(issues, candidatePairs) {
  const involvedIdx = [...new Set(candidatePairs.flatMap(p => [p.idxA, p.idxB]))].sort((a, b) => a - b);
  const globalToLocal = new Map(involvedIdx.map((g, local) => [g, local]));
  const involved = involvedIdx.map(g => issues[g]);
  const localPairs = candidatePairs.map(p => [globalToLocal.get(p.idxA), globalToLocal.get(p.idxB)]);
  return { involved, localPairs };
}

async function analyzeBlock(block, issues, candidatePairs) {
  if (!candidatePairs.length) return [];

  const { involved, localPairs } = buildBlockPayload(issues, candidatePairs);

  const issueList = involved.map((iss, i) => {
    const init = iss.initiative ? ` || ${iss.initiative}` : '';
    return `[${i}] ${iss.takeaway}${init}`;
  }).join('\n');

  // Compact hint pairs: "(0,3)(0,7)(1,5)..."
  const hints = localPairs.map(([a, b]) => `(${a},${b})`).join('');

  const prompt = `You are an expert consultant deduplicating audit findings from a sales transformation project.

Building block: "${block}"

Below are ${involved.length} issues (index: "Key Takeaway || Initiative"). Many describe the SAME underlying problem in different words.

${issueList}

A fast pre-filter flagged these index pairs as textually similar (hints only — verify each):
${hints}

TASK: Group issues that describe the SAME underlying problem into clusters.
- A group can have 2, 3, or many members.
- Each index belongs to AT MOST ONE group.
- Merge aggressively when the root problem is identical even if wording differs
  ("No PIP process" = "Underperformance management unclear").
- Do NOT merge issues that would require genuinely different solutions.
- Ignore singletons (issues with no duplicate) — do not output them.

Respond with ONLY valid JSON (no markdown, no prose):
{"groups":[{"members":[0,3,7],"confidence":0.92,"reason":"All describe X"},{"members":[1,5],"confidence":0.6,"reason":"Both about Y"}]}

Rules:
- members: indices from the list above (0-based), 2+ per group
- confidence: 0.0–1.0 (use <0.7 when genuinely unsure → flagged for manual review)
- reason: one short sentence
- Return {"groups":[]} only if truly no duplicates exist`;

  const response = await callMessages({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const data = await response.json();
  const raw  = data.content?.find(b => b.type === 'text')?.text || '{"groups":[]}';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    console.warn(`[${block}] JSON parse failed:`, raw.slice(0, 200));
    return [];
  }

  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  // Map local indices back to real issue objects; drop invalid/singleton groups.
  return groups
    .map(g => {
      const members = (g.members || [])
        .map(i => involved[i])
        .filter(Boolean);
      // de-dup members within a group
      const uniq = [...new Map(members.map(m => [m.id, m])).values()];
      return {
        block,
        members: uniq,
        confidence: typeof g.confidence === 'number' ? g.confidence : 0.8,
        reason: g.reason || '',
      };
    })
    .filter(g => g.members.length >= 2);
}

if (typeof module !== 'undefined') module.exports = { analyzeBlock, buildBlockPayload };
