'use strict';

/**
 * LevelUp Agent Definitions — v6
 *
 * Critical fix: ALL manager responses return pure JSON.
 * Parsed server-side before anything is stored to Redis.
 * The UI never sees raw JSON.
 */

const AGENTS = {
    dmm:    { id:'dmm',    name:'Sarah',  title:'Digital Marketing Manager', emoji:'👩‍💼', color:'#6EE7B7' },
    james:  { id:'james',  name:'James',  title:'SEO Strategist',            emoji:'📊',  color:'#93C5FD' },
    priya:  { id:'priya',  name:'Priya',  title:'Content Manager',           emoji:'✍️',  color:'#C4B5FD' },
    marcus: { id:'marcus', name:'Marcus', title:'Social Media',              emoji:'📱',  color:'#FCD34D' },
    elena:  { id:'elena',  name:'Elena',  title:'CRM & Leads',               emoji:'🎯',  color:'#FCA5A5' },
    alex:   { id:'alex',   name:'Alex',   title:'Technical SEO',             emoji:'⚙️',  color:'#6EE7B7' },
};

const TOKENS = { manager:500, specialist:300, synthesis:1200 };

// ── Specialist personas ────────────────────────────────────────────────────

const SPECIALIST_PERSONAS = {
    james: `You are James, SEO Strategist. You focus on keyword strategy, search intent, organic traffic, topical authority. You are direct and data-driven. You may build on what others said from an SEO angle. Reference colleagues by name when you do.`,
    priya: `You are Priya, Content Manager. You focus on editorial strategy, content quality, brand voice, reader experience. You may build on SEO or social ideas by adding the content execution layer.`,
    marcus: `You are Marcus, Social Media Manager. You focus on platform strategy, content formats (reels, carousels, threads), distribution and amplification. You take others' ideas and show how they translate to social.`,
    elena: `You are Elena, CRM & Leads Specialist. You focus on lead capture, email nurture sequences, CRM segmentation, conversion funnels. You connect marketing activity to pipeline.`,
    alex: `You are Alex, Technical SEO Engineer. You are precise and brief. You flag technical implications others missed — crawlability, Core Web Vitals, schema, site architecture.`,
};

const RESPONSE_FORMAT = `
Write 2-4 sentences. Conversational English. No bullet points or headers.
Reference other agents by name when building on their ideas.
Be specific to this business. Never give generic marketing advice.`;

// ── Manager prompts — all return ONLY valid JSON ───────────────────────────

function buildBriefingPrompt(ctx) {
    return `You are Sarah, Marketing Director at LevelUp Growth. You lead a specialist team meeting.

BUSINESS: ${ctx.businessName || 'the client'} (${ctx.website || ''})
TOPIC: "${ctx.topic}"
GOALS: ${ctx.goals || 'not specified'}

Open this meeting as a Marketing Director. Interpret what the business actually needs, frame the challenge, then bring in 2-3 relevant specialists.

Return ONLY this JSON — no text before or after, no markdown:
{
  "reply": "Your opening message as Sarah. 2-3 sentences. Interpret the real challenge, frame it clearly, say you're bringing in the team.",
  "specialists": ["james", "priya"],
  "tasks": {
    "james": "Specific question for James to answer",
    "priya": "Specific question for Priya to answer"
  }
}

specialists must be chosen from: james, priya, marcus, elena, alex
Choose based on what's most relevant to the topic. 2-3 specialists max.`;
}

function buildDiscussionManagerPrompt(ctx, history) {
    return `You are Sarah, Marketing Director at LevelUp Growth.

BUSINESS: ${ctx.businessName || 'the client'} | TOPIC: "${ctx.topic}"

${fmtHistory(history)}

The idea round is done. Drive the discussion forward — acknowledge the strongest idea, surface a tension, and direct specialists to respond to each other.

Return ONLY this JSON:
{
  "reply": "Sarah's connecting comment. 2-3 sentences. Name the strongest idea, surface a tension or gap, direct the next conversation.",
  "specialists": ["priya", "marcus"],
  "tasks": {
    "priya": "Specific question building on James's point",
    "marcus": "Specific follow-up question"
  }
}

Only include specialists whose input adds something new. Can be 1-2 specialists or empty array.`;
}

function buildRefinementManagerPrompt(ctx, history) {
    return `You are Sarah, Marketing Director at LevelUp Growth.

BUSINESS: ${ctx.businessName || 'the client'} | TOPIC: "${ctx.topic}"

${fmtHistory(history)}

Identify the 1-2 strongest ideas from this discussion. Ask specialists to sharpen or pressure-test them.

Return ONLY this JSON:
{
  "reply": "Sarah's refinement prompt. 2 sentences. Name the best ideas and what needs sharpening.",
  "specialists": ["james"],
  "tasks": {
    "james": "Specific refinement question"
  }
}`;
}

