'use strict';

/**
 * LevelUp Tool Registry — Sprint F
 * Defines all real tools agents can execute.
 * Each tool maps to a WordPress REST endpoint under lugs/v1/ or lu/v1/.
 */

// ── Tool definitions ──────────────────────────────────────────────────────
const TOOLS = {

    seo_audit: {
        id:          'seo_audit',
        name:        'SEO Audit',
        description: 'Run a full SEO audit on a URL or the client site. Returns issues, scores, and recommendations across on-page, technical, and content dimensions.',
        endpoint:    '/wp-json/lugs/v1/audit',
        method:      'POST',
        params: {
            url:  { type: 'string', description: 'URL to audit. Defaults to client site if omitted.', required: false },
            type: { type: 'string', description: 'Audit type: full|onpage|technical|content', required: false },
        },
        returns:     'JSON: { score, issues[], recommendations[], summary }',
        agents:      ['james', 'alex'],
    },

    keyword_lookup: {
        id:          'keyword_lookup',
        name:        'Keyword Research',
        description: 'Look up keyword data: monthly search volume, keyword difficulty, CPC, search intent, and SERP feature opportunities for one or more keywords.',
        endpoint:    '/wp-json/lugs/v1/keywords',
        method:      'POST',
        params: {
            keywords: { type: 'array',  description: 'List of keywords to research (max 10)', required: true },
            country:  { type: 'string', description: 'Country code (e.g. "us", "gb"). Default: "us"', required: false },
        },
        returns:     'JSON: { keywords[{ keyword, volume, difficulty, cpc, intent, serp_features }] }',
        agents:      ['james'],
    },

    ctr_suggestions: {
        id:          'ctr_suggestions',
        name:        'CTR Optimisation',
        description: 'Analyse existing title tags and meta descriptions for click-through rate optimisation. Returns improved variants with predicted CTR lift.',
        endpoint:    '/wp-json/lugs/v1/ctr',
        method:      'POST',
        params: {
            url:              { type: 'string', description: 'Page URL to analyse', required: false },
            title:            { type: 'string', description: 'Current title tag', required: false },
            meta_description: { type: 'string', description: 'Current meta description', required: false },
            target_keyword:   { type: 'string', description: 'Primary keyword', required: false },
        },
        returns:     'JSON: { variants[{ title, meta_description, predicted_ctr_lift }], recommendation }',
        agents:      ['james', 'alex'],
    },

    internal_links: {
        id:          'internal_links',
        name:        'Internal Link Audit',
        description: 'Audit and suggest internal linking opportunities. Identifies orphan pages, weak pages needing link equity, and anchor text optimisation opportunities.',
        endpoint:    '/wp-json/lugs/v1/internal-linking',
        method:      'POST',
        params: {
            url:        { type: 'string', description: 'Root URL to crawl for internal links', required: false },
            focus_page: { type: 'string', description: 'Specific page URL to find link opportunities for', required: false },
        },
        returns:     'JSON: { orphan_pages[], link_opportunities[], anchor_suggestions[], summary }',
        agents:      ['alex'],
    },

    content_draft: {
        id:          'content_draft',
        name:        'Content Pipeline',
        description: 'Generate a detailed content brief or draft outline for a given keyword and content type. Includes structure, internal links, CTAs, and word count targets.',
        endpoint:    '/wp-json/lugs/v1/content-pipeline',
        method:      'POST',
        params: {
            keyword:      { type: 'string', description: 'Primary target keyword', required: true },
            content_type: { type: 'string', description: 'pillar|comparison|listicle|case_study|blog_post', required: false },
            word_count:   { type: 'number', description: 'Target word count', required: false },
            tone:         { type: 'string', description: 'authoritative|conversational|technical', required: false },
        },
        returns:     'JSON: { title, structure[], cta, internal_links[], meta_description, brief_summary }',
        agents:      ['priya'],
    },

    crm_write: {
        id:          'crm_write',
        name:        'CRM Record Write',
        description: 'Write a lead, contact update, or pipeline event to the CRM. Use to log qualified leads, update lead scores, or trigger nurture sequences.',
        endpoint:    '/wp-json/lu/v1/crm/write',
        method:      'POST',
        params: {
            type:   { type: 'string', description: 'lead|contact_update|pipeline_event', required: true },
            data:   { type: 'object', description: 'Record data (name, email, score, stage, etc.)', required: true },
            source: { type: 'string', description: 'Attribution source (e.g. "organic-seo", "social-linkedin")', required: false },
        },
        returns:     'JSON: { success, record_id, message }',
        agents:      ['elena'],
    },

};

// ── Agent tool permissions ─────────────────────────────────────────────────
const AGENT_TOOLS = {
    james:  ['seo_audit', 'keyword_lookup', 'ctr_suggestions'],
    priya:  ['content_draft'],
    marcus: [],
    elena:  ['crm_write'],
    alex:   ['seo_audit', 'ctr_suggestions', 'internal_links'],
    dmm:    [],
};

// ── Helpers ────────────────────────────────────────────────────────────────
function getToolsForAgent(agentId) {
    const ids = AGENT_TOOLS[agentId] || [];
    return ids.map(id => TOOLS[id]).filter(Boolean);
}

function getTool(toolId) {
    return TOOLS[toolId] || null;
}

/**
 * Build a tool definitions block to inject into an agent system prompt.
 * Only includes tools permitted for that agent.
 */
function buildToolPromptBlock(agentId) {
    const tools = getToolsForAgent(agentId);
    if (!tools.length) return '';

    const defs = tools.map(t => {
        const params = Object.entries(t.params)
            .map(([k, v]) => `      ${k} (${v.type}${v.required ? ', REQUIRED' : ', optional'}): ${v.description}`)
            .join('\n');
        return `TOOL: ${t.id}\nDescription: ${t.description}\nParameters:\n${params}\nReturns: ${t.returns}`;
    }).join('\n\n');

    return `
REAL TOOLS AVAILABLE TO YOU:
You have access to the following tools that return REAL data from the client's systems.
When you need data to support your response, use a tool. Do NOT hallucinate numbers.

${defs}

TO USE A TOOL, output ONLY this block (nothing else on that turn):
<tool_call>
{
  "tool": "tool_id_here",
  "params": { "param_name": "value" }
}
</tool_call>

After the tool result is returned, use the real data in your final response.
Only call ONE tool at a time. Only call tools when they will meaningfully improve your response.
`;
}

module.exports = { TOOLS, AGENT_TOOLS, getToolsForAgent, getTool, buildToolPromptBlock };
