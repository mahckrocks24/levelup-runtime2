'use strict';

/**
 * LevelUp Meeting Room — Orchestration Rewrite
 *
 * Architecture: Manager-controlled delegation hierarchy.
 *
 * Every turn:
 *   1. Sarah (manager) runs first → returns JSON { reply, delegate_to, delegate_task }
 *   2. Sarah's reply is posted to the conversation
 *   3. If delegate_to is set → specialist gets called with isolated prompt + specific task
 *   4. Specialist reply is duplicate-checked before posting
 *   5. If duplicate → regenerate once with explicit instruction to differ
 *
 * Opening flow:
 *   1. Sarah opens with JSON decision
 *   2. First specialist responds
 *   3. Sarah calls second specialist
 *   4. Continue until all relevant specialists have spoken (Sarah decides when enough)
 *   5. Sarah invites user
 *
 * User input:
 *   Any time → goes to Sarah → Sarah decides reply + optional delegate
 *
 * Wrap up:
 *   User triggered → Sarah produces structured action plan
 */

require('dotenv').config();
const { createRedisConnection } = require('./redis');
const { callLLM }               = require('./llm');
const {
    AGENTS,
    SPECIALIST_PERSONAS,
    buildManagerPrompt,
    buildOpeningPrompt,
    buildSynthesisPrompt,
    isDuplicate,
} = require('./agents');

const redis = createRedisConnection();
const TTL   = 60 * 60 * 24; // 24h

// ── Redis helpers ──────────────────────────────────────────────────────────

const key = id => `meeting:${id}`;

async function getMeeting(id) {
    try {
        const raw = await redis.get(key(id));
        return raw ? JSON.parse(raw) : null;
    } catch(e) { console.error('[MTG] get error:', e.message); return null; }
}

async function saveMeeting(id, data) {
    try {
        await redis.set(key(id), JSON.stringify(data), 'EX', TTL);
    } catch(e) { console.error('[MTG] save error:', e.message); }
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

// ── LLM call helpers ───────────────────────────────────────────────────────

async function callManager(prompt, meetingId) {
    console.log(`[MTG:${meetingId}] Calling manager (Sarah)`);
    try {
        const r = await Promise.race([
            callLLM({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user',   content: 'Your turn.' },
                ],
                max_tokens:  200,
                temperature: 0.7,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 55000)),
        ]);

        // Parse JSON decision
        let decision;
        try {
            const clean = r.content.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            decision = JSON.parse(clean);
        } catch(e) {
            console.warn(`[MTG:${meetingId}] Manager JSON parse failed, using raw content`);
            decision = { reply: r.content.substring(0, 200), delegate_to: null, delegate_task: null };
        }

        // Validate
        const validAgents = ['james','priya','marcus','elena','alex'];
        if (decision.delegate_to && !validAgents.includes(decision.delegate_to)) {
            decision.delegate_to = null;
        }

        console.log(`[MTG:${meetingId}] Manager decision: delegate_to=${decision.delegate_to || 'none'}`);
        return decision;

    } catch(e) {
        console.error(`[MTG:${meetingId}] Manager error:`, e.message);
        return { reply: "Let me think through this with the team.", delegate_to: null, delegate_task: null };
    }
}

async function callSpecialist(agentId, ctx, history, task, meetingId) {
    const agent      = AGENTS[agentId];
    const promptFn   = SPECIALIST_PERSONAS[agentId];
    if (!promptFn) { console.warn(`[MTG:${meetingId}] No prompt for ${agentId}`); return null; }

    console.log(`[MTG:${meetingId}] Calling specialist: ${agent.name} | task: "${task}"`);

    await setStatus(meetingId, `speaking_${agentId}`, { current_speaker: agentId });

    const systemPrompt = promptFn(ctx, history, task);

    let content;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const r = await Promise.race([
                callLLM({
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user',   content: attempt === 1
                            ? 'Your response:'
                            : 'Your previous response was too similar to what someone else said. Give a different, more specific perspective:',
                        },
                    ],
                    max_tokens:  120,
                    temperature: attempt === 1 ? 0.7 : 0.9,
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 55000)),
            ]);

            content = r.content?.trim();

            // Duplicate check
            if (isDuplicate(content, history)) {
                console.warn(`[MTG:${meetingId}] ${agent.name} duplicate detected (attempt ${attempt})`);
                if (attempt === 2) {
                    console.warn(`[MTG:${meetingId}] Both attempts duplicated — skipping ${agent.name}`);
                    return null;
                }
                continue;
            }

            break; // Good response

        } catch(e) {
            console.error(`[MTG:${meetingId}] ${agent.name} error:`, e.message);
            return null;
        }
    }

    if (!content) return null;

    return {
        agent_id: agentId,
        name:     agent.name,
        title:    agent.title,
        emoji:    agent.emoji,
        color:    agent.color,
        content,
    };
}

