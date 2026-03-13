/**
 * LevelUp — Task Worker
 *
 * BullMQ Worker that processes agent-task jobs from the lu-tasks queue.
 *
 * Guarantees:
 *   • Each job is processed at-least-once (lock + stall recovery)
 *   • Capability is NOT re-checked (PHP checked before enqueue)
 *   • Every state transition is atomic in Redis via lifecycle.js
 *   • Worker crash → BullMQ stall detection → requeues after LOCK_DURATION
 *   • Retry → exponential backoff (8s, 16s, 32s, 64s)
 *   • All retries exhausted → job moves to failed state → DLQ entry
 *   • WP callback is best-effort — Redis is the canonical state store
 *
 * Concurrency: 3 parallel jobs (safe for Railway + DeepSeek rate limits)
 */

'use strict';

const { Worker } = require('bullmq');
const { connection, QUEUE_NAME, LOCK_DURATION, STALL_INTERVAL } = require('./lu-queue');
const { transition, recordToolEvent, incrementAttempts, setError, appendLog } = require('./lu-lifecycle');
const { executeTools, postResultCallback } = require('./lu-tool-executor');

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

// ── Synthesis helper (calls DeepSeek via runtime internal endpoint) ──
async function synthesize(job_data, tool_results) {
  // If no synthesis endpoint configured, fall back to plain text join
  const synthesisUrl = process.env.SYNTHESIS_ENDPOINT;
  if (!synthesisUrl) {
    return tool_results
      .map(r => `[${r.tool_id}] ${r.status === 'ok' ? JSON.stringify(r.data ?? '') : r.error}`)
      .join('\n\n');
  }
  try {
    const { executeTools: _, postResultCallback: __, ...http } = require('./lu-tool-executor');
    // Reuse httpPost pattern via dynamic require
    const body = JSON.stringify({
      task_id:    job_data.task_id,
      agent_id:   job_data.agent_id,
      task_title: job_data.title,
      tool_results,
    });
    const res = await fetch(synthesisUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-LU-Secret': process.env.LU_SECRET || '' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const d = await res.json();
    return d.output || tool_results.map(r => `[${r.tool_id}] ${JSON.stringify(r.data ?? '')}`).join('\n\n');
  } catch (e) {
    console.error('[worker] synthesis failed, using plain join:', e.message);
    return tool_results.map(r => `[${r.tool_id}] ${JSON.stringify(r.data ?? '')}`).join('\n\n');
  }
}

// ── Job processor ────────────────────────────────────────────────────

async function processJob(job) {
  const { task_id, agent_id, tools = [], title, goal_id, callback_url, wp_url, wp_secret } = job.data;

  console.log(`[worker] START task=${task_id} agent=${agent_id} attempt=${job.attemptsMade + 1}`);

  await incrementAttempts(task_id);
  await transition(task_id, 'running', { agent_id, title, goal_id });

  const t0 = Date.now();

  // ── Execute tools ─────────────────────────────────────────────────
  // completedTools is a safe local counter — avoids referencing `results`
  // before executeTools() resolves (which caused the original progress bug).
  let completedTools = 0;

  const { results, all_ok } = await executeTools(
    tools,
    job.data,
    async (toolResult) => {
      completedTools += 1;
      // Live progress: record each tool result to Redis immediately
      await recordToolEvent(task_id, toolResult);
      await appendLog(task_id, {
        ts:    Math.floor(Date.now() / 1000),
        event: `tool:${toolResult.status}`,
        tool:  toolResult.tool_id,
        ms:    toolResult.duration_ms,
      });
      // BullMQ job progress (0–100 based on tools completed)
      await job.updateProgress(Math.round((completedTools / Math.max(tools.length, 1)) * 100));
    }
  );

  const duration_ms = Date.now() - t0;
  const final_status = all_ok ? 'complete' : 'partial';

  // ── Synthesize output ─────────────────────────────────────────────
  const output = await synthesize(job.data, results);

  // ── Transition to terminal state ──────────────────────────────────
  await transition(task_id, final_status, {
    duration_ms: duration_ms.toString(),
    tools_run:   tools.length.toString(),
    tools_ok:    results.filter(r => r.status === 'ok').length.toString(),
  });

  // ── Callback to WordPress (best-effort) ──────────────────────────
  if (callback_url) {
    await postResultCallback({
      callback_url, wp_secret,
      task_id, agent_id,
      status: final_status,
      output,
      tool_results: results,
      duration_ms,
    });
  }

  console.log(`[worker] DONE  task=${task_id} status=${final_status} ms=${duration_ms}`);

  return { task_id, status: final_status, duration_ms, tools_run: tools.length };
}

// ── Worker instance ──────────────────────────────────────────────────

const worker = new Worker(
  QUEUE_NAME,
  processJob,
  {
    connection,
    prefix:          'lu',
    concurrency:     CONCURRENCY,
    lockDuration:    LOCK_DURATION,
    stalledInterval: STALL_INTERVAL,
    maxStalledCount: 2,               // After 2 stalls, mark as failed
  }
);

// ── Event handlers ───────────────────────────────────────────────────

worker.on('active', (job) => {
  console.log(`[worker] active job=${job.id}`);
});

worker.on('completed', (job, result) => {
  console.log(`[worker] completed job=${job.id} status=${result?.status}`);
});

worker.on('failed', async (job, err) => {
  const { task_id, agent_id, callback_url, wp_secret } = job?.data ?? {};
  if (!task_id) return;

  const attemptsLeft = (job.opts?.attempts ?? 1) - (job.attemptsMade ?? 1);
  const isExhausted  = attemptsLeft <= 0;

  console.error(`[worker] FAILED job=${job.id} task=${task_id} attempts_left=${attemptsLeft} err=${err.message}`);

  await setError(task_id, err.message);

  if (isExhausted) {
    // All retries exhausted — terminal failure
    await transition(task_id, 'failed', { last_error: err.message });

    // NOTE: Dead-letter visibility uses main queue failed jobs (taskQueue.getFailed).
    // Do NOT write to a separate deadQueue — that was the split-brain bug.
    // BullMQ already retains failed jobs per removeOnFail config in queue/index.js.

    // Notify WP about the failure (best-effort)
    if (callback_url) {
      await postResultCallback({
        callback_url, wp_secret: wp_secret || '',
        task_id, agent_id,
        status: 'failed',
        output: `Task failed after ${job.attemptsMade} attempts: ${err.message}`,
        tool_results: [],
        duration_ms: 0,
      }).catch(() => {});
    }
  } else {
    // Will be retried — mark as retrying
    try {
      await transition(task_id, 'retrying', {
        last_error:    err.message,
        attempt_number: job.attemptsMade.toString(),
      });
    } catch (_) {
      // Transition may fail if state is already terminal — ignore
    }
  }
});

worker.on('stalled', (job_id) => {
  console.warn(`[worker] STALLED job=${job_id} — BullMQ will requeue`);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err.message);
});

// ── Graceful shutdown ────────────────────────────────────────────────

async function shutdown() {
  console.log('[worker] Shutting down gracefully…');
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

module.exports = worker;
