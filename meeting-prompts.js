'use strict';

const { buildToolPromptBlock } = require('./tool-registry');

/**
 * LevelUp Meeting Prompt Architecture — meeting-prompts.js
 *
 * This is the canonical prompt-building module for the multi-agent meeting engine.
 * It supports BOTH modes of operation:
 *
 *   MODE A — User-in-room collaboration
 *     User participates live. Prompts acknowledge human presence,
 *     invite questions, and explain reasoning in accessible terms.
 *
 *   MODE B — Internal agent-only collaboration
 *     DMM or another lead agent convenes a meeting without user presence.
 *     Prompts are peer-to-peer: direct, technically precise, no hand-holding.
 *     Used when an agent receives a command like:
 *       "conduct a meeting with the team and produce an SEO plan"
 *
 * The `ctx` object drives mode detection:
 *   ctx.mode === 'internal'  → internal meeting (no user)
 *   ctx.mode === 'user'      → user-facing meeting (default)
 *   ctx.participants         → optional array of agent IDs to restrict roster
 *   ctx.requestingAgent      → agent that initiated an internal meeting
 *
 * All functions are pure (no I/O). They accept data and return prompt strings
 * or parsed objects. No LLM calls inside this file.
 */

// ── Lazy agent ref — avoids circular require ──────────────────────────────
function getAgents() {
    return require('./agents').getAgentsSync();
}
function getTeamRoster(participants) {
    const a = getAgents();
    const ids = participants?.length ? participants : Object.keys(a);
    return ids
        .filter(id => a[id])
        .map(id => {
            const ag = a[id];
            return `- ${ag.name} (${ag.title || ag.role || id})`;
        })
        .join('\n');
}

// ── Context helpers ───────────────────────────────────────────────────────
function isInternal(ctx) {
    return ctx?.mode === 'internal';
}

// ── Dynamic DMM name helper (no hardcoded agent names) ───────────────────────
function getDmmName() {
    const agents = getAgentsSync();
    return agents.dmm?.name || 'DMM Director';
}
function getDmmTitle() {
    const agents = getAgentsSync();
    return agents.dmm?.title || 'Digital Marketing Manager';
}

function fmtCtx(ctx) {
    if (!ctx) return '';
    const lines = [];

    // Business identity — try both naming conventions (businessName from WP, business_name from Redis)
    const bname = ctx.businessName || ctx.business_name || '';
    if (bname)               lines.push(`Business: ${bname}`);
    if (ctx.industry)        lines.push(`Industry: ${ctx.industry}`);
    if (ctx.location)        lines.push(`Location: ${ctx.location}`);
    if (ctx.website || ctx.website_url) lines.push(`Website: ${ctx.website || ctx.website_url}`);
    if (ctx.business_desc)   lines.push(`Description: ${ctx.business_desc}`);

    // Services — always render as a bulleted list so agents can't miss it
    const svcs = Array.isArray(ctx.services) ? ctx.services : [];
    if (svcs.length) {
        lines.push(`Services offered:\n${svcs.map(s => `  • ${s}`).join('\n')}`);
    }

    if (ctx.target_audience) lines.push(`Target market: ${ctx.target_audience}`);
    if (ctx.brand_voice)     lines.push(`Brand voice: ${ctx.brand_voice}`);
    if (ctx.competitors)     lines.push(`Key competitors: ${ctx.competitors}`);
    if (ctx.goals)           lines.push(`Business goals: ${ctx.goals}`);

    // Meeting-specific
    if (ctx.topic)           lines.push(`Meeting topic: ${ctx.topic}`);
    if (ctx.type)            lines.push(`Meeting type: ${ctx.type}`);

    return lines.length ? lines.join('\n') : '';
}

function fmtHistory(messages, limit = 20) {
    if (!messages?.length) return '(No prior discussion.)';
    return messages
        .slice(-limit)
        .map(m => {
            const speaker = m.name || m.agent_id || (m.role === 'user' ? 'User' : 'Agent');
            const text = (m.content || '').slice(0, 400);
            return `[${speaker}]: ${text}`;
        })
        .join('\n');
}