// ── Post a message to the feed ─────────────────────────────────────────────

async function post(meetingId, agentId, content, role = 'message') {
    const agent = AGENTS[agentId];
    await addMessage(meetingId, {
        agent_id: agentId,
        name:     agent.name,
        title:    agent.title,
        emoji:    agent.emoji,
        color:    agent.color,
        role,
        content,
    });
}

// ── Start meeting ──────────────────────────────────────────────────────────

async function startMeeting(meetingId, ctx) {
    const meeting = {
        id:         meetingId,
        topic:      ctx.topic,
        type:       ctx.type || 'brainstorm',
        context:    ctx,
        status:     'starting',
        messages:   [],
        phase:      'opening',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    await saveMeeting(meetingId, meeting);

    runMeeting(meetingId, ctx).catch(err => {
        console.error(`[MTG:${meetingId}] Fatal:`, err.message);
        setStatus(meetingId, 'error', { error: err.message });
    });

    return meeting;
}

// ── Opening round — Sarah orchestrates initial specialist chain ────────────

async function runMeeting(meetingId, ctx) {
    // Sarah opens
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });

    const openingPrompt = buildOpeningPrompt(ctx);
    const decision      = await callManager(openingPrompt, meetingId);

    if (decision.reply) {
        await post(meetingId, 'dmm', decision.reply, 'opening');
    }

    await sleep(500);

    // Call up to 3 specialists in sequence — Sarah decides each time
    const calledSpecialists = new Set();
    let nextSpecialist      = decision.delegate_to;
    let nextTask            = decision.delegate_task;
    let rounds              = 0;

    while (nextSpecialist && !calledSpecialists.has(nextSpecialist) && rounds < 4) {
        rounds++;
        calledSpecialists.add(nextSpecialist);

        await setStatus(meetingId, `speaking_${nextSpecialist}`, { current_speaker: nextSpecialist });

        const m           = await getMeeting(meetingId);
        const specialistR = await callSpecialist(nextSpecialist, ctx, m.messages, nextTask, meetingId);

        if (specialistR) {
            await addMessage(meetingId, { ...specialistR, role: 'message', timestamp: new Date().toISOString() });
        }

        await sleep(400);

        // Sarah decides if another specialist is needed
        await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });
        const m2 = await getMeeting(meetingId);

        // Build a continuation prompt: Sarah reviews what's been said and decides next step
        const continuationPrompt = buildManagerContinuationPrompt(ctx, m2.messages, calledSpecialists);
        const next               = await callManager(continuationPrompt, meetingId);

        // Only post Sarah's reply if it's meaningful (not just "now let me ask X")
        if (next.reply && next.reply.trim().length > 10) {
            await post(meetingId, 'dmm', next.reply, 'message');
            await sleep(400);
        }

        nextSpecialist = next.delegate_to && !calledSpecialists.has(next.delegate_to) ? next.delegate_to : null;
        nextTask       = next.delegate_task;
    }

    // Sarah does a final check-in and invites the user
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });
    const mFinal    = await getMeeting(meetingId);
    const checkinFn = buildCheckinPrompt(ctx, mFinal.messages);
    const checkin   = await callManager(checkinFn, meetingId);

    if (checkin.reply) {
        await post(meetingId, 'dmm', checkin.reply, 'checkin');
    }

    await setStatus(meetingId, 'open', { current_speaker: null, phase: 'open' });
    console.log(`[MTG:${meetingId}] Opening round complete — open for user input`);
}

// ── Sarah's continuation decision after a specialist has spoken ────────────

