'use strict';

/**
 * LevelUp Agent System — Phase 3: DB-Aware Agent Adapter
 *
 * Agent identities now come from WordPress DB (lu/v1/agents).
 * Static AGENTS object kept as fallback — ensures zero downtime
 * if the DB endpoint is unreachable during startup.
 *
 * agent_id values are permanent: dmm, james, priya, marcus, elena, alex.
 * capability_set is now DB-driven (seeded from capability-map.js — identical behavior).
 * model_preference field supported on each role for future multi-provider routing.
 */

const axios = require('axios');

// Lazy ref to capability-map — fallback if DB unreachable
let _capMap = null;
function capMap() {
    if (!_capMap) _capMap = require('./capability-map');
    return _capMap;
}

// ── Static fallback AGENTS (used only if DB fetch fails) ─────────────────
const AGENTS_STATIC = {
    dmm:    { id:'dmm',    name:'Sarah',  title:'Digital Marketing Manager', emoji:'👩‍💼', color:'#6C5CE7' },
    james:  { id:'james',  name:'James',  title:'SEO Strategist',            emoji:'📊',  color:'#3B8BF5' },
    priya:  { id:'priya',  name:'Priya',  title:'Content Manager',           emoji:'✍️',  color:'#A78BFA' },
    marcus: { id:'marcus', name:'Marcus', title:'Social Media Manager',      emoji:'📱',  color:'#F59E0B' },
    elena:  { id:'elena',  name:'Elena',  title:'CRM & Leads Specialist',    emoji:'🎯',  color:'#F87171' },
    alex:   { id:'alex',   name:'Alex',   title:'Technical SEO Engineer',    emoji:'⚙️',  color:'#00E5A8' },
};

// Live agent roster — populated from DB on startup, refreshed every 5 minutes
let _agentsLive  = null;
let _agentsFetch = null; // in-flight promise dedup
let _lastFetched = 0;
const REFRESH_MS = 5 * 60 * 1000;

async function fetchAgentsFromDB() {
    const wpUrl = process.env.WP_URL || process.env.WP_CALLBACK_URL?.replace('/wp-json/levelup/v1/core/task-result', '') || '';
    if (!wpUrl) return null;

    try {
        const { data } = await axios.get(`${wpUrl}/wp-json/lu/v1/agents`, { timeout: 8000 });
        if (!data?.agents?.length) return null;
        // Convert array to keyed object by agent_id
        const map = {};
        for (const a of data.agents) {
            map[a.agent_id] = {
                id:               a.agent_id,
                name:             a.name,
                title:            a.title,
                emoji:            a.avatar  || '🤖',
                color:            a.color   || '#8B97B0',
                role_slug:        a.role_slug,
                capability_set:   a.capability_set || [],
                skill_domains:    a.skill_domains  || [],
                model_preference: a.model_preference || null,
            };
        }
        console.log(`[AGENTS] Loaded ${Object.keys(map).length} agents from DB`);
        return map;
    } catch (e) {
        console.warn(`[AGENTS] DB fetch failed, using static fallback: ${e.message}`);
        return null;
    }
}

// Get current AGENTS — DB if fresh, else static fallback
async function getAgents() {
    const now = Date.now();
    if (_agentsLive && (now - _lastFetched) < REFRESH_MS) return _agentsLive;
    if (_agentsFetch) return _agentsFetch; // deduplicate concurrent calls

    _agentsFetch = fetchAgentsFromDB().then(result => {
        _agentsFetch = null;
        if (result) {
            _agentsLive  = result;
            _lastFetched = Date.now();
        }
        return _agentsLive || AGENTS_STATIC;
    }).catch(() => {
        _agentsFetch = null;
        return _agentsLive || AGENTS_STATIC;
    });

    return _agentsFetch;
}

// Sync accessor (uses live cache if populated, static otherwise)
// Safe to call from synchronous code — non-blocking
function getAgentsSync() {
    return _agentsLive || AGENTS_STATIC;
}

// AGENTS export — backward-compat alias to sync accessor
// All existing code that does `require('./agents').AGENTS` still works
const AGENTS = new Proxy({}, {
    get(_, key) { return getAgentsSync()[key]; },
    ownKeys()   { return Object.keys(getAgentsSync()); },
    has(_, key) { return key in getAgentsSync(); },
    getOwnPropertyDescriptor(_, key) {
        return key in getAgentsSync()
            ? { configurable: true, enumerable: true, writable: false }
            : undefined;
    },
});

