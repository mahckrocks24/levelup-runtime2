/**
 * LevelUp — Task Planning Engine
 *
 * Converts a user goal + workspace context into a structured, ordered
 * multi-agent execution plan using DeepSeek.
 *
 * Called by:
 *   POST /internal/agent/plan   (from PHP lu_agent_plan_create)
 *   lu-task-worker.js           (for inline re-planning on complex tasks)
 *
 * Plan output:
 * {
 *   goal_id, goal, tasks: [
 *     { seq, title, agent, tools[], params{}, rationale, depends_on[] }
 *   ]
 * }
 *
 * Falls back to single-task scaffold if LLM is unavailable.
 */

'use strict';

const { selectBestAgentForTool, fetchAgentExperience } = require('./behavior-analysis');

const { buildContextPrompt } = require('./lu-context');

const DEEPSEEK_URL   = 'https://api.deepseek.com/v1/chat/completions';
const PLAN_TIMEOUT   = 45_000;
const MAX_PLAN_TASKS = 8;

// ── Agent roster — built dynamically from capability-map ─────────────
// capability-map.js is the single source of truth for agent permissions.
// This eliminates duplication and ensures planner always matches WP capabilities.
const { CAPABILITY_MAP } = require('./capability-map');

const AGENT_ROLES = {
  dmm:    'Digital Marketing Manager',
  james:  'SEO Strategist',
  priya:  'Content Manager',
  marcus: 'Social Media Manager',
  elena:  'CRM & Lead Manager',
  alex:   'Technical SEO',
  _any:   'Any Agent',
};

// Build AGENT_ROSTER from CAPABILITY_MAP — same shape as before
const AGENT_ROSTER = Object.keys(CAPABILITY_MAP).reduce((acc, agent_id) => {
  acc[agent_id] = {
    role:  AGENT_ROLES[agent_id] || agent_id,
    tools: CAPABILITY_MAP[agent_id] || [],
  };
  return acc;
}, {
  // _any tools from CAPABILITY_MAP don't have a separate entry — add static fallback
  _any: { role: 'Any Agent', tools: ['ai_status','create_event','list_events','update_event','check_availability','record_metric'] },
});

// ─────────────────────────────────────────────────────────────────────
// PLAN REQUEST SCHEMA (for LLM system prompt)
// ─────────────────────────────────────────────────────────────────────

function buildPlanSystemPrompt(context) {
  const contextBlock = buildContextPrompt(context);
  const agentBlock   = Object.entries(AGENT_ROSTER)
    .filter(([id]) => id !== '_any')
    .map(([id, a]) => `  ${id} (${a.role}): ${a.tools.join(', ')}`)
    .join('\n');

  return `You are the LevelUp task planner for a digital marketing platform.
Your job is to decompose a user's goal into an ordered list of agent tasks.

${contextBlock}

AVAILABLE AGENTS AND THEIR TOOLS:
${agentBlock}

RULES:
- Return ONLY valid JSON. No markdown, no explanation outside the JSON.
- Maximum ${MAX_PLAN_TASKS} tasks.
- Each task must use only tools that belong to the assigned agent (or _any tools).
- Tasks that can run independently should have empty depends_on[].
- Tasks that need results from a previous task should list its seq number in depends_on.
- Keep rationale short (one sentence max).
- Prefer sequential plans over parallel when output of one task feeds the next.

RESPONSE FORMAT (strict JSON):
{
  "tasks": [
    {
      "seq": 1,
      "title": "Short task title",
      "agent": "agent_id",
      "tools": ["tool_id"],
      "params": {},
      "rationale": "Why this step is needed.",
      "depends_on": []
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────
// DEEPSEEK CALL
// ─────────────────────────────────────────────────────────────────────

async function callDeepSeek(system_prompt, user_message) {
  const api_key = process.env.DEEPSEEK_API_KEY;
  if (!api_key) throw new Error('DEEPSEEK_API_KEY not set');

  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system',  content: system_prompt },
      { role: 'user',    content: user_message },
    ],
    temperature:  0.3,
    max_tokens:   1500,
    response_format: { type: 'json_object' },
  });

  const res = await fetch(DEEPSEEK_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${api_key}`,
    },
    body,
    signal: AbortSignal.timeout(PLAN_TIMEOUT),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from DeepSeek');

  return JSON.parse(content);
}

// ─────────────────────────────────────────────────────────────────────
// VALIDATE & NORMALISE PLAN
// ─────────────────────────────────────────────────────────────────────

