'use strict';

require('dotenv').config();
const path = require('path');
const { createRedisConnection }    = require('./redis');
const { callLLM }                  = require('./llm');
const meetingStateLib              = require('./meeting-state');
const workspaceMemory              = require('./workspace-memory');
const { parseToolCall, executeTool, formatToolResult } = require('./tool-executor');
const {
    AGENTS, TOKENS,
    MAX_TURNS_PER_ROUND, MAX_AGENT_RESPONSES, DUPLICATE_THRESHOLD,
    buildBriefingPrompt, buildDiscussionManagerPrompt, buildRefinementManagerPrompt,
    buildUserTurnPrompt, buildCheckinPrompt, buildSpecialistPrompt,
    buildDirectMessagePrompt, buildSynthesisPrompt, buildTaskGenerationPrompt,
    buildDeliberationPrompt, buildVisionPrompt,
    parseManagerResponse, parseTasksResponse, parseMentions, isDuplicate, fmtHistory,
} = require('./agents');

const redis = createRedisConnection();
const TTL   = 86400 * 7;
const rkey  = id => `meeting:${id}`;
const tkey  = id => `meeting:${id}:pending_tasks`;

// ── Redis helpers ──────────────────────────────────────────────────────────
async function getMeeting(id) {
    try { const r = await redis.get(rkey(id)); return r ? JSON.parse(r) : null; } catch(e) { return null; }
}
async function saveMeeting(id, data) {
    try { await redis.set(rkey(id), JSON.stringify(data), 'EX', TTL); } catch(e) { console.error('[MTG] save:', e.message); }
}
async function addMsg(id, msg) {
    const m = await getMeeting(id); if (!m) return;
    m.messages.push({ ...msg, timestamp: new Date().toISOString() });
    m.updated_at = new Date().toISOString();
    await saveMeeting(id, m);
}
async function setState(id, status, extra = {}) {
    const m = await getMeeting(id); if (!m) return;
    Object.assign(m, { status, updated_at: new Date().toISOString(), ...extra });
    await saveMeeting(id, m);
}

// ── Acknowledgement lines per agent ──────────────────────────────────────
const ACKS = {
    james:  ["On it — pulling the keyword data now.", "Sure, give me a second.", "Let me check the numbers on that.", "One sec — running the search intent analysis.", "Got it, pulling that up."],
    priya:  ["On it — drafting that now.", "Sure, give me a moment.", "Let me think through the content structure.", "One sec — mapping that out.", "Got it."],
    marcus: ["On it — checking the platform data.", "Sure, one sec.", "Let me pull up the format breakdown.", "Give me a moment on that.", "Got it — looking at the numbers."],
    elena:  ["On it — mapping the funnel logic.", "Sure, one second.", "Let me pull the CRM framework for this.", "Give me a moment.", "Got it."],
    alex:   ["Checking the technical side now.", "One sec.", "Let me run through the architecture on that.", "Sure — pulling the audit data.", "On it."],
    dmm:    ["Got it.", "One second.", "On it."],
};

function getAck(agentId) {
    const list = ACKS[agentId] || ["On it."];
    return list[Math.floor(Math.random() * list.length)];
}

// ── LLM: Deliberation step ────────────────────────────────────────────────
async function runDeliberation(agentId, history, task, meetingState) {
    try {
        const stateStr = meetingStateLib.formatStateForPrompt(meetingState);
        const prompt   = buildDeliberationPrompt(agentId, history, task, stateStr);
        const r = await Promise.race([
            callLLM({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Complete your internal reasoning.' }], max_tokens: TOKENS.deliberation, temperature: 0.7 }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('deliberation timeout')), 30000)),
        ]);
        return r.content || '';
    } catch(e) {
        console.warn(`[DELIBERATION:${agentId}] skipped:`, e.message);
        return '';
    }
}

// ── LLM: Manager call (Sarah) ─────────────────────────────────────────────
async function callManager(prompt, mid) {
    const m = await getMeeting(mid);
    const sarahReplies = (m?.messages || [])
        .filter(x => x.agent_id === 'dmm')
        .slice(-3)
        .map(x => x.content);
    const repeatGuard = sarahReplies.length
        ? `\n\nANTI-REPEAT — your last ${sarahReplies.length} replies:\n${sarahReplies.map((r,i)=>`[${i+1}] "${r.slice(0,120)}"`).join('\n')}\nYour next reply MUST be meaningfully different. Never start with the same first 6 words. If you summarised before — now direct action.`
        : '';
    try {
        const r = await Promise.race([
            callLLM({ messages: [{ role: 'system', content: prompt + repeatGuard }, { role: 'user', content: 'Go.' }], max_tokens: TOKENS.manager, temperature: 0.75 }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('manager timeout')), 60000)),
        ]);
        return parseManagerResponse(r.content);
    } catch(e) {
        console.error(`[MTG:${mid}] Manager:`, e.message);
        return { reply: '', specialists: [], tasks: {} };
    }
}

