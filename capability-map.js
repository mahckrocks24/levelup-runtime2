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
    // Manages autonomous goals and high-level orchestration
    dmm: [
        'autonomous_goal',   // Submit background goals to the SEO agent
        'list_goals',        // Review all active goals
        'agent_status',      // Check progress on a specific goal
        'pause_goal',        // Pause a running goal
        'ai_status',         // Check if AI is ready before delegating
    ],

    // James — SEO Specialist
    // Handles research, analysis, and reporting
    james: [
        'serp_analysis',     // Live SERP competitor data
        'ai_report',         // Full AI content intelligence report
        'deep_audit',        // Deep per-post SEO audit
        'ai_status',         // Check AI readiness
        'list_goals',        // View active autonomous goals
        'agent_status',      // Monitor goal progress
        'pause_goal',        // Pause a goal if needed
    ],

    // Priya — Content Specialist
    // Handles content creation and improvement
    priya: [
        'write_article',     // Generate full SEO article as WP draft
        'improve_draft',     // AI-improve an existing post
        'ai_report',         // Use AI report to inform content
        'ai_status',         // Check AI readiness
        'list_goals',        // View active goals
        'agent_status',      // Monitor goal progress
    ],

    // Marcus — Social Media Specialist
    // No tools yet — Phase 3 will add social publishing tools
    marcus: [
        'ai_status',         // Check AI readiness (general utility)
        'list_goals',        // View active goals
        'agent_status',      // Monitor goal progress
    ],

    // Elena — CRM Specialist
    // No tools yet — Phase 3 will add CRM tools
    elena: [
        'ai_status',         // Check AI readiness (general utility)
        'list_goals',        // View active goals
        'agent_status',      // Monitor goal progress
    ],

    // Alex — Technical SEO Specialist
    // Handles link management and technical audits
    alex: [
        'deep_audit',        // Deep per-post technical audit
        'link_suggestions',  // Get internal link suggestions
        'insert_link',       // Insert a suggested link into content
        'dismiss_link',      // Dismiss a link suggestion
        'outbound_links',    // View outbound links for a post
        'check_outbound',    // Live health scan of outbound links
        'ai_status',         // Check AI readiness
        'list_goals',        // View active goals
        'agent_status',      // Monitor goal progress
        'pause_goal',        // Pause a goal if needed
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
