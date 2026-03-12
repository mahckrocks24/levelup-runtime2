'use strict';

/**
 * LevelUp Meeting Room — Sprint C v2 (Natural Conversation)
 *
 * Flow:
 *   1. Sarah opens (short, frames the problem)
 *   2. Each specialist responds once — short, reactive, conversational
 *   3. Sarah does a check-in and invites the user to speak
 *   4. Meeting stays OPEN — user can type at any time
 *   5. When user sends a message: Sarah + 1 relevant specialist respond
 *   6. User clicks "Wrap Up" → Sarah synthesises into action plan
 *
 * State stored in Redis. WordPress polls every 1.5s.
 * User messages injected via POST /internal/meeting/:id/message
 */

require('dotenv').config();
const { createRedisConnection } = require('./redis');
const { callLLM }               = require('./llm');
const {
    AGENTS,
    buildOpeningPrompt,
    buildConversationPrompt,
    buildCheckinPrompt,
    buildUserResponsePrompt,
    buildSynthesisPrompt,
} = require('./agents');

const redis       = createRedisConnection();
const TTL         = 60 * 60 * 24; // 24h
const AGENT_ORDER = ['james', 'priya', 'marcus', 'elena', 'alex'];

// ── Most relevant agent to respond to a user message ──────────────────────
// Very simple keyword routing — good enough for demo, easy to improve later
function pickResponder(userMessage, alreadySpoken) {
    const msg = userMessage.toLowerCase();
    const candidates = [
        { id:'james',  triggers:['seo','search','ranking','keyword','google','traffic','organic','technical','crawl'] },
        { id:'priya',  triggers:['content','blog','article','copy','brand','voice','write','writing','quality'] },
        { id:'marcus', triggers:['social','instagram','linkedin','tiktok','facebook','post','reel','carousel','platform'] },
        { id:'elena',  triggers:['lead','crm','email','nurture','funnel','conversion','pipeline','follow'] },
        { id:'alex',   triggers:['site speed','core web','schema','structured','technical','crawl','404','redirect'] },
    ];
    for (const c of candidates) {
        if (c.triggers.some(t => msg.includes(t))) return c.id;
    }
    return 'james'; // default fallback
}

// ── Redis helpers ──────────────────────────────────────────────────────────

const key = id => `meeting:${id}`;

async function getMeeting(id) {
    try {
        const raw = await redis.get(key(id));
        return raw ? JSON.parse(raw) : null;
    } catch(e) { console.error('[MEETING] get error:', e.message); return null; }
}

async function saveMeeting(id, data) {
    try {
        await redis.set(key(id), JSON.stringify(data), 'EX', TTL);
    } catch(e) { console.error('[MEETING] save error:', e.message); }
}

async function addMessage(id, msg) {
    const m = await getMeeting(id);
    if (!m) return;
    m.messages.push({ ...msg, timestamp: new Date().toISOString() });
    m.updated_at = new Date().toISOString();
    await saveMeeting(id, m);
    return m;
}

async function setStatus(id, status, extra = {}) {
    const m = await getMeeting(id);
    if (!m) return;
    Object.assign(m, { status, updated_at: new Date().toISOString(), ...extra });
    await saveMeeting(id, m);
}

// ── Agent speaks ───────────────────────────────────────────────────────────

async function agentSpeak(agentId, prompt, meetingId, role = 'message') {
    const agent = AGENTS[agentId];
    let content;

    try {
        const r = await Promise.race([
            callLLM({ messages:[{role:'system',content:prompt},{role:'user',content:'Go ahead.'}], max_tokens:300, temperature:0.8 }),
            new Promise((_,reject) => setTimeout(() => reject(new Error('timeout')), 55000)),
        ]);
        content = r.content || '…';
    } catch(e) {
        console.error(`[MEETING] ${agentId} error:`, e.message);
        content = 'Sorry, having a technical issue — carry on without me for now.';
    }

    const msg = {
        agent_id: agentId,
        name:     agent.name,
        title:    agent.title,
        emoji:    agent.emoji,
        color:    agent.color,
        role,
        content,
    };

    await addMessage(meetingId, msg);
    return content;
}

// ── Start meeting ──────────────────────────────────────────────────────────

