'use strict';

/**
 * LevelUp Tool Registry — Phase 1 (flat single-file version)
 *
 * Domain structure is maintained via the `domain` property on each tool.
 * When Phase 2 splits into 3 plugins, this file splits into separate domain
 * files — no logic changes needed, just reorganisation.
 *
 * Domains registered here: seo (15 tools)
 * Domains stubbed for Phase 3+: crm, marketing, social, calendar, builder, governance
 */

// ── Lazy ref to capability-map to avoid circular dep ──────────────────────
let _capMap = null;
function capMap() {
    if (!_capMap) _capMap = require('./capability-map');
    return _capMap;
}

// ══════════════════════════════════════════════════════════════════════════
// SEO DOMAIN — 15 verified tools (source-confirmed v5.9.1)
// All endpoints confirmed live: 401/403 on health check = exists, auth ok
// ══════════════════════════════════════════════════════════════════════════
const SEO_TOOLS = {

    // ── SERP & Analysis ────────────────────────────────────────────────────

    serp_analysis: {
        id:               'serp_analysis',
        domain:           'seo',
        name:             'SERP Analysis',
        description:      'Fetch live SERP competitor data for a keyword. Returns top-ranking pages, competitor content, and a serp_run_id for use in ai_report.',
        wp_path:          '/lugs/v1/serp-analysis',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'post_id', 'location', 'language'],
        query_params:     [],
        params: {
            keyword:  { type: 'string',  required: true,  description: 'Target keyword to analyse SERP for' },
            post_id:  { type: 'integer', required: false, description: 'Optional post ID to associate results with' },
            location: { type: 'string',  required: false, description: 'Location code for localised results' },
            language: { type: 'string',  required: false, description: 'Language code, default en' },
        },
        returns:          '{ success, results[], result_count, serp_run_id }',
        requires_approval: false,
        allowed_agents:   ['james'],
    },

    ai_report: {
        id:               'ai_report',
        domain:           'seo',
        name:             'AI Content Intelligence Report',
        description:      'Generate a full AI content intelligence report for a post. Analyses GSC data, competitor content, and returns strategic recommendations. Run serp_analysis first to get serp_run_id.',
        wp_path:          '/lugs/v1/ai-report',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'serp_run_id'],
        query_params:     [],
        params: {
            post_id:     { type: 'integer', required: true,  description: 'WordPress post ID to generate report for' },
            keyword:     { type: 'string',  required: true,  description: 'Focus keyword for the report' },
            serp_run_id: { type: 'integer', required: false, description: 'serp_run_id from a prior serp_analysis call' },
        },
        returns:          '{ success, report, cached, timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya'],
    },

    deep_audit: {
        id:               'deep_audit',
        domain:           'seo',
        name:             'Deep Content Audit',
        description:      'Run a deep SEO audit on a specific post. Pulls GSC data, audit breakdown, competitor SERP, and generates a comprehensive AI analysis report.',
        wp_path:          '/lugs/v1/deep-audit',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword'],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true,  description: 'WordPress post ID to audit' },
            keyword: { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
        },
        returns:          '{ success, report, competitors[], timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'alex'],
    },

    ai_status: {
        id:               'ai_status',
        domain:           'seo',
        name:             'AI Status Check',
        description:      'Check whether the AI engine (LevelUp Core + DeepSeek) is configured and ready. Use this before running AI-dependent tools.',
        wp_path:          '/lugs/v1/ai-status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ core_active, ai_ready }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    // ── Content Generation ─────────────────────────────────────────────────

    improve_draft: {
        id:               'improve_draft',
        domain:           'seo',
        name:             'Improve Draft',
        description:      'Generate an AI-improved version of an existing post draft. Requires a prior AI report to exist for this post. Returns improved content with SEO enhancements.',
        wp_path:          '/lugs/v1/ai-draft',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'ai_report_id'],
        query_params:     [],
        params: {
            post_id:      { type: 'integer', required: true,  description: 'WordPress post ID to improve' },
            keyword:      { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
            ai_report_id: { type: 'integer', required: false, description: 'Specific AI report ID. Uses latest if omitted.' },
        },
        returns:          '{ success, draft_id, draft_content, created_at, cached }',
        requires_approval: true,
        approval_preview: 'Generate an improved draft for post #{post_id} targeting "{keyword}". Creates a new draft version — does not modify the live post.',
        allowed_agents:   ['priya'],
    },

    write_article: {
        id:               'write_article',
        domain:           'seo',
        name:             'Write SEO Article',
        description:      'Generate a full SEO-optimised article and save it as a WordPress draft post. Auto-selects the best keyword from site audit data if none given. Returns the edit URL.',
        wp_path:          '/lugs/v1/generate-seo-article',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'context'],
        query_params:     [],
        params: {
            keyword: { type: 'string', required: false, description: 'Target keyword — auto-selected from site audit if omitted' },
            context: { type: 'string', required: false, description: 'Additional context or instructions for the article' },
        },
        returns:          '{ success, keyword, post_id, title, edit_url, preview_url, tokens_used, message }',
        requires_approval: true,
        approval_preview: 'Write and save a new SEO article{keyword ? \' targeting "\' + keyword + \'"\' : \' (keyword auto-selected)\'}. Creates a new WordPress draft post.',
        allowed_agents:   ['priya'],
    },

    // ── Internal Links ─────────────────────────────────────────────────────

    link_suggestions: {
        id:               'link_suggestions',
        domain:           'seo',
        name:             'Link Suggestions',
        description:      'Get internal link suggestions for a specific post. Returns up to 5 relevant target pages with relevance scores.',
        wp_path:          '/lugs/v1/link-suggestions/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get link suggestions for' },
        },
        returns:          '[{ id, target_post_id, target_title, target_url, relevance_score, status }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    insert_link: {
        id:               'insert_link',
        domain:           'seo',
        name:             'Insert Internal Link',
        description:      'Insert a suggested internal link into post content. Finds matching anchor text and wraps it with the target link. Modifies live post content.',
        wp_path:          '/lugs/v1/link-suggestions/:id/insert',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID from link_suggestions result' },
        },
        returns:          '{ success } or { success: false, message }',
        requires_approval: true,
        approval_preview: 'Insert internal link suggestion #{id} into live post content. This directly modifies the post.',
        allowed_agents:   ['alex'],
    },

    dismiss_link: {
        id:               'dismiss_link',
        domain:           'seo',
        name:             'Dismiss Link Suggestion',
        description:      'Mark an internal link suggestion as rejected so it no longer appears.',
        wp_path:          '/lugs/v1/link-suggestions/:id/dismiss',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID to dismiss' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Outbound Links ─────────────────────────────────────────────────────

    outbound_links: {
        id:               'outbound_links',
        domain:           'seo',
        name:             'Outbound Links',
        description:      'Get all outbound (external) links for a post. Returns each link with HTTP status, anchor text, and rel attributes.',
        wp_path:          '/lugs/v1/outbound-links/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get outbound links for' },
        },
        returns:          '[{ id, outbound_url, outbound_domain, anchor_text, rel_nofollow, http_status, recommended }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    check_outbound: {
        id:               'check_outbound',
        domain:           'seo',
        name:             'Check Outbound Link Health',
        description:      'Run a live health scan of all outbound links in a post. Checks each external URL for 404s, redirects, and errors.',
        wp_path:          '/lugs/v1/outbound-links/:id/check',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Post ID to scan outbound links for' },
        },
        returns:          '{ post_id, total, broken, redirects, links[{ url, anchor, status, ok, fix }] }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Autonomous Agent ───────────────────────────────────────────────────

    autonomous_goal: {
        id:               'autonomous_goal',
        domain:           'seo',
        name:             'Submit Autonomous Goal',
        description:      'Submit a natural language goal to the SEO agent system. The agent will autonomously break it into tasks and execute them in the background.',
        wp_path:          '/lugs/v1/agent/goal',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal'],
        query_params:     [],
        params: {
            goal: { type: 'string', required: true, description: 'Natural language goal for the autonomous agent' },
        },
        returns:          '{ success, goal_id }',
        requires_approval: true,
        approval_preview: 'Submit autonomous goal to the SEO agent: "{goal}". This will run background tasks on the site.',
        allowed_agents:   ['dmm'],
    },

    agent_status: {
        id:               'agent_status',
        domain:           'seo',
        name:             'Agent Goal Status',
        description:      'Get the current progress of an autonomous agent goal and its sub-tasks.',
        wp_path:          '/lugs/v1/agent/status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['goal_id'],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID returned from autonomous_goal' },
        },
        returns:          '{ success, goal, tasks[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    list_goals: {
        id:               'list_goals',
        domain:           'seo',
        name:             'List Agent Goals',
        description:      'List all autonomous agent goals and their current statuses.',
        wp_path:          '/lugs/v1/agent/goals',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ success, goals[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    pause_goal: {
        id:               'pause_goal',
        domain:           'seo',
        name:             'Pause Agent Goal',
        description:      'Pause a running autonomous agent goal.',
        wp_path:          '/lugs/v1/agent/pause',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal_id'],
        query_params:     [],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID to pause' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// FUTURE DOMAINS — Phase 3+ stubs (no tools yet, structure ready)
// ══════════════════════════════════════════════════════════════════════════
const CRM_TOOLS        = {}; // Phase 3
const MARKETING_TOOLS  = {}; // Phase 3
const SOCIAL_TOOLS     = {}; // Phase 3
const CALENDAR_TOOLS   = {}; // Phase 3
const BUILDER_TOOLS    = {}; // Phase 4
const GOVERNANCE_TOOLS = {}; // Phase 4

// ── Merge all domains ──────────────────────────────────────────────────────
const ALL_TOOLS = Object.assign(
    {},
    SEO_TOOLS,
    CRM_TOOLS,
    MARKETING_TOOLS,
    SOCIAL_TOOLS,
    CALENDAR_TOOLS,
    BUILDER_TOOLS,
    GOVERNANCE_TOOLS
);

// ── Core API ───────────────────────────────────────────────────────────────

function getTool(toolId) {
    return ALL_TOOLS[toolId] || null;
}

function listAll() {
    return Object.values(ALL_TOOLS);
}

function listByDomain(domain) {
    return Object.values(ALL_TOOLS).filter(t => t.domain === domain);
}

function getToolsForAgent(agentId) {
    const permitted = capMap().getToolIds(agentId);
    return permitted.map(id => ALL_TOOLS[id]).filter(Boolean);
}

function agentCanUseTool(agentId, toolId) {
    const tool = getTool(toolId);
    if (!tool) return false;
    return tool.allowed_agents.includes(agentId);
}

function buildToolPromptBlock(agentId) {
    const tools = getToolsForAgent(agentId);
    if (!tools.length) return '';

    const defs = tools.map(t => {
        const paramLines = Object.entries(t.params).map(([k, v]) =>
            `      ${k} (${v.type}${v.required ? ', REQUIRED' : ', optional'}): ${v.description}`
        ).join('\n');
        const approvalNote = t.requires_approval
            ? '\n  ⚠️  REQUIRES HUMAN APPROVAL before execution.'
            : '\n  ✓  Executes immediately.';
        return [
            `TOOL: ${t.id}`,
            `Name: ${t.name}`,
            `Description: ${t.description}`,
            paramLines ? `Parameters:\n${paramLines}` : 'Parameters: none',
            `Returns: ${t.returns}`,
            approvalNote,
        ].join('\n');
    }).join('\n\n');

    return `
═══════════════════════════════════════════════
REAL TOOLS AVAILABLE TO YOU
═══════════════════════════════════════════════
You have access to the following tools that return REAL data from the client's live systems.
When a tool would meaningfully improve your response with real data, use it. Do NOT hallucinate numbers or results.

${defs}

═══════════════════════════════════════════════
HOW TO CALL A TOOL
═══════════════════════════════════════════════
Output ONLY this block on that turn (nothing else):

<tool_call>
{
  "tool": "tool_id_here",
  "params": { "param_name": "value" }
}
</tool_call>

Rules:
- Call ONE tool at a time
- Only call when real data adds genuine value to your response
- After the result is returned, use it in your final response
- For tools marked REQUIRES HUMAN APPROVAL: propose the action, then call the tool — human approves/rejects before it executes
- Never fabricate tool results. If a tool fails, acknowledge it and continue with best available knowledge
`;
}

function getStats() {
    const tools = Object.values(ALL_TOOLS);
    const byDomain = {};
    for (const t of tools) byDomain[t.domain] = (byDomain[t.domain] || 0) + 1;
    return { total: tools.length, byDomain, requiresApproval: tools.filter(t => t.requires_approval).length };
}

module.exports = {
    getTool,
    listAll,
    listByDomain,
    getToolsForAgent,
    agentCanUseTool,
    buildToolPromptBlock,
    getStats,
    TOOLS: ALL_TOOLS, // legacy compat
};
