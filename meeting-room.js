'use strict';

/**
 * LevelUp Meeting Room — Sprint C
 *
 * Orchestrates a full multi-agent meeting:
 *   1. DMM opens the meeting
 *   2. Specialists respond sequentially (each sees all previous responses)
 *   3. DMM synthesises into an action plan
 *
 * Progress is written to Redis as each agent completes.
 * WordPress polls /internal/meeting/:id/status to get updates.
 *
 * Anti-runaway controls:
 *   - Max 12 total agent turns
 *   - 60s per agent timeout (LLM can be slow)
 *   - Meeting auto-closes at synthesis
 */

require('dotenv').config();
const { createRedisConnection }     = require('./redis');
const { callLLM }                   = require('./llm');
const { AGENTS, buildMeetingAgentPrompt, buildDMMOpeningPrompt, buildDMMSynthesisPrompt } = require('./agents');

const redis = createRedisConnection();

const MEETING_TTL     = 60 * 60 * 24; // 24 hours in Redis
const MAX_AGENT_TURNS = 12;
const AGENT_ORDER     = ['james', 'priya', 'marcus', 'elena', 'alex'];

// ── Meeting state helpers ──────────────────────────────────────────────────

function meetingKey(meetingId) { return `meeting:${meetingId}`; }

async function getMeeting(meetingId) {
    try {
        const raw = await redis.get(meetingKey(meetingId));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('[MEETING] Redis get error:', e.message);
        return null;
    }
}

async function saveMeeting(meetingId, data) {
    try {
        await redis.set(meetingKey(meetingId), JSON.stringify(data), 'EX', MEETING_TTL);
    } catch (e) {
        console.error('[MEETING] Redis save error:', e.message);
    }
}

async function appendResponse(meetingId, response) {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return;
    meeting.responses.push(response);
    meeting.updated_at = new Date().toISOString();
    await saveMeeting(meetingId, meeting);
}

async function setStatus(meetingId, status, extra = {}) {
    const meeting = await getMeeting(meetingId);
    if (!meeting) return;
    meeting.status = status;
    Object.assign(meeting, extra);
    meeting.updated_at = new Date().toISOString();
    await saveMeeting(meetingId, meeting);
}

// ── Start a new meeting ────────────────────────────────────────────────────

async function startMeeting(meetingId, meetingContext) {
    const meeting = {
        id:          meetingId,
        type:        meetingContext.type     || 'brainstorm',
        topic:       meetingContext.topic    || 'General strategy',
        context:     meetingContext,
        status:      'starting',
        responses:   [],
        action_plan: null,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
    };

    await saveMeeting(meetingId, meeting);
    console.log(`[MEETING] Started: ${meetingId} | type=${meeting.type} | topic="${meeting.topic}"`);

    // Run the meeting asynchronously (don't await — return immediately to caller)
    runMeeting(meetingId, meetingContext).catch(err => {
        console.error(`[MEETING] Fatal error in meeting ${meetingId}:`, err.message);
        setStatus(meetingId, 'error', { error: err.message });
    });

    return meeting;
}

// ── Core meeting orchestration ─────────────────────────────────────────────

async function runMeeting(meetingId, meetingContext) {
    console.log(`[MEETING] Running: ${meetingId}`);

    // ── Step 1: DMM Opening ───────────────────────────────────────────────
    await setStatus(meetingId, 'dmm_opening');
    console.log(`[MEETING] ${meetingId} — Sarah opening`);

    const openingPrompt = buildDMMOpeningPrompt(meetingContext);
    const openingResponse = await callAgentWithTimeout('dmm', openingPrompt, meetingId);

    await appendResponse(meetingId, {
        agent_id:  'dmm',
        name:      'Sarah',
        title:     'Digital Marketing Manager',
        emoji:     '👩‍💼',
        color:     '#27AE60',
        role:      'opening',
        content:   openingResponse,
        timestamp: new Date().toISOString(),
    });

    // ── Step 2: Specialists respond sequentially ──────────────────────────
    const previousResponses = [
        { name: 'Sarah', title: 'Digital Marketing Manager', content: openingResponse }
    ];

    for (const agentId of AGENT_ORDER) {
        const agent = AGENTS[agentId];
        await setStatus(meetingId, `agent_${agentId}`);
        console.log(`[MEETING] ${meetingId} — ${agent.name} responding`);

        const prompt   = buildMeetingAgentPrompt(agentId, meetingContext, previousResponses);
        const response = await callAgentWithTimeout(agentId, prompt, meetingId);

        const responseObj = {
            agent_id:  agentId,
            name:      agent.name,
            title:     agent.title,
            emoji:     agent.emoji,
            color:     agent.color,
            role:      'specialist',
            content:   response,
            timestamp: new Date().toISOString(),
        };

        await appendResponse(meetingId, responseObj);
        previousResponses.push({ name: agent.name, title: agent.title, content: response });

        // Anti-runaway: check total turns
        const meeting = await getMeeting(meetingId);
        if (meeting && meeting.responses.length >= MAX_AGENT_TURNS) {
            console.warn(`[MEETING] ${meetingId} — max turns reached, forcing synthesis`);
            break;
        }
    }

    // ── Step 3: DMM Synthesis ─────────────────────────────────────────────
    await setStatus(meetingId, 'dmm_synthesis');
    console.log(`[MEETING] ${meetingId} — Sarah synthesising`);

    const meeting         = await getMeeting(meetingId);
    const synthesisPrompt = buildDMMSynthesisPrompt(meetingContext, meeting.responses);
    const synthesis       = await callAgentWithTimeout('dmm', synthesisPrompt, meetingId);

    await appendResponse(meetingId, {
        agent_id:  'dmm',
        name:      'Sarah',
        title:     'Digital Marketing Manager',
        emoji:     '👩‍💼',
        color:     '#27AE60',
        role:      'synthesis',
        content:   synthesis,
        timestamp: new Date().toISOString(),
    });

    // ── Step 4: Mark complete ─────────────────────────────────────────────
    await setStatus(meetingId, 'complete', {
        completed_at: new Date().toISOString(),
    });

    console.log(`[MEETING] ${meetingId} — Complete ✓`);
}

// ── Call an agent with timeout ─────────────────────────────────────────────

async function callAgentWithTimeout(agentId, systemPrompt, meetingId, timeoutMs = 60000) {
    try {
        const result = await Promise.race([
            callLLM({
                messages: [
                    { role: 'system',  content: systemPrompt },
                    { role: 'user',    content: 'Please give your response now.' },
                ],
                max_tokens:  600,
                temperature: 0.75,
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Agent ${agentId} timed out after ${timeoutMs}ms`)), timeoutMs)
            ),
        ]);

        return result.content || `[${agentId} did not provide a response]`;

    } catch (err) {
        console.error(`[MEETING] Agent ${agentId} error:`, err.message);
        // Return a graceful fallback — don't crash the whole meeting
        return `I'm having a technical issue right now and couldn't contribute to this part of the meeting. Please continue without me — I'll be available for the next topic.`;
    }
}

module.exports = { startMeeting, getMeeting };
