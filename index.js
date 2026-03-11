'use strict';

require('dotenv').config();

const express    = require('express');
const { Queue }  = require('bullmq');
const { createRedisConnection } = require('./redis');
const { assembleSystemPrompt, getToolDefinitionsForLLM } = require('./prompt-assembler');
const { runAgentLoop }  = require('./llm');
const { getHistory, appendMessage, formatForLLM } = require('./conversation');
const registry          = require('./registry');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── Startup diagnostics ────────────────────────────────────────────────────
console.log('[STARTUP] LevelUp Runtime Sprint B booting…');
console.log('[STARTUP] Node          :', process.version);
console.log('[STARTUP] PORT          :', PORT);
console.log('[STARTUP] REDIS_URL     :', process.env.REDIS_URL         ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_SECRET     :', process.env.WP_SECRET         ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_CALLBACK   :', process.env.WP_CALLBACK_URL   ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] DEEPSEEK_KEY  :', process.env.DEEPSEEK_API_KEY  ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] Tools loaded  :', registry.list().map(t => t.name).join(', '));

// ── Queue (lazy) ───────────────────────────────────────────────────────────
let taskQueue = null;
function getQueue() {
    if (taskQueue) return taskQueue;
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not set.');
    const { Queue } = require('bullmq');
    taskQueue = new Queue('levelup-tasks', { connection: createRedisConnection() });
    return taskQueue;
}

// ── Auth middleware ────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    const incoming = req.headers['x-levelup-secret'];
    const expected = process.env.WP_SECRET;
    if (!expected) return res.status(500).json({ error: 'WP_SECRET not set.' });
    if (!incoming || incoming !== expected) return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        service: 'levelup-runtime',
        version: '0.2.0',
        sprint:  'B',
        time:    new Date().toISOString(),
        agents:  ['sarah-dmm', 'aria'],
        tools:   registry.list().map(t => t.name),
        config: {
            redis:    !!process.env.REDIS_URL,
            llm:      !!process.env.DEEPSEEK_API_KEY,
            wp:       !!process.env.WP_SECRET,
        },
    });
});

app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        const q      = getQueue();
        const counts = await q.getJobCounts();
        res.json({ status: 'ok', redis: 'connected', queue: counts, time: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ── Sprint A: Task queue endpoint ──────────────────────────────────────────
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const body     = req.body;
    const required = ['task_id', 'tool_name', 'workspace_id', 'agent_id', 'callback_url'];
    for (const field of required) {
        if (!body[field]) return res.status(400).json({ error: `Missing: ${field}` });
    }
    try {
        const q   = getQueue();
        const job = await q.add('execute-tool', {
            task_id:         body.task_id,
            tool_name:       body.tool_name,
            workspace_id:    body.workspace_id,
            agent_id:        body.agent_id,
            payload:         body.payload || {},
            governance_tier: body.governance_tier ?? 0,
            callback_url:    body.callback_url,
            callback_secret: body.callback_secret,
            enqueued_at:     new Date().toISOString(),
        }, {
            priority: body.priority || 5,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: { count: 100 },
            removeOnFail:     { count: 50 },
        });
        res.json({ accepted: true, task_id: body.task_id, job_id: job.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Sprint B: Agent chat endpoint ──────────────────────────────────────────
/**
 * POST /internal/chat
 * Direct synchronous agent conversation endpoint.
 * Used by the WordPress chat UI for real-time agent interaction.
 *
 * Body:
 * {
 *   conversation_id: string,   — session identifier
 *   workspace_id:    number,
 *   agent_id:        string,   — 'dmm' | 'aria'
 *   message:         string,   — user's message
 *   workspace_context: {       — optional business context
 *     businessName, industry, website, goals, brandVoice
 *   }
 * }
 */
app.post('/internal/chat', requireSecret, async (req, res) => {
    const {
        conversation_id,
        workspace_id = 1,
        agent_id     = 'dmm',
        message,
        workspace_context = {},
    } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'message is required.' });
    }
    if (!conversation_id) {
        return res.status(400).json({ error: 'conversation_id is required.' });
    }

    console.log(`[CHAT] agent=${agent_id} conv=${conversation_id} msg="${message.substring(0,80)}"`);

    try {
        // 1. Load conversation history from Redis
        const history = await getHistory(workspace_id, conversation_id);
        const llmHistory = formatForLLM(history, 20);

        // 2. Save user message to history
        await appendMessage(workspace_id, conversation_id, 'user', message);

        // 3. Assemble system prompt (5-layer stack)
        const availableToolNames = registry.list().map(t => t.name);
        const systemPrompt = assembleSystemPrompt(
            agent_id,
            workspace_context,
            { availableTools: availableToolNames }
        );

        // 4. Build messages for LLM
        const messages = [
            { role: 'system', content: systemPrompt },
            ...llmHistory,
            { role: 'user', content: message },
        ];

        // 5. Get tool definitions for LLM
        const allTools   = registry.list();
        const toolDefs   = getToolDefinitionsForLLM(
            allTools.map(t => ({
                name:        t.name,
                description: t.description,
                parameters:  registry.get(t.name)?.parameters,
            }))
        );

        // 6. Run agent reasoning loop (with tool use)
        const context = {
            task_id:      `chat_${conversation_id}_${Date.now()}`,
            agent_id,
            workspace_id,
        };

        const result = await runAgentLoop({
            messages,
            toolDefs,
            toolRegistry: registry,
            context,
            maxRounds: 5,
        });

        // 7. Save assistant response to history
        await appendMessage(workspace_id, conversation_id, 'assistant', result.content);

        console.log(`[CHAT] Response ready | tools_used=${result.tools_used.length} | rounds=${result.rounds}`);

        res.json({
            response:       result.content,
            agent_id,
            agent_name:     agent_id === 'dmm' ? 'Sarah' : 'Aria',
            tools_used:     result.tools_used,
            rounds:         result.rounds,
            conversation_id,
        });

    } catch (err) {
        console.error('[CHAT] Error:', err.message);
        res.status(500).json({
            error:   err.message,
            // Human-readable fallback so the UI doesn't show a blank error
            response: "I'm having a technical issue right now. Please try again in a moment.",
        });
    }
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// ── Start server then worker ───────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✓ Listening on 0.0.0.0:${PORT}`);
    if (!process.env.REDIS_URL)        console.warn('[SERVER] ⚠ REDIS_URL not set');
    if (!process.env.WP_SECRET)        console.warn('[SERVER] ⚠ WP_SECRET not set');
    if (!process.env.DEEPSEEK_API_KEY) console.warn('[SERVER] ⚠ DEEPSEEK_API_KEY not set — chat will not work');
    require('./worker');
});

module.exports = app;