function buildManagerContinuationPrompt(ctx, history, alreadyCalled) {
    const remaining = ['james','priya','marcus','elena','alex'].filter(a => !alreadyCalled.has(a));
    const remainingList = remaining.length > 0
        ? `Specialists not yet called: ${remaining.join(', ')}`
        : `All specialists have spoken.`;

    const lastFew = history.slice(-4).map(m => `${m.name}: ${m.content}`).join('\n');

    return `You are Sarah, Digital Marketing Manager at LevelUp Growth.

MEETING CONTEXT:
Topic: "${ctx.topic}"
Business: ${ctx.businessName || 'Not specified'}

RECENT CONVERSATION:
${lastFew}

${remainingList}

Decide your next move. You may:
- Add a brief connecting comment and call another specialist, or
- Add a brief comment and stop calling specialists (set delegate_to: null), or
- Just call another specialist without commenting

Return ONLY JSON:
{
  "reply": "Brief connecting comment from Sarah (1 sentence) OR empty string if you have nothing to add",
  "delegate_to": "agent_id" | null,
  "delegate_task": "Specific question for the specialist" | null
}

IMPORTANT: Only delegate if that specialist's unique expertise would genuinely add something new. Do not repeat what's already been covered.`;
}

// ── Check-in prompt ────────────────────────────────────────────────────────

function buildCheckinPrompt(ctx, history) {
    const lastFew = history.slice(-6).map(m => `${m.name}: ${m.content}`).join('\n');
    return `You are Sarah, Digital Marketing Manager at LevelUp Growth.

RECENT DISCUSSION:
${lastFew}

The team has covered the initial ground. Now invite the user into the conversation.
In one sentence: mention the most interesting tension or open question from the discussion above, then ask the user one direct question about their specific situation.

Return ONLY JSON:
{
  "reply": "One sentence check-in that invites the user to respond.",
  "delegate_to": null,
  "delegate_task": null
}`;
}

// ── User message handler ───────────────────────────────────────────────────

async function userMessage(meetingId, content) {
    const meeting = await getMeeting(meetingId);
    if (!meeting)                      return { error: 'Meeting not found.' };
    if (meeting.status === 'complete') return { error: 'Meeting is complete.' };
    if (meeting.status === 'synthesis') return { error: 'Sarah is writing the action plan, please wait.' };

    // Post user message
    await addMessage(meetingId, {
        agent_id:  'user',
        name:      'You',
        title:     '',
        emoji:     '👤',
        color:     '#5d8aa8',
        role:      'user',
        content,
        timestamp: new Date().toISOString(),
    });

    respondToUser(meetingId, content, meeting.context).catch(err => {
        console.error(`[MTG:${meetingId}] User response error:`, err.message);
    });

    return { accepted: true };
}

async function respondToUser(meetingId, userContent, ctx) {
    // Sarah always responds first
    await setStatus(meetingId, 'speaking_dmm', { current_speaker: 'dmm' });

    const m          = await getMeeting(meetingId);
    const prompt     = buildManagerPrompt(ctx, m.messages);
    const decision   = await callManager(prompt, meetingId);

    if (decision.reply) {
        await post(meetingId, 'dmm', decision.reply, 'message');
    }

    // Call specialist if Sarah decided to delegate
    if (decision.delegate_to && decision.delegate_task) {
        await sleep(400);
        await setStatus(meetingId, `speaking_${decision.delegate_to}`, { current_speaker: decision.delegate_to });

        const m2          = await getMeeting(meetingId);
        const specialistR = await callSpecialist(decision.delegate_to, ctx, m2.messages, decision.delegate_task, meetingId);

        if (specialistR) {
            await addMessage(meetingId, { ...specialistR, role: 'message', timestamp: new Date().toISOString() });
        }
    }

    await setStatus(meetingId, 'open', { current_speaker: null });
}

// ── Wrap up ────────────────────────────────────────────────────────────────

async function wrapUpMeeting(meetingId) {
    const meeting = await getMeeting(meetingId);
    if (!meeting)                      return { error: 'Meeting not found.' };
    if (meeting.status === 'complete') return { error: 'Already complete.' };

    await setStatus(meetingId, 'synthesis', { current_speaker: 'dmm' });

    const m           = await getMeeting(meetingId);
    const prompt      = buildSynthesisPrompt(meeting.context, m.messages);

    console.log(`[MTG:${meetingId}] Sarah synthesising…`);

    try {
        const r = await callLLM({
            messages: [
                { role: 'system', content: prompt },
                { role: 'user',   content: 'Write the action plan now.' },
            ],
            max_tokens:  800,
            temperature: 0.5,
        });

        await post(meetingId, 'dmm', r.content, 'synthesis');
        await setStatus(meetingId, 'complete', { current_speaker: null, completed_at: new Date().toISOString() });
        return { success: true };

    } catch(e) {
        console.error(`[MTG:${meetingId}] Synthesis error:`, e.message);
        await setStatus(meetingId, 'open', { current_speaker: null });
        return { error: e.message };
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startMeeting, getMeeting, userMessage, wrapUpMeeting };
