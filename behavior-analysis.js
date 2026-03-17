'use strict';

/**
 * LevelUp — Behavior Analysis Module
 * Phase 6: Pattern extraction from execution logs for agent strategy context.
 *
 * Reads lu_tool_log, lu_agent_experience via WP REST.
 * Called during meeting synthesis and planning to give agents real performance data.
 *
 * NOTE: This module reads data — it does not write. All writes happen in WordPress.
 */

// ── Fetch tool performance stats from WP ──────────────────────────────────
async function fetchToolStats(wp_url, wp_secret) {
  if (!wp_url) return null;
  try {
    const res = await fetch(`${wp_url}/wp-json/lu/v1/tool-registry/stats`, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

// ── Fetch agent experience table ──────────────────────────────────────────
async function fetchAgentExperience(wp_url, wp_secret, agentId) {
  if (!wp_url) return null;
  try {
    const url = agentId
      ? `${wp_url}/wp-json/lu/v1/agents/${agentId}/experience`
      : `${wp_url}/wp-json/lu/v1/agents/experience/all`;
    const res = await fetch(url, {
      headers: { 'X-LU-Secret': wp_secret || '', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

/**
 * Compute skill scores from agent experience row.
 * Returns: { tool_id: score (0-1), ... }
 * Score = (tool_uses / (total_tasks + 1)) * success_rate
 */
function computeSkillScores(expRow) {
  if (!expRow) return {};
  const total     = (expRow.tasks_completed || 0) + (expRow.tasks_failed || 0);
  const successRate = total > 0 ? expRow.tasks_completed / total : 0.5;
  const toolsUsed   = typeof expRow.tools_used === 'string'
    ? JSON.parse(expRow.tools_used || '{}')
    : (expRow.tools_used || {});

  const scores = {};
  const maxUses = Math.max(...Object.values(toolsUsed), 1);
  for (const [toolId, uses] of Object.entries(toolsUsed)) {
    scores[toolId] = Math.round((uses / maxUses) * successRate * 10) / 10;
  }
  return scores;
}

/**
 * Format behavior insights for injection into meeting prompts.
 * Called from buildBriefingPrompt when context is enriched.
 */
function formatBehaviorInsights(experience) {
  if (!experience || !experience.length) return '';
  const lines = ['PLATFORM PERFORMANCE CONTEXT (real data):'];
  for (const row of experience.slice(0, 6)) {
    const total   = (row.tasks_completed || 0) + (row.tasks_failed || 0);
    if (!total) continue;
    const rate    = Math.round((row.tasks_completed / total) * 100);
    const topTool = (() => {
      const used = typeof row.tools_used === 'string'
        ? JSON.parse(row.tools_used || '{}')
        : (row.tools_used || {});
      const sorted = Object.entries(used).sort(([,a],[,b]) => b - a);
      return sorted[0]?.[0] || 'none';
    })();
    lines.push(`  • ${row.agent_id}: ${total} tasks | ${rate}% success | most used: ${topTool}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Route task to best agent for a given tool based on experience.
 * Returns agent_id with highest success rate for this tool.
 * Falls back to `defaultAgent` if no experience data.
 */
function selectBestAgentForTool(toolId, experienceMap, defaultAgent, allowedAgents) {
  if (!experienceMap || !allowedAgents?.length) return defaultAgent;

  let best = defaultAgent;
  let bestScore = -1;

  for (const agentId of allowedAgents) {
    const exp = experienceMap[agentId];
    if (!exp) continue;
    const scores = computeSkillScores(exp);
    const score  = scores[toolId] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best      = agentId;
    }
  }
  return best;
}

module.exports = {
  fetchToolStats,
  fetchAgentExperience,
  computeSkillScores,
  formatBehaviorInsights,
  selectBestAgentForTool,
};