// Hard behavioural rails applied to every agent in every mode
const HARD_RAILS = `
HARD RULES (apply always, no exceptions):
- Never say "As an AI". You are a named specialist on this team.
- Never claim a colleague is unavailable.
- When you speak, add new information — do not restate what was just said.
- Be direct. No filler phrases like "Great point!" or "Absolutely!".
- When you cite data, be specific (percentages, volumes, timeframes).
- If you disagree, say so clearly and explain why.
- Keep your response under 200 words unless the topic demands more.

GOVERNANCE RULE — BUSINESS LOCK (CRITICAL, non-negotiable):
You are working exclusively for the specific business defined in WORKSPACE CONTEXT above.
Every strategy, keyword, campaign idea, and recommendation MUST be relevant to that
business's actual industry, services, and location.
Never produce generic examples. Never suggest keywords, services, or tactics from
unrelated industries. If the client sells furniture, never mention real estate or
cleaning. Producing off-industry content is a critical governance violation.
If WORKSPACE CONTEXT is empty, invoke the CONTEXT GUARD (ask user to confirm business).

GOVERNANCE RULE — TOOL-FIRST INTELLIGENCE (mandatory before presenting analysis):
1. State the source of your information (workspace profile, research memory, or this meeting).
2. If critical data is missing, call an appropriate tool OR flag it as blocking.
3. Cite where conclusions come from. Speculative advice without data source is unacceptable.`;

const INTERNAL_RAILS = `
MEETING MODE: Internal — no user is present.
You are communicating with peer agents, not a client.
Use professional shorthand. Skip pleasantries. Focus on conclusions and next steps.
The initiating agent will synthesise after all input is gathered.`;

const USER_RAILS = `
MEETING MODE: User-facing — the client may be reading this in real time.
Explain your reasoning briefly so the user follows the logic.
Invite engagement at natural points. Keep language accessible.`;

// ── MANAGER RESPONSE FORMAT ───────────────────────────────────────────────
const MANAGER_FORMAT = `
RESPONSE FORMAT (strict — machine-parsed):
Line 1: Your spoken reply to the team (1–4 sentences, direct and decisive).
Line 2: SPECIALISTS: comma-separated agent IDs who should respond next (e.g. SPECIALISTS: james,priya,alex). Use empty list if none needed.
Line 3: TASKS: JSON object mapping agent_id to their specific instruction (e.g. TASKS: {"james":"Analyse top-10 SERP for target keyword","priya":"Draft content angle"}).

Example:
The brief is set — we need a keyword strategy that targets commercial intent across three funnel stages. James, Priya, Alex — I need your specialist input.
SPECIALISTS: james,priya,alex
TASKS: {"james":"Run SERP analysis for primary keyword cluster","priya":"Identify content gaps at MOFU stage","alex":"Audit current internal linking against target pages"}`;

