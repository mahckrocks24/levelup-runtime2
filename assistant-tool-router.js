'use strict';

/**
 * LevelUp — Assistant Tool Router
 * Phase 2: Pre-reasoning intent detection → recommended tools
 *
 * Detects user intent from message text and injects relevant tool suggestions
 * into the assistant prompt before the LLM reasons. This dramatically improves
 * tool selection accuracy without requiring the LLM to discover tools from scratch.
 *
 * Usage:
 *   const { routeIntent } = require('./assistant-tool-router');
 *   const suggestions = routeIntent(message, agentId);
 *   // suggestions: { tools: string[], reasoning: string, intent: string }
 */

const { hasCapability } = require('./capability-map');

// ── Intent pattern catalogue ──────────────────────────────────────────────────
// Each entry: { patterns[], intent, tools[], reasoning }
const INTENT_PATTERNS = [

  // ── SEO ──────────────────────────────────────────────────────────────────
  {
    patterns: [/competitor|rank|ranking|serp|who.*ranks|top.*result|search.*result/i],
    intent:   'competitor_research',
    tools:    ['serp_analysis'],
    reasoning: 'User is asking about search rankings or competitors — serp_analysis returns live SERP data.',
  },
  {
    patterns: [/audit.*site|site.*audit|seo.*audit|technical.*seo|crawl.*error|page.*speed/i],
    intent:   'seo_audit',
    tools:    ['deep_audit', 'get_site_pages'],
    reasoning: 'User wants an SEO audit — deep_audit provides full technical + content analysis.',
  },
  {
    patterns: [/write.*article|create.*post|generate.*blog|draft.*content|seo.*article/i],
    intent:   'content_generation',
    tools:    ['write_article', 'serp_analysis'],
    reasoning: 'User wants content generated — write_article creates SEO-optimised articles.',
  },
  {
    patterns: [/content.*gap|missing.*content|what.*pages|existing.*content|do we.*cover|already.*written|do we have content|have.*content.*about|content.*about|pages.*about|written.*about/i],
    intent:   'content_gap',
    tools:    ['search_site_content', 'get_site_pages'],
    reasoning: 'User is checking content coverage — search_site_content finds existing pages on a topic.',
  },
  {
    patterns: [/keyword|volume|difficulty|what.*keyword|target.*keyword|focus.*keyword/i],
    intent:   'keyword_research',
    tools:    ['serp_analysis', 'ai_status'],
    reasoning: 'User needs keyword intelligence — serp_analysis returns keyword and competitor data.',
  },
  {
    patterns: [/internal.*link|link.*suggestion|link.*opportunity|linking.*strategy/i],
    intent:   'internal_links',
    tools:    ['link_suggestions', 'get_site_pages'],
    reasoning: 'User is asking about internal linking — link_suggestions finds link opportunities.',
  },
  {
    patterns: [/outbound.*link|external.*link|broken.*link|link.*check/i],
    intent:   'outbound_links',
    tools:    ['outbound_links', 'check_outbound'],
    reasoning: 'User wants to audit outbound links.',
  },

  // ── Website / Content ─────────────────────────────────────────────────────
  {
    patterns: [/what.*page|what.*site|homepage|services.*page|about.*page|read.*website|site.*content|scan.*url/i],
    intent:   'site_content',
    tools:    ['get_site_pages', 'scan_site_url', 'search_site_content'],
    reasoning: 'User wants to know about website content — get_site_pages lists scanned pages.',
  },
  {
    patterns: [/build.*page|landing.*page|create.*page|new.*page|generate.*layout/i],
    intent:   'page_building',
    tools:    ['generate_page_layout', 'list_builder_pages'],
    reasoning: 'User wants a page built — generate_page_layout creates AI layouts.',
  },

  // ── CRM ──────────────────────────────────────────────────────────────────
  {
    patterns: [/lead|prospect|pipeline|crm|contact.*list|how many.*lead|show.*lead/i],
    intent:   'crm_query',
    tools:    ['list_leads', 'list_sequences'],
    reasoning: 'User is asking about CRM data — list_leads returns current pipeline.',
  },
  {
    patterns: [/add.*lead|new.*lead|create.*contact|add.*prospect/i],
    intent:   'crm_create',
    tools:    ['create_lead'],
    reasoning: 'User wants to add a lead to CRM.',
  },
  {
    patterns: [/nurture|sequence|email.*sequence|drip|enroll/i],
    intent:   'lead_nurture',
    tools:    ['list_sequences', 'enroll_sequence', 'list_leads'],
    reasoning: 'User is asking about lead nurturing — list_sequences shows available sequences.',
  },

  // ── Social ────────────────────────────────────────────────────────────────
  {
    patterns: [/social.*post|create.*post|draft.*post|schedule.*post|post.*linkedin|post.*instagram/i],
    intent:   'social_create',
    tools:    ['create_post', 'get_queue'],
    reasoning: 'User wants a social post created — create_post drafts it for scheduling.',
  },
  {
    patterns: [/social.*queue|scheduled.*post|what.*scheduled|upcoming.*post/i],
    intent:   'social_queue',
    tools:    ['get_queue', 'list_posts'],
    reasoning: 'User wants to see the social queue.',
  },

  // ── Campaigns / Marketing ─────────────────────────────────────────────────
  {
    patterns: [/campaign|email.*campaign|marketing.*plan|launch.*campaign/i],
    intent:   'marketing_campaign',
    tools:    ['list_campaigns', 'create_campaign'],
    reasoning: 'User is asking about campaigns — list_campaigns shows current campaigns.',
  },

  // ── Calendar ──────────────────────────────────────────────────────────────
  {
    patterns: [/schedule|calendar|booking|event|meeting.*time|available.*slot/i],
    intent:   'calendar',
    tools:    ['list_events', 'check_availability'],
    reasoning: 'User is asking about scheduling — list_events shows upcoming calendar.',
  },

  // ── Platform status ───────────────────────────────────────────────────────
  {
    patterns: [/status|health|platform.*ok|ai.*ready|system.*check/i],
    intent:   'platform_status',
    tools:    ['ai_status'],
    reasoning: 'User wants platform status — ai_status returns engine readiness.',
  },
];

