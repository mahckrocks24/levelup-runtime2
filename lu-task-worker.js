/**
 * LevelUp — Task Worker (Phase 7 — Intelligence Layer)
 *
 * Phase 6 foundation: BullMQ, lifecycle, retry, crash recovery.
 * Phase 7 additions:
 *   • Memory retrieval before execution
 *   • Workspace context injection
 *   • Reasoning trace (thoughts, plan, steps, tool outputs)
 *   • Collaboration messages on delegation
 *   • Task memory write on completion
 *   • Param refinement from dependency outputs
 */

'use strict';

const { Worker }                         = require('bullmq');
const { connection, QUEUE_NAME,
        LOCK_DURATION, STALL_INTERVAL }  = require('./lu-queue');
const { transition, recordToolEvent,
        incrementAttempts, setError,
        appendLog }                      = require('./lu-lifecycle');
const { executeTools,
        postResultCallback }             = require('./lu-tool-executor');
const { retrieveForTask,
        taskMemoryWrite,
        shortTermDelete }                = require('./lu-memory');
const { getWorkspaceContext,
        buildContextPrompt }             = require('./lu-context');
const { traceInit, traceUpdate,
        traceFinalize,
        traceAppendStep,
        traceAppendToolOutput }          = require('./lu-reasoning');
const { sendInternalMessage,
        recordHandoff,
        getCollaborationSummary }        = require('./lu-collaborator');
const { refineSingleTask }               = require('./lu-planner');

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

