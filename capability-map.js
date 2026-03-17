'use strict';

/**
 * LevelUp Capability Map
 *
 * Defines which tools each agent is permitted to use.
 * This is the single source of truth for agent permissions.
 *
 * When new tools are added (CRM, Marketing, Social, etc.),
 * add them to the relevant agent's list here.
 *
 * Agents:
 *   dmm     → Sarah  (DMM Director — orchestration + goals)
 *   james   → James  (SEO Specialist)
 *   priya   → Priya  (Content Specialist)
 *   marcus  → Marcus (Social Specialist — no tools yet, Phase 3)
 *   elena   → Elena  (CRM Specialist — no tools yet, Phase 3)
 *   alex    → Alex   (Technical SEO Specialist)
 */

const CAPABILITY_MAP = {

    // Sarah — DMM Director
    dmm: [
        // SEO
        'autonomous_goal', 'list_goals', 'agent_status', 'pause_goal', 'ai_status',
        // CRM — full access including sequence discovery
        'create_lead', 'get_lead', 'update_lead', 'list_leads', 'move_lead', 'log_activity', 'add_note', 'enroll_sequence', 'list_sequences',
        // Marketing — full access including schedule + sequences
        'create_campaign', 'update_campaign', 'list_campaigns', 'schedule_campaign',
        'create_template', 'list_templates', 'create_automation', 'record_metric',
        // Social
        'create_post', 'schedule_post', 'list_posts', 'update_post', 'get_queue', 'record_social_analytics',
        // Calendar
        'create_event', 'list_events', 'update_event', 'check_availability', 'create_booking_slot',
        // Builder
        'list_builder_pages', 'get_builder_page', 'ai_builder_action', 'generate_page_layout', 'publish_builder_page', 'import_html_page',
    ],

    // James — SEO Specialist
    james: [
        // SEO — full access including link analysis
        'serp_analysis', 'ai_report', 'deep_audit', 'ai_status', 'list_goals', 'agent_status', 'pause_goal',
        'link_suggestions', 'outbound_links', 'check_outbound',
        // CRM — read only
        'get_lead', 'list_leads',
        // Marketing — read only
        'list_campaigns', 'record_metric',
        // Social — read only
        'list_posts', 'get_queue',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — read only
        'list_builder_pages', 'get_builder_page',
    ],

    // Priya — Content Specialist
    priya: [
        // SEO
        'write_article', 'improve_draft', 'ai_report', 'ai_status', 'list_goals', 'agent_status',
        // Marketing
        'create_campaign', 'update_campaign', 'list_campaigns', 'create_template', 'list_templates', 'create_automation',
        // Social
        'create_post', 'update_post', 'list_posts',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — content generation
        'list_builder_pages', 'get_builder_page', 'ai_builder_action', 'generate_page_layout',
    ],

    // Marcus — Social Media Specialist
    marcus: [
        // SEO — utility only
        'ai_status', 'list_goals', 'agent_status',
        // Marketing — read only
        'list_campaigns',
        // Social — full access including publish
        'create_post', 'schedule_post', 'publish_post', 'list_posts', 'update_post', 'get_queue', 'record_social_analytics',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
    ],

    // Elena — CRM Specialist
    elena: [
        // SEO — utility only
        'ai_status', 'list_goals', 'agent_status',
        // CRM — full access including sequence discovery
        'create_lead', 'get_lead', 'update_lead', 'list_leads', 'move_lead', 'log_activity', 'add_note', 'enroll_sequence', 'list_sequences',
        // Marketing — template and campaign read
        'list_campaigns', 'list_templates',
        // Calendar — full access
        'create_event', 'list_events', 'update_event', 'check_availability', 'create_booking_slot',
    ],

    // Alex — Technical SEO Specialist
    alex: [
        // SEO — full technical access
        'deep_audit', 'link_suggestions', 'insert_link', 'dismiss_link', 'outbound_links', 'check_outbound',
        'ai_status', 'list_goals', 'agent_status', 'pause_goal',
        // Calendar
        'list_events', 'check_availability', 'create_event', 'update_event',
        // Builder — read + import
        'list_builder_pages', 'get_builder_page', 'import_html_page',
    ],
};

/**
 * Get the list of tool IDs an agent can use.
 * @param {string} agentId
 * @returns {string[]}
 */
function getToolIds(agentId) {
    return CAPABILITY_MAP[agentId] || [];
}

/**
 * Check if an agent has a specific capability.
 * @param {string} agentId
 * @param {string} toolId
 * @returns {boolean}
 */
function hasCapability(agentId, toolId) {
    return (CAPABILITY_MAP[agentId] || []).includes(toolId);
}

/**
 * Get a human-readable capability summary for an agent (for debugging/UI).
 * @param {string} agentId
 * @returns {object}
 */
function getAgentCapabilitySummary(agentId) {
    const registry = require('./tool-registry');
    const toolIds  = getToolIds(agentId);
    const tools    = toolIds.map(id => registry.getTool(id)).filter(Boolean);

    return {
        agent:       agentId,
        tool_count:  tools.length,
        tools:       tools.map(t => ({ id: t.id, name: t.name, domain: t.domain, requires_approval: t.requires_approval })),
        domains:     [...new Set(tools.map(t => t.domain))],
    };
}

/**
 * Get full capability map (for admin/debugging).
 * @returns {object}
 */
function getAllCapabilities() {
    return Object.keys(CAPABILITY_MAP).reduce((acc, agentId) => {
        acc[agentId] = getAgentCapabilitySummary(agentId);
        return acc;
    }, {});
}

module.exports = { CAPABILITY_MAP, getToolIds, hasCapability, getAgentCapabilitySummary, getAllCapabilities };