// ── LLM: Specialist call (with deliberation + tool execution) ─────────────
async function callSpecialist(agentId, ctx, history, task, mid, meetingState, memory) {
    const m = await getMeeting(mid);
    const agentResponses = (m?.messages || []).filter(x => x.agent_id === agentId).length;

    // Loop safety
    if (agentResponses >= MAX_AGENT_RESPONSES) {
        console.warn(`[LOOP-SAFETY:${agentId}] max responses reached`);
        return null;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // Step 1 — hidden deliberation
            const deliberation = await runDeliberation(agentId, history, task, meetingState);

            // Step 2 — build specialist prompt with tool defs
            const stateStr = meetingStateLib.formatStateForPrompt(meetingState);
            const memStr   = workspaceMemory.formatMemoryForPrompt(memory);
            const prompt   = buildSpecialistPrompt(agentId, ctx, history, task, stateStr, memStr, deliberation);

            const uMsg = attempt === 1
                ? 'Give your expert response. If you need real data, use a tool.'
                : `Attempt ${attempt}: Your previous response was too similar to something already said. Give a genuinely NEW perspective — challenge an assumption, add new data, or take a different angle.`;

            // Step 3 — first LLM call (may return a tool_call)
            let r = await Promise.race([
                callLLM({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: uMsg }], max_tokens: TOKENS.specialist, temperature: 0.65 + (attempt * 0.1) }),
                new Promise((_,rej) => setTimeout(() => rej(new Error('specialist timeout')), 60000)),
            ]);

            let content = r.content?.trim();
            if (!content) continue;

            // Step 4 — tool call intercept (one tool per turn)
            const toolCheck = parseToolCall(content);
            if (toolCheck.hasToolCall) {
                console.log(`[MTG:${mid}] ${agentId} calling tool: ${toolCheck.tool}`);

                const toolResult = await executeTool(agentId, toolCheck.tool, toolCheck.params);
                const toolBlock  = formatToolResult(toolCheck.tool, toolResult.result, toolResult.success ? null : toolResult.error);

                // Step 5 — second LLM call with real tool data
                const followUp = await Promise.race([
                    callLLM({
                        messages: [
                            { role: 'system', content: prompt },
                            { role: 'user',   content: uMsg },
                            { role: 'assistant', content: content },
                            { role: 'user',   content: `${toolBlock}\n\nNow give your expert response using this real data. Be specific about the numbers.` },
                        ],
                        max_tokens: TOKENS.specialist,
                        temperature: 0.65,
                    }),
                    new Promise((_,rej) => setTimeout(() => rej(new Error('tool followup timeout')), 60000)),
                ]);

                content = followUp.content?.trim();
                if (!content) continue;
            }

            // Duplicate check
            if (isDuplicate(content, m?.messages || [])) {
                if (attempt === 3) return null;
                continue;
            }

            // Auto-update meeting state from response
            await autoUpdateState(mid, agentId, content, deliberation);

            return content;
        } catch(e) {
            console.error(`[MTG:${mid}] ${agentId} attempt ${attempt}:`, e.message);
            if (attempt === 3) return null;
        }
    }
    return null;
}

