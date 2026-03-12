'use strict';

require('dotenv').config();
const { createRedisConnection } = require('./redis');
const { callLLM }               = require('./llm');
const {
    AGENTS, TOKENS,
    buildBriefingPrompt, buildDiscussionManagerPrompt,
    buildRefinementManagerPrompt, buildUserTurnPrompt,
    buildCheckinPrompt, buildSpecialistPrompt, buildSynthesisPrompt,
    parseManagerResponse, isDuplicate,
} = require('./agents');

const redis = createRedisConnection();
const TTL   = 86400;
const rkey  = id => `meeting:${id}`;

// ── Redis ──────────────────────────────────────────────────────────────────

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

async function callManager(prompt, meetingId) {
    try {
        const r = await Promise.race([
            callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:'Respond now.'}], max_tokens:TOKENS.manager, temperature:0.7 }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')),60000)),
        ]);
        return parseManagerResponse(r.content);
    } catch(e) {
        console.error(`[MTG:${meetingId}] Manager error:`, e.message);
        return { reply:'', specialists:[], tasks:{} };
    }
}

async function callSpecialist(agentId, prompt, meetingId, history) {
    const agent = AGENTS[agentId];
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const userMsg = attempt === 1 ? 'Your response:' : `Attempt ${attempt}: your previous response was too similar to what was already said. Offer a genuinely different angle.`;
            const r = await Promise.race([
                callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:userMsg}], max_tokens:TOKENS.specialist, temperature:0.6+(attempt*0.1) }),
                new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')),60000)),
            ]);
            const content = r.content?.trim();
            if (!content) continue;
            if (isDuplicate(content, history)) {
                console.warn(`[MTG:${meetingId}] ${agent.name} duplicate attempt ${attempt}`);
                if (attempt === 3) return null;
                continue;
            }
            return content;
        } catch(e) {
            console.error(`[MTG:${meetingId}] ${agent.name}:`, e.message);
            return null;
        }
    }
    return null;
}

// ── Post helpers ───────────────────────────────────────────────────────────

async function postAgent(id, agentId, content, role='message') {
    if (!content?.trim()) return;
    const a = AGENTS[agentId];
    await addMsg(id, { agent_id:agentId, name:a.name, title:a.title, emoji:a.emoji, color:a.color, role, content:content.trim() });
}

// ── Run a specialist round ─────────────────────────────────────────────────

async function runRound(meetingId, ctx, specialists, tasks) {
    for (const agentId of specialists) {
        const task = tasks?.[agentId] || 'Give your expert perspective on this topic.';
        await setState(meetingId, `speaking_${agentId}`, { current_speaker:agentId });
        const m       = await getMeeting(meetingId);
        const prompt  = buildSpecialistPrompt(agentId, ctx, m.messages, task);
        const content = await callSpecialist(agentId, prompt, meetingId, m.messages);
        if (content) { await postAgent(meetingId, agentId, content); await sleep(300); }
    }
}

// ── Main meeting ───────────────────────────────────────────────────────────

async function startMeeting(meetingId, ctx) {
    await saveMeeting(meetingId, {
        id:meetingId, topic:ctx.topic, type:ctx.type||'brainstorm',
        context:ctx, status:'starting', phase:'starting',
        messages:[], current_speaker:null,
        created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
    });
    runMeeting(meetingId, ctx).catch(err => {
        console.error(`[MTG:${meetingId}] Fatal:`, err.message);
        setState(meetingId, 'error', { error:err.message });
    });
    return await getMeeting(meetingId);
}

