/**
 * LevelUp Runtime — Phase 6 Bootstrap
 *
 * Drop these flat files into your existing Railway runtime repo root
 * (alongside index.js, agents.js, etc.), then wire in two lines:
 *
 *   In your index.js / server.js:
 *
 *     // 1. Start worker + crash recovery
 *     require('./lu-bootstrap');
 *
 *     // 2. Mount task queue routes
 *     const taskQueueRoutes = require('./lu-task-queue-routes');
 *     app.use('/internal/task', taskQueueRoutes);
 *
 * Required env vars (add to Railway):
 *   WP_URL             — https://staging1.shukranuae.com
 *   WORKER_CONCURRENCY — 3  (optional, default 3)
 *   SYNTHESIS_ENDPOINT — http://localhost:PORT/internal/agent/run  (optional)
 *
 * Already set on Railway (no action needed):
 *   REDIS_URL / LU_SECRET / WP_CALLBACK_URL
 */

'use strict';

// ── 1. Start the BullMQ worker ───────────────────────────────────────
require('./lu-task-worker');

// ── 2. Run crash recovery scan on startup + every 60s ────────────────
const { startRecovery } = require('./lu-recovery');
startRecovery().catch(e => console.error('[bootstrap] Recovery failed:', e.message));

console.log('[bootstrap] Phase 6 worker queue initialized');