// ── Synthesis ────────────────────────────────────────────────────────
async function synthesize(job_data, tool_results, context, collab_summary) {
  const synthesisUrl = process.env.SYNTHESIS_ENDPOINT;
  if (!synthesisUrl) {
    return tool_results
      .map(r => `[${r.tool_id}] ${r.status === 'ok' ? JSON.stringify(r.data ?? '') : r.error}`)
      .join('\n\n');
  }
  try {
    const context_prompt = buildContextPrompt(context);
    const body = JSON.stringify({
      task_id:       job_data.task_id,
      agent_id:      job_data.agent_id,
      task_title:    job_data.title,
      tool_results,
      context_prompt,
      collab_summary: collab_summary || null,
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
  const {
    task_id, agent_id, tools = [], title,
    goal_id, callback_url, wp_url, wp_secret,
    params: base_params = {},
    dependency_task_ids = [],   // Phase 7: IDs of tasks this depends on
  } = job.data;

  console.log(`[worker] START task=${task_id} agent=${agent_id} attempt=${job.attemptsMade + 1}`);

  await incrementAttempts(task_id);
  await transition(task_id, 'running', { agent_id, title, goal_id });

  const t0 = Date.now();

  // ── Phase 7: Memory retrieval ─────────────────────────────────────
  const memory = await retrieveForTask({ task_id, agent_id, title, tools }).catch(() => ({}));

  // ── Phase 7: Workspace context ────────────────────────────────────
  const context = await getWorkspaceContext(wp_url, wp_secret).catch(() => ({}));

  // ── Phase 7: Reasoning trace init ────────────────────────────────
  await traceInit(task_id, { agent_id, title, context_used: context, memory_used: memory })
    .catch(() => {});

  // ── Phase 7: Agent "thoughts" — log reasoning before execution ───
  const agent_thoughts = [
    `I am ${agent_id}. Task: "${title}".`,
    tools.length ? `I will use: ${tools.join(', ')}.` : '',
    context.brand_voice ? `Brand voice: ${context.brand_voice}.` : '',
    memory.recent_tasks?.length
      ? `I recall ${memory.recent_tasks.length} relevant past tasks.` : '',
  ].filter(Boolean).join(' ');

  await traceUpdate(task_id, { agent_thoughts }).catch(() => {});
  await appendLog(task_id, {
    ts:    Math.floor(Date.now() / 1000),
    event: 'agent_thinking',
    thoughts: agent_thoughts,
  }).catch(() => {});

  // ── Phase 7: Param refinement from dependency outputs ────────────
  let params = { ...base_params };
  if (dependency_task_ids.length) {
    const dep_outputs = memory.recent_tasks
      .filter(t => dependency_task_ids.includes(t.task_id))
      .map(t => ({ agent_id: t.agent_id, output_summary: t.output_summary }));

    if (dep_outputs.length) {
      const refined = await refineSingleTask({
        task_id, title, agent: agent_id, tools, context, dependency_outputs: dep_outputs,
      }).catch(() => null);
      if (refined) {
        params = { ...params, ...refined };
        await traceUpdate(task_id, { refined_params: params }).catch(() => {});
        await sendInternalMessage({
          goal_id, task_id, from_agent: agent_id, to_agent: 'system',
          type: 'info',
          content: `Params refined from ${dep_outputs.length} dependency output(s).`,
        }).catch(() => {});
      }
    }
  }

  // Inject context into params so WP tool endpoints can use it
  const enriched_params = {
    ...params,
    _context: {
      business_name:   context.business_name   || '',
      brand_voice:     context.brand_voice      || '',
      target_audience: context.target_audience  || '',
      industry:        context.industry         || '',
    },
  };

  // Patch job data with enriched params for executeTools
  const enriched_job_data = { ...job.data, params: enriched_params };

  // ── Execute tools ─────────────────────────────────────────────────
  let completedTools = 0;
  const { results, all_ok } = await executeTools(
    tools,
    enriched_job_data,
    async (toolResult) => {
      completedTools += 1;
      await recordToolEvent(task_id, toolResult);
      await appendLog(task_id, {
        ts:    Math.floor(Date.now() / 1000),
        event: `tool:${toolResult.status}`,
        tool:  toolResult.tool_id,
        ms:    toolResult.duration_ms,
      });
      // Phase 7: append to reasoning trace
      await traceAppendToolOutput(task_id, toolResult).catch(() => {});
      await traceAppendStep(task_id, {
        step:    completedTools,
        tool:    toolResult.tool_id,
        status:  toolResult.status,
        summary: toolResult.status === 'ok'
          ? JSON.stringify(toolResult.data || '').slice(0, 200)
          : (toolResult.error || 'error'),
      }).catch(() => {});
      await job.updateProgress(Math.round((completedTools / Math.max(tools.length, 1)) * 100));
    }
  );

  const duration_ms   = Date.now() - t0;
  const final_status  = all_ok ? 'complete' : 'partial';

  // ── Phase 7: Collaboration summary for synthesis ──────────────────
  const collab_summary = await getCollaborationSummary(goal_id).catch(() => null);

  // ── Synthesize output ─────────────────────────────────────────────
  const output = await synthesize(job.data, results, context, collab_summary);

  // ── Transition to terminal state ──────────────────────────────────
  await transition(task_id, final_status, {
    duration_ms: duration_ms.toString(),
    tools_run:   tools.length.toString(),
    tools_ok:    results.filter(r => r.status === 'ok').length.toString(),
  });

  // ── Phase 7: Persist task memory ─────────────────────────────────
  await taskMemoryWrite(task_id, {
    goal_id, agent_id, title, tools,
    status:       final_status,
    output,
    tool_results: results,
    duration_ms,
  }).catch(() => {});

  // ── Phase 7: Finalize reasoning trace ─────────────────────────────
  await traceFinalize(task_id, {
    output_summary: typeof output === 'string' ? output.slice(0, 500) : '',
    duration_ms,
  }).catch(() => {});

  // ── Phase 7: Handoff message if goal has next task ────────────────
  if (goal_id && final_status === 'complete') {
    await recordHandoff({
      goal_id,
      from_task_id: task_id,
      to_task_id:   null,   // next task determined by planner
      from_agent:   agent_id,
      to_agent:     'next',
      output_summary: typeof output === 'string' ? output.slice(0, 200) : '',
    }).catch(() => {});
  }

  // ── Phase 7: Clean up short-term memory ──────────────────────────
  await shortTermDelete(task_id).catch(() => {});

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
const worker = new Worker(QUEUE_NAME, processJob, {
  connection,
  prefix:          'lu',
  concurrency:     CONCURRENCY,
  lockDuration:    LOCK_DURATION,
  stalledInterval: STALL_INTERVAL,
  maxStalledCount: 2,
});

worker.on('active',    (job) => console.log(`[worker] active job=${job.id}`));
worker.on('completed', (job, result) => console.log(`[worker] completed job=${job.id} status=${result?.status}`));

worker.on('failed', async (job, err) => {
  const { task_id, agent_id, callback_url, wp_secret } = job?.data ?? {};
  if (!task_id) return;

  const attemptsLeft = (job.opts?.attempts ?? 1) - (job.attemptsMade ?? 1);
  const isExhausted  = attemptsLeft <= 0;

  console.error(`[worker] FAILED job=${job.id} task=${task_id} attempts_left=${attemptsLeft} err=${err.message}`);
  await setError(task_id, err.message);

  if (isExhausted) {
    await transition(task_id, 'failed', { last_error: err.message });
    if (callback_url) {
      await postResultCallback({
        callback_url, wp_secret: wp_secret || '',
        task_id, agent_id,
        status: 'failed',
        output: `Task failed after ${job.attemptsMade} attempts: ${err.message}`,
        tool_results: [], duration_ms: 0,
      }).catch(() => {});
    }
  } else {
    try {
      await transition(task_id, 'retrying', {
        last_error: err.message,
        attempt_number: job.attemptsMade.toString(),
      });
    } catch (_) {}
  }
});

worker.on('stalled', (job_id) => console.warn(`[worker] STALLED job=${job_id}`));
worker.on('error',   (err)    => console.error('[worker] Worker error:', err.message));

async function shutdown() {
  console.log('[worker] Shutting down gracefully…');
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

module.exports = worker;