function normalisePlan(raw_plan, goal_id, goal) {
  const tasks = (raw_plan?.tasks || []).slice(0, MAX_PLAN_TASKS);
  if (!tasks.length) return null;

  const now = Math.floor(Date.now() / 1000);
  return tasks.map((t, i) => {
    const agent  = String(t.agent || 'dmm').toLowerCase();
    const roster = AGENT_ROSTER[agent] || AGENT_ROSTER.dmm;
    const any    = AGENT_ROSTER._any.tools;

    // Sanitise tools — keep only tools this agent is allowed to use
    const all_allowed = [...roster.tools, ...any];
    let tools = (Array.isArray(t.tools) ? t.tools : [])
      .map(String)
      .filter(tool => all_allowed.includes(tool));

    // Phase 5: Avoid tools with < 40% success rate from experience data
    if (normalisePlan._toolStats) {
      const failingTools = tools.filter(toolId => {
        const stat = normalisePlan._toolStats[toolId];
        if (!stat) return false;
        const total = stat.call_count || 0;
        if (total < 3) return false; // not enough data to flag
        const successRate = total > 0 ? (total - (stat.error_count || 0)) / total : 1;
        if (successRate < 0.4) {
          console.log(`[planner] Avoiding tool ${toolId} — success rate ${Math.round(successRate*100)}% (< 40%)`);
          return true;
        }
        return false;
      });
      tools = tools.filter(t => !failingTools.includes(t));
    }

    // Part 5: Health filtering done async in createPlan() after normalisePlan returns
    const final_tools = tools.length ? tools : [roster.tools[0]];

    return {
      task_id:    `t_${goal_id}_${i + 1}`,
      seq:        i + 1,
      title:      String(t.title  || `Task ${i + 1}`).slice(0, 120),
      agent,
      tools:      final_tools,
      params:     (t.params && typeof t.params === 'object') ? t.params : {},
      rationale:  String(t.rationale || '').slice(0, 200),
      depends_on: Array.isArray(t.depends_on)
                    ? t.depends_on.map(Number).filter(n => n > 0 && n < i + 1)
                    : [],
      status:     'pending',
      output_id:  null,
      created_at: now,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// SCAFFOLD FALLBACK
// ─────────────────────────────────────────────────────────────────────

function scaffoldPlan(goal_id, goal) {
  return [{
    task_id:    `t_${goal_id}_1`,
    seq:        1,
    title:      goal,
    agent:      'dmm',
    tools:      ['autonomous_goal'],
    params:     { goal },
    rationale:  'Single-agent fallback — planner unavailable.',
    depends_on: [],
    status:     'pending',
    output_id:  null,
    created_at: Math.floor(Date.now() / 1000),
  }];
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

/**
 * Generate a task plan for a goal.
 *
 * @param {string} goal_id
 * @param {string} goal
 * @param {object} context   — workspace context from lu-context.js
 * @param {string} extra_ctx — optional freeform context string from user
 * @returns {Promise<{tasks, used_llm, error?}>}
 */
async function createPlan({ goal_id, goal, context = {}, extra_ctx = '' }) {
  // Phase 5: Fetch agent experience for intelligent routing
  const wp_url    = process.env.WP_URL || '';
  const wp_secret = process.env.LU_SECRET || '';
  let experienceMap = null;
  try {
    const expData = await fetchAgentExperience(wp_url, wp_secret, null);
    if (expData?.experience) {
      experienceMap = {};
      for (const row of expData.experience) {
        experienceMap[row.agent_id] = row;
      }
    }
  } catch (_) { /* non-critical — plan still runs without experience */ }

  const system_prompt = buildPlanSystemPrompt(context);
  const user_message  = extra_ctx
    ? `Goal: ${goal}\n\nAdditional context: ${extra_ctx}`
    : `Goal: ${goal}`;

  try {
    const raw = await callDeepSeek(system_prompt, user_message);
    // Phase 5: Attach tool stats to normalisePlan for reliability filtering
    try {
      const statsRes = await fetch(`${wp_url}/wp-json/lu/v1/tools/status`, {
        headers:{ 'X-LU-Secret': wp_secret, Accept:'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        normalisePlan._toolStats = statsData.stats || {};
        console.log('[planner] Tool stats loaded for reliability check');
      }
    } catch(_) { normalisePlan._toolStats = {}; }

    let tasks = normalisePlan(raw, goal_id, goal);
    if (!tasks || !tasks.length) {
      console.warn('[planner] LLM returned empty plan — using scaffold');
      return { tasks: scaffoldPlan(goal_id, goal), used_llm: false, error: 'empty_plan' };
    }

    // Phase 5: Re-route tasks to best-performing agent per tool when experience data exists
    if (experienceMap) {
      tasks = tasks.map(task => {
        const primaryTool = task.tools?.[0];
        if (!primaryTool) return task;
        const { getToolsForAgent } = require('./tool-registry');
        const allowedAgents = Object.keys(AGENT_ROSTER).filter(a =>
          a !== '_any' && getToolsForAgent(a).some(t => t.id === primaryTool)
        );
        if (allowedAgents.length <= 1) return task; // no routing decision needed
        const bestAgent = selectBestAgentForTool(primaryTool, experienceMap, task.agent, allowedAgents);
        if (bestAgent !== task.agent) {
          console.log(`[planner] Routing ${primaryTool} to ${bestAgent} (experience-based, was ${task.agent})`);
          return { ...task, agent: bestAgent };
        }
        return task;
      });
    }

    console.log(`[planner] Generated ${tasks.length}-task plan for goal ${goal_id}${experienceMap ? ' (experience-routed)' : ''}`);
    return { tasks, used_llm: true };
  } catch (e) {
    console.error('[planner] Planning failed, using scaffold:', e.message);
    return { tasks: scaffoldPlan(goal_id, goal), used_llm: false, error: e.message };
  }
}

/**
 * Re-plan a single task given partial results from completed dependencies.
 * Used when a running task needs to adapt based on earlier outputs.
 */
async function refineSingleTask({ task_id, title, agent, tools, context, dependency_outputs = [] }) {
  if (!dependency_outputs.length) return null;

  const system_prompt = buildPlanSystemPrompt(context);
  const dep_summary = dependency_outputs
    .map(d => `[${d.agent_id}] ${d.output_summary || ''}`)
    .join('\n');

  const user_message = `Refine params for this single task based on prior results.

Task: ${title}
Agent: ${agent}
Tools: ${tools.join(', ')}

Prior agent outputs:
${dep_summary}

Return a JSON object with a single "params" key containing refined task parameters.
Example: {"params": {"keyword": "landing page optimization", "tone": "professional"}}`;

  try {
    const raw = await callDeepSeek(system_prompt, user_message);
    return raw?.params || null;
  } catch (e) {
    console.warn('[planner] Param refinement failed:', e.message);
    return null;
  }
}

module.exports = { createPlan, refineSingleTask, scaffoldPlan, AGENT_ROSTER };