/**
 * Detect intent from message and return recommended tools for that agent.
 *
 * @param {string} message   — user message text
 * @param {string} agentId   — agent executing (for capability filter)
 * @returns {{ tools: string[], reasoning: string, intent: string }}
 */
function routeIntent(message, agentId = 'dmm') {
  const matched = [];

  for (const entry of INTENT_PATTERNS) {
    const hits = entry.patterns.filter(p => p.test(message));
    if (!hits.length) continue;

    // Filter tools to only those this agent can use
    const allowedTools = entry.tools.filter(t => hasCapability(agentId, t));
    if (!allowedTools.length) continue;

    matched.push({
      intent:    entry.intent,
      tools:     allowedTools,
      reasoning: entry.reasoning,
      strength:  hits.length,
    });
  }

  if (!matched.length) {
    return { tools: [], reasoning: '', intent: 'general' };
  }

  // Sort by strength (pattern hit count) desc, return top match + deduped tools
  matched.sort((a, b) => b.strength - a.strength);
  const topIntent  = matched[0].intent;
  const allTools   = [...new Set(matched.flatMap(m => m.tools))].slice(0, 4);
  const reasonParts = [...new Set(matched.map(m => m.reasoning))].slice(0, 2);

  return {
    intent:    topIntent,
    tools:     allTools,
    reasoning: reasonParts.join(' '),
  };
}

/**
 * Format tool suggestions as a prompt injection block.
 * Injected into the assistant system prompt before LLM call.
 */
function formatToolSuggestions(suggestions) {
  if (!suggestions.tools.length) return '';
  return `
RECOMMENDED TOOLS FOR THIS QUESTION:
${suggestions.tools.map(t => `  • ${t}`).join('\n')}
Reasoning: ${suggestions.reasoning}
Call the relevant tool(s) to get real data before answering.`;
}

module.exports = { routeIntent, formatToolSuggestions };