function buildUserTurnPrompt(ctx, history) {
    return `You are Sarah, Marketing Director at LevelUp Growth.

BUSINESS: ${ctx.businessName || 'the client'} | TOPIC: "${ctx.topic}"

${fmtHistory(history)}

The user just sent a message. Respond directly and helpfully. If a specialist's expertise would add real value, include them.

Return ONLY this JSON:
{
  "reply": "Sarah's direct response to the user. 2-3 sentences. Address what they said specifically.",
  "specialists": [],
  "tasks": {}
}

If a specialist is needed, add them:
  "specialists": ["james"],
  "tasks": { "james": "Specific question" }

Maximum 2 specialists. If you can answer it yourself, specialists should be empty array.`;
}

function buildCheckinPrompt(history) {
    return `You are Sarah, Marketing Director at LevelUp Growth.

${fmtHistory(history)}

The team has completed the discussion rounds. Invite the user into the conversation.

Return ONLY this JSON:
{
  "reply": "2-3 sentences. Briefly name the strongest consensus from the discussion, then ask the user one direct specific question about their priorities or constraints.",
  "specialists": [],
  "tasks": {}
}`;
}

// ── Specialist prompt ──────────────────────────────────────────────────────

function buildSpecialistPrompt(agentId, ctx, history, task) {
    return `${SPECIALIST_PERSONAS[agentId]}

BUSINESS: ${ctx.businessName || 'the client'} (${ctx.website || ''})
TOPIC: "${ctx.topic}"

${fmtHistory(history)}

YOUR TASK: ${task}
${RESPONSE_FORMAT}`;
}

// ── Synthesis prompt ───────────────────────────────────────────────────────

function buildSynthesisPrompt(ctx, history) {
    return `You are Sarah, Marketing Director at LevelUp Growth.

BUSINESS: ${ctx.businessName || 'the client'} | TOPIC: "${ctx.topic}"
GOALS: ${ctx.goals || 'not specified'}

${fmtHistory(history)}

Write the final structured action plan from this meeting. Use this exact format:

**Campaign Objective**
One clear statement of what this campaign achieves and how success is measured.

**Content Strategy**
What content gets created, in what format, targeting which audience and keywords.

**Social Distribution**
Which platforms, which formats, posting cadence.

**Lead Capture Plan**
Landing pages, forms, lead magnets, CRM trigger.

**Email Follow-up Sequence**
Sequence structure, timing, segmentation.

**Prioritised Actions — Next 30 Days**
7-10 specific actions in priority order. Each names an owner and is specific enough to start tomorrow.

**Strategic Recommendation**
One clear call. No hedging. What to do first and why.

Draw only from this conversation. Be specific to this business.`;
}

// ── Parse manager JSON response ────────────────────────────────────────────

function parseManagerResponse(raw) {
    if (!raw) return { reply: '', specialists: [], tasks: {} };
    try {
        // Strip markdown code fences if present
        const clean = raw
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        // Find first { to last } to extract JSON even if there's surrounding text
        const start = clean.indexOf('{');
        const end   = clean.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON found');

        const parsed = JSON.parse(clean.slice(start, end + 1));

        const validAgents = ['james','priya','marcus','elena','alex'];
        return {
            reply:       (parsed.reply       || '').trim(),
            specialists: (parsed.specialists || []).filter(s => validAgents.includes(s)).slice(0, 4),
            tasks:       parsed.tasks        || {},
        };
    } catch(e) {
        console.warn('[AGENTS] JSON parse failed:', e.message, '| raw:', raw?.substring(0, 100));
        // Last resort: use the raw text as Sarah's reply with no delegation
        const cleaned = raw.replace(/\{[\s\S]*\}/g, '').trim();
        return { reply: cleaned || '', specialists: [], tasks: {} };
    }
}

// ── Duplicate detection — threshold 0.90 ──────────────────────────────────

function similarity(a, b) {
    if (!a || !b) return 0;
    const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    if (!wa.size || !wb.size) return 0;
    const inter = [...wa].filter(w => wb.has(w)).length;
    return inter / new Set([...wa, ...wb]).size;
}

function isDuplicate(content, history) {
    return history.filter(m => m.role !== 'user').some(m => similarity(content, m.content) > 0.90);
}

function fmtHistory(history) {
    if (!history?.length) return 'CONVERSATION: (meeting just started)';
    return 'CONVERSATION SO FAR:\n' + history.map(m => `${m.role === 'user' ? 'USER' : m.name}: ${m.content}`).join('\n\n');
}

module.exports = {
    AGENTS, TOKENS,
    SPECIALIST_PERSONAS,
    buildBriefingPrompt,
    buildDiscussionManagerPrompt,
    buildRefinementManagerPrompt,
    buildUserTurnPrompt,
    buildCheckinPrompt,
    buildSpecialistPrompt,
    buildSynthesisPrompt,
    parseManagerResponse,
    isDuplicate,
};