const TOKENS = {
    manager:      600,
    specialist:   600,
    synthesis:    1400,
    tasks:        800,
    deliberation: 250,
    vision:       700,
};

const MAX_TURNS_PER_ROUND   = 3;
const MAX_AGENT_RESPONSES   = 15;
const DUPLICATE_THRESHOLD   = 0.90;

// ── TEAM_ROSTER ────────────────────────────────────────────────────────────
// Assembled dynamically from live agent data when possible
function getTeamRoster() {
    const a = getAgentsSync();
    return `
YOUR TEAM — know exactly who owns what:
- ${a.dmm?.name    || 'Sarah'}  (DMM) = Marketing Director. Leads strategy, coordinates team, synthesises decisions.
- ${a.james?.name  || 'James'}  = SEO Strategist. Owns keyword research, SERP analysis, topical authority, competitor gaps.
- ${a.priya?.name  || 'Priya'}  = Content Manager. Owns editorial calendar, content briefs, brand voice, article generation.
- ${a.marcus?.name || 'Marcus'} = Social Media Manager. Owns platform strategy, scheduling, community management.
- ${a.elena?.name  || 'Elena'}  = CRM & Leads. Owns lead capture, pipeline, email nurture, lead scoring.
- ${a.alex?.name   || 'Alex'}   = Technical SEO. Owns Core Web Vitals, crawl budget, internal linking, schema.
HARD RULES: All agents always present. Never claim someone is unavailable. When @mentioned you MUST respond. Deliver — never promise to deliver later.`;
}

// Keep TEAM_ROSTER as a getter for backward compat
const TEAM_ROSTER = getTeamRoster();

// ── buildAssistantPrompt (unchanged from Sprint F) ─────────────────────────
function buildAssistantPrompt(message, context = {}) {
    const agents = getAgentsSync();
    const names  = Object.values(agents).map(a => `${a.name} (${a.title})`).join(', ');
    return `You are the LevelUp AI Assistant — a smart interface layer for the LevelUp Growth marketing platform.

Your job is to help the user navigate the platform, understand agent activity, and take actions.

PLATFORM CONTEXT:
${context.businessName ? `Business: ${context.businessName}` : ''}
${context.industry ? `Industry: ${context.industry}` : ''}
${context.goals ? `Goals: ${context.goals}` : ''}

AVAILABLE AGENTS: ${names}

You can:
1. Answer questions about the platform and agent activity
2. Navigate to platform views by calling tools
3. Consult specialist agents for domain expertise

TOOLS AVAILABLE:
<assistant_tool>{ "tool": "navigate", "params": { "view": "workspace|projects|agents|crm|marketing|social|calendar|reports|approvals" } }</assistant_tool>
<assistant_tool>{ "tool": "ask_agent", "params": { "agent": "dmm|james|priya|marcus|elena|alex", "question": "..." } }</assistant_tool>

Keep responses concise (under 100 words unless detail is needed).
When asked about specific domains, use ask_agent to get specialist input.
Current user message: ${message}`;
}

function buildAgentConsultPrompt(agentId, question, context = {}) {
    const agents = getAgentsSync();
    const agent  = agents[agentId] || AGENTS_STATIC[agentId] || { name: agentId, title: 'Specialist' };
    return `You are ${agent.name}, ${agent.title} at LevelUp Growth.
${context.businessName ? `Business: ${context.businessName}` : ''}
${context.industry ? `Industry: ${context.industry}` : ''}
Answer concisely as your specialist role. Be direct and actionable.`;
}

// Pre-fetch agents on module load (non-blocking)
getAgents().catch(() => {});

module.exports = {
    AGENTS,
    AGENTS_STATIC,
    TOKENS,
    TEAM_ROSTER,
    MAX_TURNS_PER_ROUND,
    MAX_AGENT_RESPONSES,
    DUPLICATE_THRESHOLD,
    getAgents,
    getAgentsSync,
    getTeamRoster,
    buildAssistantPrompt,
    buildAgentConsultPrompt,
};
