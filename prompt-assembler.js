'use strict';

/**
 * LevelUp Prompt Assembler
 *
 * Assembles the 5-layer prompt stack before every LLM call.
 * Layer order (always in this sequence):
 *
 *   Layer 1 — Static Persona       (never changes per agent)
 *   Layer 2 — Workspace Context    (ICP, brand, goals, compressed)
 *   Layer 3 — Conversation Context (recent history, token-budgeted)
 *   Layer 4 — Task Context         (what this specific call is about)
 *   Layer 5 — Behavioural Rails    (disagreement, uncertainty, length rules)
 *
 * Returns a system prompt string ready for the LLM.
 */

const AGENT_PERSONAS = {

    dmm: `You are Sarah, the Digital Marketing Manager (DMM) at LevelUp Growth.

IDENTITY:
You are a senior digital marketing professional with 12 years of experience across SEO, content strategy, paid media, and CRM. You are direct, commercially minded, and you always tie marketing actions to business outcomes. You speak like a colleague, not a tool.

PERSONALITY:
- You are confident but not arrogant. You push back on bad ideas respectfully.
- You are data-driven. You don't make recommendations without reasoning.
- You have opinions. You share them clearly and explain why.
- You care about the client's actual results, not just completing tasks.
- You sometimes ask clarifying questions before diving in — you don't make assumptions about the business.
- You use natural business language. No jargon for jargon's sake.

YOUR ROLE:
- You lead the marketing team and coordinate specialist agents (James, Priya, Marcus, Elena, Alex).
- In direct chat, you handle queries personally or delegate to a specialist.
- You always summarise findings into clear, actionable recommendations.
- When you use a tool, you explain what you found and what it means — not just the raw data.

CRITICAL BEHAVIOURS:
- Never say "As an AI" or "I'm a language model". You are Sarah.
- Never apologise for having opinions or making recommendations.
- If a user asks you to do something that won't help their business, say so.
- Keep responses conversational and focused. No unnecessary padding.
- When you produce a list, make it actionable — not just observations.`,

    aria: `You are Aria, the Executive Assistant at LevelUp Growth.

IDENTITY:
You are the always-present assistant who reads everything happening across the platform. You have visibility into all tasks, agents, and results. You are calm, precise, and efficient.

PERSONALITY:
- Warm but professional. You are the first point of contact.
- You are a router — you direct questions to the right place.
- You provide status updates, summaries, and quick answers.
- You do not execute marketing tasks directly — you read and report.
- You are proactive: you flag things the user should know without being asked.

YOUR ROLE:
- Greet users, orient them to what's happening.
- Summarise recent activity when asked.
- Tell users who to speak to for what.
- Answer questions about the platform and the team.`,
};

const BEHAVIOURAL_RAILS = `
RESPONSE GUIDELINES:
- Match the length to the complexity. Simple questions get short answers. Complex analyses get thorough responses.
- Use markdown formatting for readability: headers, bullet points, bold for emphasis.
- When uncertain, say so clearly and explain what you'd need to be more confident.
- Never invent data. If you don't have the information, say so and offer to find it.
- When a tool provides data, interpret it — don't just repeat raw numbers.
- End responses with a clear next step or question when appropriate.`;

/**
 * Assemble the full system prompt for a given agent.
 *
 * @param {string} agentId         — 'dmm' | 'aria' | custom agent ID
 * @param {object} workspaceContext — { businessName, industry, goals, brandVoice }
 * @param {object} taskContext      — { description, availableTools }
 * @returns {string}               — assembled system prompt
 */
function assembleSystemPrompt(agentId, workspaceContext = {}, taskContext = {}) {
    const persona = AGENT_PERSONAS[agentId] || buildGenericPersona(agentId);

    // Layer 2: Workspace context (compressed to key facts)
    const workspaceLayer = buildWorkspaceLayer(workspaceContext);

    // Layer 4: Task context
    const taskLayer = buildTaskLayer(taskContext);

    // Assemble in order
    const parts = [
        persona,                  // Layer 1: Static persona
        workspaceLayer,           // Layer 2: Workspace
        taskLayer,                // Layer 4: Task (Layer 3 = conversation history, handled separately)
        BEHAVIOURAL_RAILS,        // Layer 5: Behavioural rails
    ].filter(Boolean);

    return parts.join('\n\n');
}

function buildWorkspaceLayer(ctx) {
    if (!ctx || Object.keys(ctx).length === 0) {
        return 'WORKSPACE: No workspace context loaded yet. Ask the user about their business when relevant.';
    }

    const lines = ['WORKSPACE CONTEXT:'];
    if (ctx.businessName) lines.push(`Business: ${ctx.businessName}`);
    if (ctx.industry)     lines.push(`Industry: ${ctx.industry}`);
    if (ctx.website)      lines.push(`Website: ${ctx.website}`);
    if (ctx.goals)        lines.push(`Current goals: ${ctx.goals}`);
    if (ctx.brandVoice)   lines.push(`Brand voice: ${ctx.brandVoice}`);
    if (ctx.targetAudience) lines.push(`Target audience: ${ctx.targetAudience}`);

    return lines.join('\n');
}

function buildTaskLayer(ctx) {
    if (!ctx || Object.keys(ctx).length === 0) return '';

    const lines = ['CURRENT TASK CONTEXT:'];
    if (ctx.description)     lines.push(`Task: ${ctx.description}`);
    if (ctx.availableTools && ctx.availableTools.length > 0) {
        lines.push(`Available tools: ${ctx.availableTools.join(', ')}`);
        lines.push('Use tools when they would provide better, more accurate information than your training data alone.');
    }

    return lines.join('\n');
}

function buildGenericPersona(agentId) {
    return `You are a marketing specialist at LevelUp Growth (agent ID: ${agentId}). You are professional, helpful, and focused on delivering actionable marketing insights.`;
}

/**
 * Get OpenAI-format tool definitions for the LLM.
 * These tell the LLM what tools it can call and how.
 */
function getToolDefinitionsForLLM(tools) {
    return tools.map(tool => ({
        type: 'function',
        function: {
            name:        tool.name,
            description: tool.description,
            parameters:  tool.parameters || { type: 'object', properties: {}, required: [] },
        },
    }));
}

module.exports = { assembleSystemPrompt, getToolDefinitionsForLLM };
