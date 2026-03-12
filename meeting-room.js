'use strict';

/**
 * LevelUp Meeting Room — v5 (Collaborative Discussion Engine)
 *
 * Meeting phases per spec:
 *   starting → briefing → idea_round → discussion_round → refinement_round → open → synthesis → complete
 *
 * Rules:
 *   - Max 3 discussion rounds
 *   - Max 4 specialists per round
 *   - Manager dynamically selects specialists per round based on relevance
 *   - Specialists can reference and build on each other
 *   - Duplicate threshold 0.90, max 3 regeneration attempts
 *   - User can message at any point during 'open' phase
 *   - Wrap Up always available after idea_round completes
 */

require('dotenv').config();
const { createRedisConnection } = require('./redis');
const { callLLM }               = require('./llm');
const {
    AGENTS, TOKENS,
    buildBriefingPrompt,
    buildDiscussionManagerPrompt,
    buildRefinementManagerPrompt,
    buildUserTurnPrompt,
    buildSpecialistPrompt,
    buildSynthesisPrompt,
    parseDelegation,
    stripDelegation,
    isDuplicate,
} = require('./agents');

const redis = createRedisConnection();
const TTL   = 60 * 60 * 24;

// ── Redis ──────────────────────────────────────────────────────────────────

const rkey = id => `meeting:${id}`;

async function getMeeting(id) {
    try { const r = await redis.get(rkey(id)); return r ? JSON.parse(r) : null; }
    catch(e) { console.error('[MTG] get:', e.message); return null; }
}
async function saveMeeting(id, data) {
    try { await redis.set(rkey(id), JSON.stringify(data), 'EX', TTL); }
    catch(e) { console.error('[MTG] save:', e.message); }
}
async function addMsg(id, msg) {
    const m = await getMeeting(id);
    if (!m) return;
    m.messages.push({ ...msg, timestamp: new Date().toISOString() });
    m.updated_at = new Date().toISOString();
    await saveMeeting(id, m);
}
async function setState(id, status, extra = {}) {
    const m = await getMeeting(id);
    if (!m) return;
    Object.assign(m, { status, updated_at: new Date().toISOString(), ...extra });
    await saveMeeting(id, m);
}

// ── LLM wrappers ───────────────────────────────────────────────────────────

async function callManager(prompt, meetingId, tokens) {
    console.log(`[MTG:${meetingId}] Manager call`);
    try {
        const r = await Promise.race([
            callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:'Go ahead.'}], max_tokens: tokens || TOKENS.manager, temperature:0.75 }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 60000)),
        ]);
        return r.content || '';
    } catch(e) {
        console.error(`[MTG:${meetingId}] Manager error:`, e.message);
        return '';
    }
}

async function callSpecialist(agentId, prompt, meetingId, history) {
    const agent = AGENTS[agentId];
    console.log(`[MTG:${meetingId}] Specialist: ${agent.name}`);

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const userMsg = attempt === 1
                ? 'Your response:'
                : `Your previous response was too similar to something already said. Offer a genuinely different angle (attempt ${attempt}):`;

            const r = await Promise.race([
                callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:userMsg}], max_tokens:TOKENS.specialist, temperature: 0.65 + (attempt * 0.1) }),
                new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 60000)),
            ]);

            const content = r.content?.trim();
            if (!content) continue;

            if (isDuplicate(content, history)) {
                console.warn(`[MTG:${meetingId}] ${agent.name} duplicate (attempt ${attempt})`);
                if (attempt === 3) { console.warn(`[MTG:${meetingId}] ${agent.name} dropped after 3 attempts`); return null; }
                continue;
            }

            return content;

        } catch(e) {
            console.error(`[MTG:${meetingId}] ${agent.name} error:`, e.message);
            return null;
        }
    }
    return null;
}

async function postAgent(meetingId, agentId, content, role = 'message') {
    const a = AGENTS[agentId];
    await addMsg(meetingId, { agent_id:agentId, name:a.name, title:a.title, emoji:a.emoji, color:a.color, role, content });
}

async function postUser(meetingId, content) {
    await addMsg(meetingId, { agent_id:'user', name:'You', title:'', emoji:'👤', color:'#5d8aa8', role:'user', content });
}

// ── Run a specialist round ─────────────────────────────────────────────────
// specialists: array of agent IDs
// tasks: { agentId: "specific question" }

async function runSpecialistRound(meetingId, ctx, specialists, tasks) {
    for (const agentId of specialists) {
        const task = tasks[agentId] || `Give your perspective on the topic from your area of expertise.`;
        await setState(meetingId, `speaking_${agentId}`, { current_speaker: agentId });

        const m       = await getMeeting(meetingId);
        const prompt  = buildSpecialistPrompt(agentId, ctx, m.messages, task);
        const content = await callSpecialist(agentId, prompt, meetingId, m.messages);

        if (content) {
            await postAgent(meetingId, agentId, content, 'message');
            await sleep(350);
        }
    }
}

// ── Main meeting runner ────────────────────────────────────────────────────