async function startMeeting(meetingId, ctx) {
    const meeting = {
        id:          meetingId,
        topic:       ctx.topic,
        type:        ctx.type || 'brainstorm',
        context:     ctx,
        status:      'starting',
        messages:    [],
        phase:       'opening',       // opening → discussion → open → synthesis → complete
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
    };

    await saveMeeting(meetingId, meeting);

    // Run async — don't block the HTTP response
    runMeeting(meetingId, ctx).catch(err => {
        console.error(`[MEETING] Fatal error ${meetingId}:`, err.message);
        setStatus(meetingId, 'error', { error: err.message });
    });

    return meeting;
}

// ── Core meeting runner ────────────────────────────────────────────────────

async function runMeeting(meetingId, ctx) {
    // ── 1. Sarah opens ────────────────────────────────────────────────────
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });
    const openingPrompt = buildOpeningPrompt(ctx);
    await agentSpeak('dmm', openingPrompt, meetingId, 'opening');

    // ── 2. Each specialist responds ───────────────────────────────────────
    for (const agentId of AGENT_ORDER) {
        await setStatus(meetingId, `speaking_${agentId}`, { current_speaker: agentId });
        const m = await getMeeting(meetingId);
        const prompt = buildConversationPrompt(agentId, ctx, m.messages);
        await agentSpeak(agentId, prompt, meetingId, 'message');

        // Small natural pause between speakers
        await sleep(800);
    }

    // ── 3. Sarah check-in — invites user to speak ─────────────────────────
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });
    const m2 = await getMeeting(meetingId);
    const checkinPrompt = buildCheckinPrompt(ctx, m2.messages);
    await agentSpeak('dmm', checkinPrompt, meetingId, 'checkin');

    // ── 4. Open phase — waiting for user input ────────────────────────────
    await setStatus(meetingId, 'open', { current_speaker: null, phase: 'open' });
    console.log(`[MEETING] ${meetingId} — Open for user input`);
}

// ── User sends a message mid-meeting ─────────────────────────────────────

async function userMessage(meetingId, content) {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return { error: 'Meeting not found.' };
    if (meeting.status === 'complete') return { error: 'Meeting is already complete.' };
    if (meeting.status === 'synthesis') return { error: 'Sarah is wrapping up, please wait.' };

    // Add user message to transcript
    await addMessage(meetingId, {
        agent_id: 'user',
        name:     'You',
        title:    '',
        emoji:    '👤',
        color:    '#5d8aa8',
        role:     'user',
        content,
    });

    // Respond async
    respondToUser(meetingId, content, meeting.context).catch(err => {
        console.error(`[MEETING] User response error ${meetingId}:`, err.message);
    });

    return { accepted: true };
}

async function respondToUser(meetingId, userContent, ctx) {
    const m = await getMeeting(meetingId);

    // Sarah responds first
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });
    const sarahPrompt = buildUserResponsePrompt('dmm', ctx, m.messages, userContent);
    await agentSpeak('dmm', sarahPrompt, meetingId, 'message');

    await sleep(600);

    // Pick the most relevant specialist to also respond
    const m2         = await getMeeting(meetingId);
    const responderId = pickResponder(userContent, []);
    await setStatus(meetingId, `speaking_${responderId}`, { current_speaker: responderId });
    const specialistPrompt = buildUserResponsePrompt(responderId, ctx, m2.messages, userContent);
    await agentSpeak(responderId, specialistPrompt, meetingId, 'message');

    // Back to open
    await setStatus(meetingId, 'open', { current_speaker: null });
}

// ── Wrap up — triggered by user ───────────────────────────────────────────

async function wrapUpMeeting(meetingId) {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return { error: 'Meeting not found.' };
    if (meeting.status === 'complete') return { error: 'Already complete.' };

    await setStatus(meetingId, 'synthesis', { current_speaker: 'dmm' });

    const m       = await getMeeting(meetingId);
    const prompt  = buildSynthesisPrompt(meeting.context, m.messages);
    await agentSpeak('dmm', prompt, meetingId, 'synthesis');

    await setStatus(meetingId, 'complete', { current_speaker: null, completed_at: new Date().toISOString() });
    return { success: true };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startMeeting, getMeeting, userMessage, wrapUpMeeting };