async function runMeeting(meetingId, ctx) {

    // ── Briefing ──────────────────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'briefing', current_speaker:'dmm' });
    const briefing = await callManager(buildBriefingPrompt(ctx), meetingId);
    await postAgent(meetingId, 'dmm', briefing.reply, 'opening');
    await sleep(350);

    // ── Idea round ────────────────────────────────────────────────────────
    await setState(meetingId, 'idea_round', { phase:'idea_round', current_speaker:null });
    const ideaSpecialists = briefing.specialists.length ? briefing.specialists : ['james','priya','elena'];
    await runRound(meetingId, ctx, ideaSpecialists, briefing.tasks);

    // ── Discussion round ──────────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'discussion_round', current_speaker:'dmm' });
    const m2   = await getMeeting(meetingId);
    const disc = await callManager(buildDiscussionManagerPrompt(ctx, m2.messages), meetingId);
    await postAgent(meetingId, 'dmm', disc.reply);
    await sleep(300);
    if (disc.specialists.length) await runRound(meetingId, ctx, disc.specialists, disc.tasks);

    // ── Refinement round ──────────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { phase:'refinement_round', current_speaker:'dmm' });
    const m3  = await getMeeting(meetingId);
    const ref = await callManager(buildRefinementManagerPrompt(ctx, m3.messages), meetingId);
    await postAgent(meetingId, 'dmm', ref.reply);
    await sleep(300);
    if (ref.specialists.length) await runRound(meetingId, ctx, ref.specialists, ref.tasks);

    // ── Check-in — invite user ────────────────────────────────────────────
    await setState(meetingId, 'speaking_dmm', { current_speaker:'dmm' });
    const m4      = await getMeeting(meetingId);
    const checkin = await callManager(buildCheckinPrompt(m4.messages), meetingId);
    await postAgent(meetingId, 'dmm', checkin.reply, 'checkin');

    await setState(meetingId, 'open', { phase:'open', current_speaker:null });
    console.log(`[MTG:${meetingId}] Open`);
}

// ── User message ───────────────────────────────────────────────────────────

async function userMessage(meetingId, content) {
    const m = await getMeeting(meetingId);
    if (!m)                       return { error:'Meeting not found.' };
    if (m.status==='complete')    return { error:'Meeting is complete.' };
    if (m.status==='synthesis')   return { error:'Sarah is writing the action plan, please wait.' };

    await addMsg(meetingId, { agent_id:'user', name:'You', title:'', emoji:'👤', color:'#94A3B8', role:'user', content, timestamp:new Date().toISOString() });
    handleUserTurn(meetingId, content, m.context).catch(err => console.error(`[MTG:${meetingId}] User turn:`, err.message));
    return { accepted:true };
}

async function handleUserTurn(meetingId, content, ctx) {
    await setState(meetingId, 'speaking_dmm', { current_speaker:'dmm' });
    const m      = await getMeeting(meetingId);
    const res    = await callManager(buildUserTurnPrompt(ctx, m.messages), meetingId);
    await postAgent(meetingId, 'dmm', res.reply);
    await sleep(300);
    if (res.specialists.length) await runRound(meetingId, ctx, res.specialists, res.tasks);
    await setState(meetingId, 'open', { current_speaker:null });
}

// ── Wrap up ────────────────────────────────────────────────────────────────

async function wrapUpMeeting(meetingId) {
    const m = await getMeeting(meetingId);
    if (!m)                      return { error:'Meeting not found.' };
    if (m.status==='complete')   return { error:'Already complete.' };

    await setState(meetingId, 'synthesis', { current_speaker:'dmm' });
    const fresh = await getMeeting(meetingId);

    try {
        const r = await Promise.race([
            callLLM({ messages:[{role:'system',content:buildSynthesisPrompt(m.context, fresh.messages)},{role:'user',content:'Write the action plan.'}], max_tokens:TOKENS.synthesis, temperature:0.5 }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')),90000)),
        ]);
        await postAgent(meetingId, 'dmm', r.content, 'synthesis');
        await setState(meetingId, 'complete', { current_speaker:null, completed_at:new Date().toISOString() });
        return { success:true };
    } catch(e) {
        await setState(meetingId, 'open', { current_speaker:null });
        return { error:e.message };
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { startMeeting, getMeeting, userMessage, wrapUpMeeting };