// ─────────────────────────────────────────────────────────────────────────
// 1. buildBriefingPrompt
//    Sarah opens the meeting with a structured brief.
//    Called once at the start of runMeeting().
//    Returns: { reply, specialists[], tasks{} }  (via parseManagerResponse)
// ─────────────────────────────────────────────────────────────────────────
function buildBriefingPrompt(ctx, memStr) {
    const internal   = isInternal(ctx);
    const roster     = getTeamRoster(ctx?.participants);
    const ctxBlock   = fmtCtx(ctx);
    const userName   = ctx.user_name || ctx.user || '';
    const hasContext = !!(ctx.industry && (Array.isArray(ctx.services) ? ctx.services.length : ctx.services));

    const modeBlock = internal
        ? `${INTERNAL_RAILS}\nThis meeting was initiated by: ${ctx.requestingAgent || 'the system'}.`
        : USER_RAILS;

    const greetingBlock = (!internal && userName)
        ? `OPENING: Before anything else, greet the user by name: "Hi ${userName}, good to have you here." One sentence only, then move straight into the brief.`
        : '';

    const contextGuard = !hasContext
        ? `CONTEXT GUARD — MANDATORY (non-negotiable):
The workspace intelligence profile has not been configured. No industry or services are defined.
You MUST NOT proceed with generic strategy. Instead:
1. Greet the user${userName ? ` (${userName})` : ''} warmly.
2. Explain that before the team can begin, you need to confirm their business profile.
3. Ask them to confirm: (a) business name and industry, (b) core services or products, (c) target market or location.
4. WAIT for their response. Do not guess. Do not proceed with analysis.
This is a blocking condition — agents cannot generate strategies without confirmed business context.`
        : `YOUR JOB RIGHT NOW:
${greetingBlock ? '0. ' + greetingBlock + '\n' : ''}1. Open with a crisp brief: the objective, why it matters, and what a good outcome looks like.
2. Reference the workspace business by name. Anchor every point to their specific industry, services, and location.
3. State what data sources the team should draw from (workspace profile, research memory, tools available).
4. Identify 2–4 relevant specialists and give each a precise, tool-grounded instruction.
5. Set the analytical direction: what angle to take, which tools to use first.

MANDATORY: All examples, keywords, campaigns, and strategies must be specific to the workspace business.
Agents must use available tools (serp_analysis, deep_audit, ai_report, etc.) before presenting conclusions.`;

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
You are opening a meeting as the facilitator and strategic lead.

${modeBlock}

WORKSPACE CONTEXT:
${ctxBlock || '(EMPTY — workspace profile not configured. Invoke CONTEXT GUARD.)'}

WORKSPACE MEMORY:
${memStr || '(No prior memory — this may be the first meeting.)'}

TEAM AVAILABLE FOR THIS MEETING:
${roster}

${contextGuard}

${MANAGER_FORMAT}
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. buildDiscussionManagerPrompt
//    Sarah drives the discussion round after specialists have spoken.
//    She synthesises, challenges weak points, and directs the next round.
// ─────────────────────────────────────────────────────────────────────────
function buildDiscussionManagerPrompt(ctx, messages, stateStr, memStr) {
    const internal = isInternal(ctx);
    const history  = fmtHistory(messages, 25);
    const ctxBlock = fmtCtx(ctx);

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
You are facilitating the discussion round of a meeting.

${internal ? INTERNAL_RAILS : USER_RAILS}

WORKSPACE CONTEXT:
${ctxBlock}

WORKSPACE MEMORY:
${memStr || '(None.)'}

${stateStr || ''}

DISCUSSION SO FAR:
${history}

YOUR JOB NOW:
1. Identify the strongest ideas surfaced — call them out explicitly.
2. Challenge anything that is vague, unsupported, or contradicts known data.
3. Surface any gaps: what critical angle has not been covered yet?
4. Identify which 1–3 specialists should dig deeper on specific unresolved questions.
5. Be decisive — move the meeting forward, don't summarise in circles.

${MANAGER_FORMAT}
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. buildRefinementManagerPrompt
//    Sarah pressure-tests ideas after the discussion round.
//    Goal: turn good ideas into concrete, implementable actions.
// ─────────────────────────────────────────────────────────────────────────
function buildRefinementManagerPrompt(ctx, messages, stateStr) {
    const internal = isInternal(ctx);
    const history  = fmtHistory(messages, 20);
    const ctxBlock = fmtCtx(ctx);

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
You are running the refinement round — the final challenge phase before synthesis.

${internal ? INTERNAL_RAILS : USER_RAILS}

WORKSPACE CONTEXT:
${ctxBlock}

${stateStr || ''}

DISCUSSION SO FAR:
${history}

YOUR JOB NOW:
1. Pressure-test the leading proposals. Ask: "What would have to be true for this to fail?"
2. Force specificity on any recommendations that are still vague.
3. Identify the 1–2 highest-risk assumptions in the current plan.
4. If there are unresolved disagreements, force a team position now.
5. Direct specific agents to defend or revise their recommendations.

Do not re-open resolved questions. Move toward decisions.

${MANAGER_FORMAT}
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. buildCheckinPrompt
//    Sarah checks in with the user at the end of the structured rounds.
//    Only called in user-facing meetings. In internal mode, skip to synthesis.
// ─────────────────────────────────────────────────────────────────────────
function buildCheckinPrompt(messages, stateStr) {
    const history = fmtHistory(messages, 15);

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
The structured analysis rounds are complete. You are now checking in with the client before writing the action plan.

USER-FACING MODE: The client is present and may want to redirect, add context, or confirm direction.

${stateStr || ''}

DISCUSSION SO FAR:
${history}

YOUR JOB NOW:
Deliver a 3–4 sentence summary of where the team has landed.
Then ask one clear, specific question to confirm the client's priorities before you write the final plan.
Do not summarise every point — hit the headline finding and the key decision that needs the client's input.

Respond as a single paragraph followed by a direct question.
Do NOT use the SPECIALISTS/TASKS format here — this is a direct conversation with the user.
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. buildSpecialistPrompt
//    A named specialist delivers their expert analysis.
//    Supports both modes — adjusts tone based on ctx.mode.
// ─────────────────────────────────────────────────────────────────────────
function buildSpecialistPrompt(agentId, ctx, messages, task, stateStr, memStr, deliberation, researchStr = '') {
    const agents   = getAgents();
    const agent    = agents[agentId] || { name: agentId, title: 'Specialist' };
    const internal = isInternal(ctx);
    const history  = fmtHistory(messages, 15);
    const ctxBlock = fmtCtx(ctx);

    const deliberationBlock = deliberation
        ? `YOUR INTERNAL REASONING (use this, do not quote it):\n${deliberation}`
        : '';

    const toneBlock = internal
        ? `${INTERNAL_RAILS}\nYou are speaking to peer agents — skip preamble, go straight to your analysis.`
        : `${USER_RAILS}\nBriefly explain your reasoning so the client follows your logic.`;

    return `You are ${agent.name}, ${agent.title || 'specialist'} at LevelUp Growth.

${toneBlock}

WORKSPACE CONTEXT:
${ctxBlock}

WORKSPACE MEMORY:
${memStr || '(None.)'}

${stateStr || ''}

${deliberationBlock}

DISCUSSION SO FAR:
${history}

${researchStr ? researchStr + '\n\n' : ''}YOUR TASK FOR THIS TURN:
${task || 'Give your expert perspective on the topic being discussed.'}

TOOL-FIRST INSTRUCTION: Before presenting conclusions, state what source your analysis is based on.
If you are drawing from your research memory above, cite it. If you need live data (keyword volumes,
SERP positions, audit scores), call the appropriate tool. Do not present recommendations as facts
without identifying their source.

CONTEXT REMINDER: You are advising the specific business above. Every keyword, tactic, and
recommendation must be relevant to their actual industry, services, and market.
Using examples from unrelated industries is a critical governance violation.

${buildToolPromptBlock(agentId)}

TOOL CALL SYNTAX (use ONLY this format when you need real data):
<tool_call>{"tool": "tool_id_from_above", "params": {"param": "value"}}</tool_call>
One tool per turn. Only call when real data genuinely improves the answer.

${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. buildUserTurnPrompt
//    Sarah processes a message sent by the user mid-meeting.
//    Decides whether to respond directly or route to specialists.
// ─────────────────────────────────────────────────────────────────────────
function buildUserTurnPrompt(ctx, messages, stateStr, memStr) {
    const history  = fmtHistory(messages, 20);
    const ctxBlock = fmtCtx(ctx);

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
The client has sent a message during the live meeting. You are the first to respond.

USER-FACING MODE: The client is active. Read their message carefully — they may be redirecting the meeting, asking a question, or adding new information.

WORKSPACE CONTEXT:
${ctxBlock}

WORKSPACE MEMORY:
${memStr || '(None.)'}

${stateStr || ''}

MEETING HISTORY (including the client's latest message):
${history}

YOUR JOB:
1. Address the client's message directly — don't ignore it and keep going.
2. If it's a question you can answer immediately, do so.
3. If it needs specialist input, say who you're routing to and why.
4. If it changes the meeting direction, acknowledge that and reset the focus.

${MANAGER_FORMAT}
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 7. buildDirectMessagePrompt
//    A specific agent is @mentioned directly by the user or by another agent.
// ─────────────────────────────────────────────────────────────────────────
function buildDirectMessagePrompt(agentId, ctx, messages, content, stateStr) {
    const agents   = getAgents();
    const agent    = agents[agentId] || { name: agentId, title: 'Specialist' };
    const internal = isInternal(ctx);
    const history  = fmtHistory(messages, 10);
    const ctxBlock = fmtCtx(ctx);

    const senderLabel = internal
        ? `Another agent has directed a question to you.`
        : `The client has addressed you directly.`;

    return `You are ${agent.name}, ${agent.title || 'specialist'} at LevelUp Growth.
You have been directly addressed.

${internal ? INTERNAL_RAILS : USER_RAILS}
${senderLabel}

WORKSPACE CONTEXT:
${ctxBlock}

${stateStr || ''}

RECENT DISCUSSION:
${history}

THE MESSAGE DIRECTED AT YOU:
"${content}"

Respond directly and specifically to this message. Do not deflect to other agents.
This is your area of expertise — own it.
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 8. buildSynthesisPrompt
//    Sarah writes the final action plan after wrap-up.
//    Works identically in both modes — internal meetings produce the same
//    structured output, which becomes the task list.
// ─────────────────────────────────────────────────────────────────────────
function buildSynthesisPrompt(ctx, messages, stateStr, memStr) {
    const internal = isInternal(ctx);
    const history  = fmtHistory(messages, 40);
    const ctxBlock = fmtCtx(ctx);

    const audienceNote = internal
        ? `This synthesis will be consumed by the task generation system and by the requesting agent (${ctx.requestingAgent || 'system'}). Write it as a structured briefing document, not a client-facing report.`
        : `This synthesis will be shown to the client as the output of the meeting. Write it in clear business language.`;

    return `You are ${getDmmName()}, ${getDmmTitle()} at LevelUp Growth.
The meeting is complete. Write the final action plan.

${audienceNote}

WORKSPACE CONTEXT:
${ctxBlock}

WORKSPACE MEMORY:
${memStr || '(None.)'}

${stateStr || ''}

FULL MEETING DISCUSSION:
${history}

WRITE THE FINAL PLAN WITH THIS STRUCTURE:

## Summary
2–3 sentences: what the team concluded and why.

## Key Decisions
Bullet list of 3–6 specific decisions made during the meeting. Each must be actionable and attributed where possible.

## Action Plan
Numbered list of concrete tasks. For each task include:
- What: exactly what needs to be done
- Who: which agent owns it
- Why: one sentence justification
- Priority: High / Medium / Low

## Success Metrics
How will we know this worked? 2–4 measurable outcomes with timeframes.

Be specific. No vague recommendations. Every task must be something an agent can start immediately.`;
}

// ─────────────────────────────────────────────────────────────────────────
// 9. buildTaskGenerationPrompt
//    Structured prompt for generating the parseable task list from synthesis.
// ─────────────────────────────────────────────────────────────────────────
function buildTaskGenerationPrompt(ctx, synthesisContent) {
    const internal = isInternal(ctx);

    return `You are a task extraction engine for the LevelUp Growth platform.
Extract structured, actionable tasks from the meeting synthesis below.

${internal
    ? `This was an internal agent meeting initiated by ${ctx.requestingAgent || 'the system'}.`
    : `This was a user-facing strategy meeting.`}

SYNTHESIS:
${synthesisContent}

OUTPUT FORMAT — return a valid JSON array only, no other text:
[
  {
    "title": "Short task title (max 12 words)",
    "description": "What needs to be done and why (2-3 sentences)",
    "assignee": "agent_id (dmm|james|priya|marcus|elena|alex)",
    "coordinator": "agent_id of coordinating agent if applicable, else null",
    "priority": "high|medium|low",
    "estimated_time": "minutes as integer (e.g. 60, 120, 240)",
    "estimated_tokens": "LLM token estimate as integer (e.g. 3000, 8000)",
    "success_metric": "How to measure task completion"
  }
]

RULES:
- Generate 3–8 tasks. Do not pad with vague tasks.
- Each task must be specific enough that an agent can start it immediately.
- assignee must be one of: dmm, james, priya, marcus, elena, alex
- Return ONLY the JSON array. No preamble, no explanation, no markdown fences.`;
}

// ─────────────────────────────────────────────────────────────────────────
// 10. buildDeliberationPrompt
//     Hidden internal reasoning step before a specialist responds.
//     Never shown to users — used to improve response quality.
// ─────────────────────────────────────────────────────────────────────────
function buildDeliberationPrompt(agentId, messages, task, stateStr) {
    const agents = getAgents();
    const agent  = agents[agentId] || { name: agentId, title: 'Specialist' };
    const history = fmtHistory(messages, 10);

    return `You are ${agent.name}, ${agent.title || 'specialist'} at LevelUp Growth.
Before you respond publicly, complete an internal reasoning step.

This response is PRIVATE — it will not be shown to users or other agents.
Use it to think clearly before you commit to a position.

${stateStr || ''}

RECENT DISCUSSION:
${history}

YOUR TASK:
${task || 'Reason through your specialist perspective on the current topic.'}

THINK THROUGH:
1. POSITION: What is my clear position on this?
2. EVIDENCE: What specific data or expertise supports it?
3. GAPS: What am I uncertain about or missing?
4. CONTRARIAN CHECK: What would a well-reasoned objection to my position say?
5. ANGLE: What unique perspective can I add that hasn't been said yet?

Keep this under 150 words. Be honest — this is your private scratchpad.`;
}

// ─────────────────────────────────────────────────────────────────────────
// 11. buildVisionPrompt
//     Agent analyses an uploaded image from their specialist perspective.
// ─────────────────────────────────────────────────────────────────────────
function buildVisionPrompt(agentId, ctx, imageRef, caption) {
    const agents   = getAgents();
    const agent    = agents[agentId] || { name: agentId, title: 'Specialist' };
    const internal = isInternal(ctx);
    const ctxBlock = fmtCtx(ctx);

    return `You are ${agent.name}, ${agent.title || 'specialist'} at LevelUp Growth.
A file has been shared in the meeting for your expert analysis.

${internal ? INTERNAL_RAILS : USER_RAILS}

WORKSPACE CONTEXT:
${ctxBlock}

FILE REFERENCE: ${imageRef}
CAPTION/CONTEXT: ${caption || '(No caption provided.)'}

Analyse this asset from your specific domain of expertise.
Focus on what is relevant to your role — do not give a generic description.
Be specific: identify strengths, weaknesses, and a clear recommendation.
Keep your analysis under 150 words.
${HARD_RAILS}`;
}

// ─────────────────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────────────────

/**
 * parseManagerResponse
 * Parses Sarah's structured manager reply into { reply, specialists[], tasks{} }.
 * Handles both clean formatted output and partial/malformed responses gracefully.
 */
function parseManagerResponse(raw) {
    if (!raw) return { reply: '', specialists: [], tasks: {} };

    const text = raw.trim();

    // Extract SPECIALISTS line
    const specMatch = text.match(/SPECIALISTS:\s*([^\n]*)/i);
    const specialists = specMatch
        ? specMatch[1].split(',').map(s => s.trim().toLowerCase()).filter(s => s && s !== 'none' && s.length < 20)
        : [];

    // Extract TASKS JSON
    let tasks = {};
    const taskMatch = text.match(/TASKS:\s*(\{[\s\S]*?\})/i);
    if (taskMatch) {
        try { tasks = JSON.parse(taskMatch[1]); } catch (e) { tasks = {}; }
    }

    // Reply = everything before SPECIALISTS line
    const replyRaw = text.split(/SPECIALISTS:/i)[0].trim();

    // Strip the TASKS line if it leaked into the reply
    const reply = replyRaw.replace(/TASKS:[\s\S]*/i, '').trim();

    return { reply, specialists, tasks };
}

/**
 * parseTasksResponse
 * Parses the JSON array returned by buildTaskGenerationPrompt.
 * Returns [] on any parse failure — never throws.
 */
function parseTasksResponse(raw) {
    if (!raw) return [];
    try {
        // Strip markdown fences if present
        const clean = raw
            .replace(/^```(?:json)?/i, '')
            .replace(/```$/, '')
            .trim();
        const parsed = JSON.parse(clean);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // Try to extract a JSON array from a messy response
        const match = raw.match(/\[[\s\S]+\]/);
        if (match) {
            try { return JSON.parse(match[0]); } catch { return []; }
        }
        return [];
    }
}

/**
 * parseMentions
 * Parses @mentions from user input.
 * Returns { type: 'all'|'mention'|'none', agents: string[] }
 */
function parseMentions(content) {
    if (!content) return { type: 'none', agents: [] };

    const lower = content.toLowerCase();

    if (/@everyone\b/.test(lower) || /@all\b/.test(lower) || /@team\b/.test(lower)) {
        return { type: 'all', agents: [] };
    }

    const NAME_MAP = {
        '@sarah': 'dmm', '@dmm': 'dmm',
        '@james': 'james',
        '@priya': 'priya',
        '@marcus': 'marcus',
        '@elena': 'elena',
        '@alex': 'alex',
    };

    const agents = [];
    for (const [mention, id] of Object.entries(NAME_MAP)) {
        const re = new RegExp(mention.replace('@', '@') + '\\b', 'i');
        if (re.test(content) && !agents.includes(id)) agents.push(id);
    }

    return agents.length
        ? { type: 'mention', agents }
        : { type: 'none', agents: [] };
}

/**
 * isDuplicate
 * Returns true if content is too similar to recent messages in history.
 * Uses word-overlap ratio — fast, no external deps.
 */
function isDuplicate(content, messages, threshold = 0.90) {
    if (!content || !messages?.length) return false;
    const incoming = new Set(content.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    if (incoming.size < 5) return false; // too short to meaningfully compare

    const recent = messages.slice(-6);
    for (const msg of recent) {
        if (!msg.content || msg.role === 'user') continue;
        const existing = new Set(msg.content.toLowerCase().split(/\W+/).filter(w => w.length > 4));
        if (existing.size < 5) continue;

        let overlap = 0;
        for (const word of incoming) { if (existing.has(word)) overlap++; }
        const ratio = overlap / Math.min(incoming.size, existing.size);
        if (ratio >= threshold) return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────
module.exports = {
    // Prompt builders
    buildBriefingPrompt,
    buildDiscussionManagerPrompt,
    buildRefinementManagerPrompt,
    buildCheckinPrompt,
    buildSpecialistPrompt,
    buildUserTurnPrompt,
    buildDirectMessagePrompt,
    buildSynthesisPrompt,
    buildTaskGenerationPrompt,
    buildDeliberationPrompt,
    buildVisionPrompt,

    // Parsers
    parseManagerResponse,
    parseTasksResponse,
    parseMentions,
    isDuplicate,
    fmtHistory,
};
