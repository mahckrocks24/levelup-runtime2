'use strict';

/**
 * LevelUp Runtime — Express Server
 * Sprint A: Receives task enqueue requests from WordPress,
 * pushes to BullMQ, and serves a health endpoint.
 *
 * FILE STRUCTURE NOTE:
 * All files live at repo root (not in src/ subfolder).
 * package.json start command: "node index.js"
 */

require('dotenv').config();

const express    = require('express');
const { Queue }  = require('bullmq');
const { createRedisConnection } = require('./redis');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Redis + BullMQ Queue ───────────────────────────────────────────────────
const redisConnection = createRedisConnection();
const taskQueue = new Queue('levelup-tasks', { connection: redisConnection });

// ── Middleware: validate shared secret ────────────────────────────────────
function requireSecret(req, res, next) {
    const incoming = req.headers['x-levelup-secret'];
    const expected = process.env.WP_SECRET;

    if (!expected) {
        console.error('[AUTH] WP_SECRET environment variable is not set.');
        return res.status(500).json({ error: 'Runtime misconfigured: WP_SECRET not set.' });
    }

    if (!incoming || incoming !== expected) {
        console.warn('[AUTH] Rejected request — invalid or missing secret.');
        return res.status(401).json({ error: 'Unauthorized. Invalid or missing X-LevelUp-Secret header.' });
    }

    next();
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Public health check. WordPress plugin calls this to confirm runtime is up.
 * Railway also uses this endpoint for healthchecks.
 */
app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        service: 'levelup-runtime',
        version: '0.1.0',
        sprint:  'A',
        time:    new Date().toISOString(),
    });
});

/**
 * GET /internal/health
 * Authenticated health check — confirms secret + Redis are working.
 */
app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        await redisConnection.ping();
        const queueCounts = await taskQueue.getJobCounts();
        res.json({
            status:      'ok',
            redis:       'connected',
            queue:       queueCounts,
            wp_callback: process.env.WP_CALLBACK_URL || 'NOT SET',
            time:        new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /internal/enqueue
 * Called by WordPress to queue a task for agent execution.
 */
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const body = req.body;

    const required = ['task_id', 'tool_name', 'workspace_id', 'agent_id', 'callback_url'];
    for (const field of required) {
        if (!body[field]) {
            return res.status(400).json({ error: `Missing required field: ${field}` });
        }
    }

    console.log(`[ENQUEUE] task_id=${body.task_id} tool=${body.tool_name} agent=${body.agent_id}`);

    try {
        const job = await taskQueue.add(
            'execute-tool',
            {
                task_id:         body.task_id,
                tool_name:       body.tool_name,
                workspace_id:    body.workspace_id,
                agent_id:        body.agent_id,
                payload:         body.payload || {},
                governance_tier: body.governance_tier ?? 0,
                callback_url:    body.callback_url,
                callback_secret: body.callback_secret,
                enqueued_at:     new Date().toISOString(),
            },
            {
                priority:         body.priority || 5,
                attempts:         3,
                backoff:          { type: 'exponential', delay: 2000 },
                removeOnComplete: { count: 100 },
                removeOnFail:     { count: 50  },
            }
        );

        console.log(`[ENQUEUE] BullMQ job created: job.id=${job.id}`);
        res.json({ accepted: true, task_id: body.task_id, job_id: job.id, queue: 'levelup-tasks' });

    } catch (err) {
        console.error('[ENQUEUE] Failed to push to BullMQ:', err.message);
        res.status(500).json({ error: 'Failed to enqueue task: ' + err.message });
    }
});

// ── 404 fallback ───────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] LevelUp Runtime listening on port ${PORT}`);
    console.log(`[SERVER] Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`[SERVER] WP Callback : ${process.env.WP_CALLBACK_URL || 'NOT SET'}`);
    console.log(`[SERVER] Redis       : ${process.env.REDIS_URL ? 'configured via REDIS_URL' : 'localhost:6379'}`);
});

// Start the worker in the same process
require('./worker');

module.exports = app;