// ── Auto-extract insights from agent responses ────────────────────────────
async function autoUpdateState(mid, agentId, content, deliberation) {
    try {
        // Extract key insights (sentences with numbers or named frameworks)
        const insightMatch = content.match(/(?:key insight|importantly|specifically|data shows|research shows)[^.!?]*[.!?]/i);
        if (insightMatch) await meetingStateLib.addInsight(mid, insightMatch[0].trim(), agentId);

        // Extract questions directed at other agents
        const questionMatch = content.match(/([A-Z][a-z]+)\s*[—–-]\s*([^?]+\?)/g);
        if (questionMatch) {
            for (const q of questionMatch) await meetingStateLib.addQuestion(mid, q.trim());
        }

        // Extract strategies
        const stratMatch = content.match(/(?:I recommend|we should|strategy is|approach is|focus on)[^.!?]*[.!?]/i);
        if (stratMatch) await meetingStateLib.addStrategy(mid, stratMatch[0].trim(), agentId);

        // Capture agent position from deliberation
        if (deliberation) {
            const posMatch = deliberation.match(/POSITION\s*\n([^\n]+)/i);
            if (posMatch) await meetingStateLib.setAgentPosition(mid, agentId, posMatch[1].trim());
        }

        await meetingStateLib.incrementTurn(mid);
    } catch(e) {
        console.warn('[STATE-UPDATE] failed:', e.message);
    }
}

// ── Vision analysis ───────────────────────────────────────────────────────
async function analyzeImage(mid, fileInfo, caption, agentIds) {
    const m = await getMeeting(mid);
    if (!m) return;
    const ctx = m.context || {};

    for (const agentId of agentIds) {
        await setState(mid, `speaking_${agentId}`, { current_speaker: agentId });
        const memStr   = '';
        const stateStr = '';

        try {
            // Build vision prompt — for DeepSeek vision API
            const prompt = buildVisionPrompt(agentId, ctx, `[Image: ${fileInfo.name} — ${fileInfo.url}]`, caption);
            const messages = [
                { role: 'system', content: prompt },
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: fileInfo.url } },
                        { type: 'text', text: 'Analyse this marketing asset from your specialist perspective.' },
                    ],
                },
            ];

            const r = await Promise.race([
                callLLM({ messages, max_tokens: TOKENS.vision, temperature: 0.7, useVision: true }),
                new Promise((_,rej) => setTimeout(() => rej(new Error('vision timeout')), 60000)),
            ]);

            if (r.content?.trim()) {
                const a = AGENTS[agentId];
                await addMsg(mid, {
                    agent_id: agentId,
                    name: a.name, title: a.title, emoji: a.emoji, color: a.color,
                    role: 'vision_analysis',
                    content: r.content.trim(),
                    analyzed_file: fileInfo.name,
                });
                await sleep(300);
            }
        } catch(e) {
            console.error(`[VISION:${agentId}]`, e.message);
        }
    }
    await setState(mid, 'open', { current_speaker: null });
}

// ── Post helper ───────────────────────────────────────────────────────────
async function postAgent(id, agentId, content, role = 'message', extra = {}) {
    if (!content?.trim()) return;
    const a = AGENTS[agentId];
    await addMsg(id, { agent_id: agentId, name: a.name, title: a.title, emoji: a.emoji, color: a.color, role, content: content.trim(), ...extra });
}

async function markSpoken(mid, agentId) {
    const m = await getMeeting(mid); if (!m) return;
    if (!m.spokenAgents) m.spokenAgents = [];
    if (!m.spokenAgents.includes(agentId)) m.spokenAgents.push(agentId);
    await saveMeeting(mid, m);
}

// ── Round runner ──────────────────────────────────────────────────────────
async function runRound(mid, ctx, specialists, tasks) {
    const m = await getMeeting(mid);
    const meetingState = await meetingStateLib.getState(mid);
    const memory       = await workspaceMemory.getMemory(1);

    for (const agentId of specialists.slice(0, MAX_TURNS_PER_ROUND)) {
        const task  = tasks?.[agentId] || 'Give your expert perspective on what has been discussed so far.';
        await setState(mid, `speaking_${agentId}`, { current_speaker: agentId });
        const fresh = await getMeeting(mid);
        const content = await callSpecialist(agentId, ctx, fresh.messages, task, mid, meetingState, memory);
        if (content) { await postAgent(mid, agentId, content); await sleep(350); }
        await markSpoken(mid, agentId);
    }
}

