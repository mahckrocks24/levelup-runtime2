'use strict';

require('dotenv').config();

const express    = require('express');
const { Queue }  = require('bullmq');
const { createRedisConnection }   = require('./redis');
const { assembleSystemPrompt, getToolDefinitionsForLLM } = require('./prompt-assembler');
const { runAgentLoop }            = require('./llm');
const { getHistory, appendMessage, formatForLLM } = require('./conversation');
const { startMeeting, getMeeting } = require('./meeting-room');
const registry                    = require('./registry');
const { v4: uuidv4 }              = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── Startup ────────────────────────────────────────────────────────────────
console.log('[STARTUP] LevelUp Runtime Sprint C booting…');
console.log('[STARTUP] REDIS_URL     :', process.env.REDIS_URL         ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_SECRET     :', process.env.WP_SECRET         ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] DEEPSEEK_KEY  :', process.env.DEEPSEEK_API_KEY  ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] Tools         :', registry.list().map(t => t.name).join(', '));

// ── Queue ──────────────────────────────────────────────────────────────────
let taskQueue = null;
function getQueue() {
    if (taskQueue) return taskQueue;
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not set.');
    taskQueue = new Queue('levelup-tasks', { connection: createRedisConnection() });
    return taskQueue;
}

// ── Auth ───────────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    const incoming = req.headers['x-levelup-secret'];
    const expected = process.env.WP_SECRET;
    if (!expected) return res.status(500).json({ error: 'WP_SECRET not set.' });
    if (!incoming || incoming !== expected) return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok', service: 'levelup-runtime', version: '0.3.0', sprint: 'C',
        time: new Date().toISOString(),
        agents: ['sarah-dmm', 'aria', 'james', 'priya', 'marcus', 'elena', 'alex'],
        tools:  registry.list().map(t => t.name),
        config: {
            redis: !!process.env.REDIS_URL,
            llm:   !!process.env.DEEPSEEK_API_KEY,
            wp:    !!process.env.WP_SECRET,
        },
    });
});

app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        const q = getQueue();
        const counts = await q.getJobCounts();
        res.json({ status: 'ok', redis: 'connected', queue: counts });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── Sprint A: Enqueue ──────────────────────────────────────────────────────
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const body = req.body;
    const required = ['task_id', 'tool_name', 'workspace_id', 'agent_id', 'callback_url'];
    for (const field of required) {
        if (!body[field]) return res.status(400).json({ error: `Missing: ${field}` });
    }
    try {
        const q   = getQueue();
        const job = await q.add('execute-tool', {
            ...body, payload: body.payload || {},
            governance_tier: body.governance_tier ?? 0,
            enqueued_at: new Date().toISOString(),
        }, {
            priority: body.priority || 5, attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 }, removeOnFail: { count: 50 },
        });
        res.json({ accepted: true, task_id: body.task_id, job_id: job.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Sprint B: Chat ─────────────────────────────────────────────────────────
app.post('/internal/chat', requireSecret, async (req, res) => {
    const { conversation_id, workspace_id = 1, agent_id = 'dmm', message, workspace_context = {} } = req.body;
    if (!message?.trim())    return res.status(400).json({ error: 'message is required.' });
    if (!conversation_id)    return res.status(400).json({ error: 'conversation_id is required.' });

    console.log(`[CHAT] agent=${agent_id} conv=${conversation_id}`);

    try {
        const history   = await getHistory(workspace_id, conversation_id);
        const llmHistory = formatForLLM(history, 20);
        await appendMessage(workspace_id, conversation_id, 'user', message);

        const availableToolNames = registry.list().map(t => t.name);
        const systemPrompt = assembleSystemPrompt(agent_id, workspace_context, { availableTools: availableToolNames });

        const messages = [
            { role: 'system', content: systemPrompt },
            ...llmHistory,
            { role: 'user', content: message },
        ];

        const allTools = registry.list();
        const toolDefs = getToolDefinitionsForLLM(
            allTools.map(t => ({ name: t.name, description: t.description, parameters: registry.get(t.name)?.parameters }))
        );

        const context = { task_id: `chat_${conversation_id}_${Date.now()}`, agent_id, workspace_id };
        const result  = await runAgentLoop({ messages, toolDefs, toolRegistry: registry, context, maxRounds: 5 });

        await appendMessage(workspace_id, conversation_id, 'assistant', result.content);

        res.json({
            response:   result.content,
            agent_id,
            agent_name: agent_id === 'dmm' ? 'Sarah' : 'Aria',
            tools_used: result.tools_used,
            rounds:     result.rounds,
            conversation_id,
        });
    } catch (err) {
        console.error('[CHAT] Error:', err.message);
        res.status(500).json({ error: err.message, response: "I'm having a technical issue right now. Please try again." });
    }
});

// ── Sprint C: Meeting Room ─────────────────────────────────────────────────

/**
 * POST /internal/meeting/start
 * Starts a new multi-agent meeting asynchronously.
 * Returns meeting_id immediately — meeting runs in background.
 *
 * Body: {
 *   type:         'campaign_planning' | 'strategy_review' | 'brainstorm',
 *   topic:        string,
 *   businessName: string,
 *   website:      string,
 *   goals:        string,
 * }
 */
app.post('/internal/meeting/start', requireSecret, async (req, res) => {
    const body = req.body;
    if (!body.topic) return res.status(400).json({ error: 'topic is required.' });

    const meetingId = 'mtg_' + uuidv4().replace(/-/g, '').substring(0, 16);

    console.log(`[MEETING] Starting: ${meetingId} | topic="${body.topic}"`);

    try {
        const meeting = await startMeeting(meetingId, {
            type:         body.type         || 'brainstorm',
            topic:        body.topic,
            businessName: body.businessName || '',
            website:      body.website      || '',
            goals:        body.goals        || '',
            industry:     body.industry     || '',
        });

        res.json({
            meeting_id: meetingId,
            status:     'starting',
            topic:      body.topic,
            type:       meeting.type,
        });
    } catch (err) {
        console.error('[MEETING] Start error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /internal/meeting/:id/status
 * Polls meeting progress. Called every 2s by WordPress UI.
 * Returns current status + all responses received so far.
 */
app.get('/internal/meeting/:id/status', requireSecret, async (req, res) => {
    const meetingId = req.params.id;

    try {
        const meeting = await getMeeting(meetingId);

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found.', meeting_id: meetingId });
        }

        res.json({
            meeting_id:   meetingId,
            status:       meeting.status,
            type:         meeting.type,
            topic:        meeting.topic,
            responses:    meeting.responses || [],
            response_count: (meeting.responses || []).length,
            completed_at: meeting.completed_at || null,
            error:        meeting.error || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✓ LevelUp Runtime Sprint C on port ${PORT}`);
    if (!process.env.DEEPSEEK_API_KEY) console.warn('[SERVER] ⚠ DEEPSEEK_API_KEY not set');
    require('./worker');
});

module.exports = app;