async function startMeeting(meetingId, ctx) {
    const meeting = {
        id:         meetingId,
        topic:      ctx.topic,
        type:       ctx.type || 'brainstorm',
        context:    ctx,
        status:     'starting',
        phase:      'starting',
        messages:   [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    await saveMeeting(meetingId, meeting);

    runMeeting(meetingId, ctx).catch(err => {
        console.error(`[MTG:${meetingId}] Fatal:`, err.message);
        setState(meetingId, 'error', { error: err.message });
    });

    return meeting;
}

async function runMeeting(meetingId, ctx) {

    // ── PHASE 1: BRIEFING ─────────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'briefing', current_speaker:'dmm' });
    console.log(`[MTG:${meetingId}] Phase: briefing`);

    const briefingPrompt    = buildBriefingPrompt(ctx);
    const briefingRaw       = await callManager(briefingPrompt, meetingId);
    const briefingDelegation = parseDelegation(briefingRaw);
    const briefingReply      = stripDelegation(briefingRaw);

    if (briefingReply) await postAgent(meetingId, 'dmm', briefingReply, 'opening');
    await sleep(400);

    // ── PHASE 2: IDEA ROUND ────────────────────────────────────────────────
    await setState(meetingId, 'idea_round', { phase:'idea_round', current_speaker:null });
    console.log(`[MTG:${meetingId}] Phase: idea_round | specialists: ${briefingDelegation.specialists.join(',')}`);

    // Fallback if manager gave no delegation
    const ideaSpecialists = briefingDelegation.specialists.length > 0
        ? briefingDelegation.specialists
        : ['james', 'priya', 'elena'];

    await runSpecialistRound(meetingId, ctx, ideaSpecialists, briefingDelegation.tasks || {});

    // ── PHASE 3: DISCUSSION ROUND ──────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'discussion_round', current_speaker:'dmm' });
    console.log(`[MTG:${meetingId}] Phase: discussion_round`);

    const m2          = await getMeeting(meetingId);
    const discRaw     = await callManager(buildDiscussionManagerPrompt(ctx, m2.messages), meetingId);
    const discDeleg   = parseDelegation(discRaw);
    const discReply   = stripDelegation(discRaw);

    if (discReply) { await postAgent(meetingId, 'dmm', discReply, 'message'); await sleep(350); }

    if (discDeleg.specialists.length > 0) {
        await runSpecialistRound(meetingId, ctx, discDeleg.specialists, discDeleg.tasks || {});
    }

    // ── PHASE 4: REFINEMENT ROUND ──────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'refinement_round', current_speaker:'dmm' });
    console.log(`[MTG:${meetingId}] Phase: refinement_round`);

    const m3          = await getMeeting(meetingId);
    const refRaw      = await callManager(buildRefinementManagerPrompt(ctx, m3.messages), meetingId);
    const refDeleg    = parseDelegation(refRaw);
    const refReply    = stripDelegation(refRaw);

    if (refReply) { await postAgent(meetingId, 'dmm', refReply, 'message'); await sleep(350); }

    if (refDeleg.specialists.length > 0) {
        await runSpecialistRound(meetingId, ctx, refDeleg.specialists, refDeleg.tasks || {});
    }

    // ── OPEN: Invite user ──────────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { current_speaker:'dmm' });
    const m4 = await getMeeting(meetingId);

    // Sarah wraps the discussion round and invites user
    const checkinPrompt = `You are Sarah, Marketing Director at LevelUp Growth.

CONVERSATION SO FAR:
${m4.messages.slice(-6).map(m => `${m.name}: ${m.content}`).join('\n\n')}

The team has had a full discussion. In 2-3 sentences: summarise the strongest consensus that emerged, then ask the user one direct question about their priorities or constraints to help finalise the plan. Natural, direct.`;

    const checkinText = await callManager(checkinPrompt, meetingId, 300);
    if (checkinText) await postAgent(meetingId, 'dmm', checkinText, 'checkin');

    await setState(meetingId, 'open', { phase:'open', current_speaker:null });
    console.log(`[MTG:${meetingId}] Open for user input`);
}

// ── User message ───────────────────────────────────────────────────────────

async function userMessage(meetingId, content) {
    const m = await getMeeting(meetingId);
    if (!m)                       return { error: 'Meeting not found.' };
    if (m.status === 'complete')  return { error: 'Meeting is complete.' };
    if (m.status === 'synthesis') return { error: 'Sarah is writing the action plan, please wait a moment.' };

    await postUser(meetingId, content);

    handleUserTurn(meetingId, content, m.context).catch(err =>
        console.error(`[MTG:${meetingId}] User turn error:`, err.message)
    );

    return { accepted: true };
}

async function handleUserTurn(meetingId, content, ctx) {
    await setState(meetingId, 'speaking_dmm', { current_speaker:'dmm' });

    const m         = await getMeeting(meetingId);
    const raw       = await callManager(buildUserTurnPrompt(ctx, m.messages), meetingId);
    const deleg     = parseDelegation(raw);
    const reply     = stripDelegation(raw);

    if (reply) { await postAgent(meetingId, 'dmm', reply, 'message'); await sleep(350); }

    if (deleg.specialists.length > 0) {
        await runSpecialistRound(meetingId, ctx, deleg.specialists, deleg.tasks || {});
    }

    await setState(meetingId, 'open', { current_speaker:null });
}

// ── Wrap up ────────────────────────────────────────────────────────────────

async function wrapUpMeeting(meetingId) {
    const m = await getMeeting(meetingId);
    if (!m)                      return { error: 'Meeting not found.' };
    if (m.status === 'complete') return { error: 'Already complete.' };

    await setState(meetingId, 'synthesis', { current_speaker:'dmm' });

    const fresh  = await getMeeting(meetingId);
    const prompt = buildSynthesisPrompt(m.context, fresh.messages);

    try {
        const r = await Promise.race([
            callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:'Write the action plan now.'}], max_tokens:TOKENS.synthesis, temperature:0.5 }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 90000)),
        ]);
        await postAgent(meetingId, 'dmm', r.content, 'synthesis');
        await setState(meetingId, 'complete', { current_speaker:null, completed_at:new Date().toISOString() });
        return { success:true };
    } catch(e) {
        await setState(meetingId, 'open', { current_speaker:null });
        return { error: e.message };
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startMeeting, getMeeting, userMessage, wrapUpMeeting };