// ── Start meeting ─────────────────────────────────────────────────────────
async function startMeeting(mid, ctx) {
    await saveMeeting(mid, {
        id: mid, topic: ctx.topic, type: ctx.type || 'brainstorm', context: ctx,
        status: 'starting', phase: 'starting',
        messages: [], spokenAgents: [], current_speaker: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await meetingStateLib.initState(mid);
    runMeeting(mid, ctx).catch(err => {
        console.error(`[MTG:${mid}] Fatal:`, err.message);
        setState(mid, 'error', { error: err.message });
    });
    return getMeeting(mid);
}

async function runMeeting(mid, ctx) {
    const memory = await workspaceMemory.getMemory(1);
    const memStr = workspaceMemory.formatMemoryForPrompt(memory);

    // Briefing
    await setState(mid, 'speaking_dmm', { phase: 'briefing', current_speaker: 'dmm' });
    const briefing = await callManager(buildBriefingPrompt(ctx, memStr), mid);
    await postAgent(mid, 'dmm', briefing.reply, 'opening');
    await markSpoken(mid, 'dmm');
    await sleep(350);

    // Idea round
    await setState(mid, 'idea_round', { phase: 'idea_round', current_speaker: null });
    const ideaSpec = briefing.specialists.length ? briefing.specialists : ['james', 'priya', 'elena'];
    await runRound(mid, ctx, ideaSpec, briefing.tasks);

    // Discussion round — Sarah drives debate
    await setState(mid, 'speaking_dmm', { phase: 'discussion_round', current_speaker: 'dmm' });
    const mtg2 = await getMeeting(mid);
    const state2 = await meetingStateLib.getState(mid);
    const disc = await callManager(buildDiscussionManagerPrompt(ctx, mtg2.messages, meetingStateLib.formatStateForPrompt(state2), memStr), mid);
    await postAgent(mid, 'dmm', disc.reply);
    await sleep(300);
    if (disc.specialists.length) await runRound(mid, ctx, disc.specialists, disc.tasks);

    // Refinement round — pressure-test
    await setState(mid, 'speaking_dmm', { phase: 'refinement_round', current_speaker: 'dmm' });
    const mtg3 = await getMeeting(mid);
    const state3 = await meetingStateLib.getState(mid);
    const ref = await callManager(buildRefinementManagerPrompt(ctx, mtg3.messages, meetingStateLib.formatStateForPrompt(state3)), mid);
    await postAgent(mid, 'dmm', ref.reply);
    await sleep(300);
    if (ref.specialists.length) await runRound(mid, ctx, ref.specialists, ref.tasks);

    // Check-in — invite user
    await setState(mid, 'speaking_dmm', { current_speaker: 'dmm' });
    const mtg4 = await getMeeting(mid);
    const state4 = await meetingStateLib.getState(mid);
    const checkin = await callManager(buildCheckinPrompt(mtg4.messages, meetingStateLib.formatStateForPrompt(state4)), mid);
    await postAgent(mid, 'dmm', checkin.reply, 'checkin');
    await setState(mid, 'open', { phase: 'open', current_speaker: null });
}

// ── User message ──────────────────────────────────────────────────────────
async function userMessage(mid, content, attachments = []) {
    const m = await getMeeting(mid);
    if (!m) return { error: 'Meeting not found.' };
    if (m.status === 'complete') return { error: 'Meeting is complete.' };
    if (m.status === 'synthesis') return { error: 'Sarah is writing the action plan, please wait.' };

    const mention = parseMentions(content);
    handleUserTurn(mid, content, m.context, mention, attachments)
        .catch(err => console.error(`[MTG:${mid}] UserTurn:`, err.message));
    return { accepted: true };
}

async function handleUserTurn(mid, content, ctx, mention, attachments = []) {
    const m = await getMeeting(mid);
    const spoken = m.spokenAgents || ['dmm'];
    const meetingState = await meetingStateLib.getState(mid);
    const memory       = await workspaceMemory.getMemory(1);
    const stateStr     = meetingStateLib.formatStateForPrompt(meetingState);
    const memStr       = workspaceMemory.formatMemoryForPrompt(memory);

    const histWithUser = [...m.messages, {
        role: 'user', name: 'You', content,
        attachments: attachments || [],
        timestamp: new Date().toISOString(),
    }];

    // Handle file attachments — trigger vision analysis
    if (attachments?.length) {
        const imageFiles = attachments.filter(a => ['image/png','image/jpeg','image/webp','image/gif'].includes(a.type));
        if (imageFiles.length) {
            for (const file of imageFiles) {
                await meetingStateLib.registerFile(mid, file);
                // Distribute to relevant agents for analysis
                const visionAgents = spoken.filter(id => id !== 'dmm').slice(0, 3);
                if (visionAgents.length) {
                    await analyzeImage(mid, file, content, visionAgents);
                    return;
                }
            }
        }
    }

    // @everyone — Sarah + all spoken agents
    if (mention.type === 'all') {
        await setState(mid, 'speaking_dmm', { current_speaker: 'dmm' });
        const sarahRes = await callManager(buildUserTurnPrompt(ctx, histWithUser, stateStr, memStr), mid);
        if (sarahRes.reply) { await postAgent(mid, 'dmm', sarahRes.reply); await sleep(300); }
        for (const agentId of spoken.filter(id => id !== 'dmm')) {
            await setState(mid, `speaking_${agentId}`, { current_speaker: agentId });
            const fresh = await getMeeting(mid);
            const resp  = await callSpecialist(agentId, ctx, [...histWithUser, ...fresh.messages.slice(histWithUser.length - 1)], content, mid, meetingState, memory);
            if (resp) { await postAgent(mid, agentId, resp); await sleep(300); }
        }
        await setState(mid, 'open', { current_speaker: null });
        return;
    }

    // @specific — bypass Sarah
    if (mention.type === 'mention') {
        for (const agentId of mention.agents) {
            await setState(mid, `speaking_${agentId}`, { current_speaker: agentId });
            await markSpoken(mid, agentId);
            const resp = await callSpecialist(agentId, ctx, histWithUser, content, mid, meetingState, memory);
            if (resp) { await postAgent(mid, agentId, resp, 'message', { direct_reply_to: 'user' }); await sleep(300); }
        }
        await setState(mid, 'open', { current_speaker: null });
        return;
    }

    // Normal — Sarah responds + may delegate
    await setState(mid, 'speaking_dmm', { current_speaker: 'dmm' });
    const sarahRes = await callManager(buildUserTurnPrompt(ctx, histWithUser, stateStr, memStr), mid);
    if (sarahRes.reply) { await postAgent(mid, 'dmm', sarahRes.reply); await sleep(300); }

    // Routing fix: if Sarah named an agent in her reply but forgot to add them to specialists, add them
    const namedInReply = extractNamedAgents(sarahRes.reply);
    const mergedSpecs = [...new Set([...sarahRes.specialists, ...namedInReply])];
    if (mergedSpecs.length) {
        await runRound(mid, ctx, mergedSpecs, sarahRes.tasks);
    }
    await setState(mid, 'open', { current_speaker: null });
}

// ── Direct message ────────────────────────────────────────────────────────
async function directMessage(mid, agentId, content) {
    const m = await getMeeting(mid);
    if (!m) return { error: 'Meeting not found.' };
    if (!AGENTS[agentId]) return { error: 'Invalid agent.' };
    handleDM(mid, agentId, content, m.context).catch(err => console.error(`[MTG:${mid}] DM:`, err.message));
    return { accepted: true };
}

async function handleDM(mid, agentId, content, ctx) {
    await setState(mid, `speaking_${agentId}`, { current_speaker: agentId });
    await markSpoken(mid, agentId);
    const m = await getMeeting(mid);
    const meetingState = await meetingStateLib.getState(mid);
    const stateStr = meetingStateLib.formatStateForPrompt(meetingState);
    const prompt   = buildDirectMessagePrompt(agentId, ctx, m.messages, content, stateStr);

    try {
        const r = await Promise.race([
            callLLM({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Direct message response:' }], max_tokens: TOKENS.specialist, temperature: 0.75 }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('dm timeout')), 60000)),
        ]);
        if (r.content?.trim()) {
            await postAgent(mid, agentId, r.content.trim(), 'dm', { dm_thread: true });
        }
    } catch(e) {
        console.error(`[DM:${agentId}]`, e.message);
    }
    await setState(mid, 'open', { current_speaker: null });
}

// ── Wrap up ───────────────────────────────────────────────────────────────
async function wrapUpMeeting(mid) {
    const m = await getMeeting(mid);
    if (!m) return { error: 'Meeting not found.' };
    if (m.status === 'complete') return { error: 'Already complete.' };

    await setState(mid, 'synthesis', { current_speaker: 'dmm' });
    const fresh      = await getMeeting(mid);
    const meetingState = await meetingStateLib.getState(mid);
    const memory       = await workspaceMemory.getMemory(1);
    const stateStr     = meetingStateLib.formatStateForPrompt(meetingState);
    const memStr       = workspaceMemory.formatMemoryForPrompt(memory);

    try {
        const r = await Promise.race([
            callLLM({
                messages: [
                    { role: 'system', content: buildSynthesisPrompt(m.context, fresh.messages, stateStr, memStr) },
                    { role: 'user', content: 'Write the final action plan.' },
                ],
                max_tokens: TOKENS.synthesis, temperature: 0.5,
            }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('synthesis timeout')), 90000)),
        ]);

        const synthesisContent = r.content;
        await postAgent(mid, 'dmm', synthesisContent, 'synthesis');
        await setState(mid, 'complete', { current_speaker: null, completed_at: new Date().toISOString() });

        // Update workspace memory
        await workspaceMemory.updateFromMeeting(1, {
            ...m.context,
            meeting_id: mid,
            validated_ideas: meetingState.validated_ideas,
        });

        // Generate pending tasks
        generatePendingTasks(mid, m.context, synthesisContent)
            .catch(err => console.error(`[MTG:${mid}] Tasks:`, err.message));

        return { success: true };
    } catch(e) {
        await setState(mid, 'open', { current_speaker: null });
        return { error: e.message };
    }
}

async function generatePendingTasks(mid, ctx, synthesisContent) {
    try {
        const r = await Promise.race([
            callLLM({
                messages: [
                    { role: 'system', content: buildTaskGenerationPrompt(ctx, synthesisContent) },
                    { role: 'user', content: 'Generate tasks.' },
                ],
                max_tokens: TOKENS.tasks, temperature: 0.4,
            }),
            new Promise((_,rej) => setTimeout(() => rej(new Error('tasks timeout')), 60000)),
        ]);

        const tasks = parseTasksResponse(r.content);
        if (!tasks.length) return;

        const pendingData = {
            meeting_id: mid,
            topic:      ctx.topic || '',
            business:   ctx.businessName || '',
            tasks: tasks.map((t, i) => ({
                id:              `task_${mid}_${i}`,
                title:           t.title || 'Untitled task',
                description:     t.description || '',
                assignee:        t.assignee || 'james',
                coordinator:     t.coordinator || null,
                priority:        t.priority || 'medium',
                estimated_time:  parseInt(t.estimated_time) || 60,
                estimated_tokens: parseInt(t.estimated_tokens) || 5000,
                success_metric:  t.success_metric || '',
                status:          'pending_approval',
                created_at:      new Date().toISOString(),
                meeting_id:      mid,
            })),
            created_at: new Date().toISOString(),
        };

        await redis.set(tkey(mid), JSON.stringify(pendingData), 'EX', 86400 * 3);
        console.log(`[MTG:${mid}] Generated ${tasks.length} tasks`);
    } catch(e) {
        console.error(`[MTG:${mid}] Task generation:`, e.message);
    }
}

// ── Pending tasks ─────────────────────────────────────────────────────────
async function getPendingTasks(mid) {
    try { const r = await redis.get(tkey(mid)); return r ? JSON.parse(r) : null; } catch(e) { return null; }
}
async function clearPendingTasks(mid) {
    try { await redis.del(tkey(mid)); } catch(e) {}
}

// ── Upload file to meeting ─────────────────────────────────────────────────
async function addFileToMeeting(mid, fileInfo) {
    await meetingStateLib.registerFile(mid, fileInfo);
    const m = await getMeeting(mid);
    if (!m) return;
    if (!m.files) m.files = [];
    m.files.push(fileInfo);
    await saveMeeting(mid, m);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scan Sarah's reply text for agent first names and return their IDs
function extractNamedAgents(text) {
    if (!text) return [];
    const nameMap = { james:'james', priya:'priya', marcus:'marcus', elena:'elena', alex:'alex' };
    const found = [];
    for (const [name, id] of Object.entries(nameMap)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(text) && !found.includes(id)) found.push(id);
    }
    return found;
}

module.exports = {
    startMeeting, getMeeting, userMessage, directMessage,
    wrapUpMeeting, getPendingTasks, clearPendingTasks,
    addFileToMeeting, analyzeImage,
};
