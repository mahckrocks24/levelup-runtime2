'use strict';

/**
 * LevelUp Tool Executor — Phase 1 Rebuild
 *
 * Central execution engine for all agent tool calls.
 * Agents NEVER call WP REST directly — all calls route through here.
 *
 * Execution flow:
 *   Agent LLM response → parseToolCall() → executeTool()
 *     → capability check (capability-map.js)
 *     → governance check (requires_approval?)
 *       → if approval needed: store pending action in Redis, return pending state
 *       → if no approval needed: dispatch to WP via lu/v1/tools/execute proxy
 *     → return structured result to agent
 *
 * Why lu/v1/tools/execute proxy?
 *   SEO Suite endpoints (lugs/v1/*) require a WP logged-in user.
 *   The runtime cannot provide a WP nonce. The WP proxy receives the tool call,
 *   dispatches internally via WP_REST_Request (no HTTP, no auth issue), and returns
 *   the result. This is the only correct pattern for Node → lugs/v1/* calls.
 */

const { getTool }       = require('./tool-registry');
const { hasCapability } = require('./capability-map');

// nanoid v3 compat (CJS)
let _nanoid;
function nanoid(size = 10) {
    if (!_nanoid) {
        try { _nanoid = require('nanoid').nanoid; } catch {
            // fallback if nanoid not installed
            return Math.random().toString(36).slice(2, 2 + size);
        }
    }
    return _nanoid(size);
}

// ── Config ─────────────────────────────────────────────────────────────────
const WP_BASE = (() => {
    const raw = process.env.WP_CALLBACK_URL || 'https://staging1.shukranuae.com/wp-json/levelup/v1/core/task-result';
    return raw.replace(/\/wp-json\/.+$/, '');
})();

const WP_SECRET  = process.env.WP_SECRET || '';
const TIMEOUT_MS = 30000;

// ── Redis client (lazy) ────────────────────────────────────────────────────
let _redis = null;
function getRedis() {
    if (!_redis) {
        const { createClient } = require('redis');
        _redis = createClient({ url: process.env.REDIS_URL });
        _redis.connect().catch(e => console.error('[TOOL-EXECUTOR] Redis connect error:', e.message));
    }
    return _redis;
}

// ── HTTP dispatcher → WP proxy ─────────────────────────────────────────────
async function dispatchToWP(toolId, params) {
    const url  = `${WP_BASE}/wp-json/lu/v1/tools/execute`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-LU-Secret': WP_SECRET },
            body:    JSON.stringify({ tool_id: toolId, params }),
            signal:  ctrl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`WP returned ${res.status}: ${text.slice(0, 300)}`);
        }

        const json = await res.json();
        return { success: true, data: json.data ?? json };
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error(`Tool call timed out after ${TIMEOUT_MS / 1000}s`);
        throw e;
    }
}

// ── Governance helpers ─────────────────────────────────────────────────────
const GOV_PREFIX = 'lu:governance:action:';
const GOV_LIST   = 'lu:governance:pending';
const GOV_TTL    = 86400 * 3;

function buildActionPreview(tool, params) {
    if (tool.approval_preview) {
        return tool.approval_preview.replace(/\{(\w+)\}/g, (_, k) =>
            params[k] !== undefined ? String(params[k]).slice(0, 80) : `[${k}]`
        );
    }
    const ps = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`)
        .join(', ');
    return `${tool.name}${ps ? ` — ${ps}` : ''}`;
}

async function storeGovernanceAction(agentId, tool, params, taskId) {
    const actionId = `gov_${nanoid(10)}`;
    const action = {
        action_id:  actionId,
        agent_id:   agentId,
        tool_id:    tool.id,
        tool_name:  tool.name,
        domain:     tool.domain,
        params,
        preview:    buildActionPreview(tool, params),
        status:     'pending',
        created_at: new Date().toISOString(),
        task_id:    taskId || null,
    };
    const r = getRedis();
    await r.set(`${GOV_PREFIX}${actionId}`, JSON.stringify(action), { EX: GOV_TTL });
    await r.lPush(GOV_LIST, actionId);
    console.log(`[TOOL-EXECUTOR] Governance pending: ${actionId} (${tool.id} by ${agentId})`);
    return actionId;
}

async function getPendingActions() {
    const r   = getRedis();
    const ids = await r.lRange(GOV_LIST, 0, -1);
    if (!ids.length) return [];

    const actions  = [];
    const toRemove = [];

    for (const id of ids) {
        const raw = await r.get(`${GOV_PREFIX}${id}`);
        if (!raw) { toRemove.push(id); continue; }
        const action = JSON.parse(raw);
        if (action.status === 'pending') actions.push(action);
        else toRemove.push(id);
    }
    for (const id of toRemove) await r.lRem(GOV_LIST, 0, id);
    return actions;
}

async function approveAction(actionId) {
    const r   = getRedis();
    const raw = await r.get(`${GOV_PREFIX}${actionId}`);
    if (!raw) return { success: false, error: 'Action not found or expired.' };

    const action = JSON.parse(raw);
    if (action.status !== 'pending') return { success: false, error: `Action is already ${action.status}.` };

    action.status      = 'approved';
    action.approved_at = new Date().toISOString();
    await r.set(`${GOV_PREFIX}${actionId}`, JSON.stringify(action), { EX: GOV_TTL });

    console.log(`[TOOL-EXECUTOR] Executing approved action: ${actionId} → ${action.tool_id}`);
    try {
        const result = await dispatchToWP(action.tool_id, action.params);
        action.status      = 'executed';
        action.executed_at = new Date().toISOString();
        action.result      = result.data;
        await r.set(`${GOV_PREFIX}${actionId}`, JSON.stringify(action), { EX: GOV_TTL });
        await r.lRem(GOV_LIST, 0, actionId);
        return { success: true, result: result.data, action_id: actionId };
    } catch (e) {
        action.status = 'failed';
        action.error  = e.message;
        await r.set(`${GOV_PREFIX}${actionId}`, JSON.stringify(action), { EX: GOV_TTL });
        await r.lRem(GOV_LIST, 0, actionId);
        return { success: false, error: e.message, action_id: actionId };
    }
}

async function rejectAction(actionId) {
    const r   = getRedis();
    const raw = await r.get(`${GOV_PREFIX}${actionId}`);
    if (!raw) return { success: false, error: 'Action not found or expired.' };

    const action       = JSON.parse(raw);
    action.status      = 'rejected';
    action.rejected_at = new Date().toISOString();
    await r.set(`${GOV_PREFIX}${actionId}`, JSON.stringify(action), { EX: GOV_TTL });
    await r.lRem(GOV_LIST, 0, actionId);
    console.log(`[TOOL-EXECUTOR] Governance rejected: ${actionId}`);
    return { success: true, action_id: actionId };
}

// ── Tool call parser ───────────────────────────────────────────────────────
function parseToolCall(content) {
    if (!content) return { hasToolCall: false };
    const match = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
    if (!match) return { hasToolCall: false };
    try {
        const parsed = JSON.parse(match[1].trim());
        if (!parsed.tool) return { hasToolCall: false };
        return { hasToolCall: true, tool: parsed.tool, params: parsed.params || {} };
    } catch (e) {
        console.warn('[TOOL-EXECUTOR] Failed to parse tool_call JSON:', e.message);
        return { hasToolCall: false };
    }
}

// ── Main executor ──────────────────────────────────────────────────────────
/**
 * Execute a tool call from an agent.
 * @param {string} agentId
 * @param {string} toolId
 * @param {object} params
 * @param {string} [taskId]
 * @returns {Promise<{status, result?, error?, action_id?, preview?, tool_name?}>}
 */
async function executeTool(agentId, toolId, params = {}, taskId = null) {
    const tool = getTool(toolId);
    if (!tool) {
        console.warn(`[TOOL-EXECUTOR] Unknown tool: ${toolId}`);
        return { status: 'error', error: `Tool "${toolId}" is not registered.` };
    }

    if (!hasCapability(agentId, toolId)) {
        console.warn(`[TOOL-EXECUTOR] ${agentId} not permitted to use ${toolId}`);
        return { status: 'error', error: `${agentId} does not have permission to use "${tool.name}".` };
    }

    const missing = Object.entries(tool.params)
        .filter(([k, v]) => v.required && (params[k] === undefined || params[k] === null || params[k] === ''))
        .map(([k]) => k);
    if (missing.length) {
        return { status: 'error', error: `Missing required parameters: ${missing.join(', ')}` };
    }

    // Governance gate
    if (tool.requires_approval) {
        console.log(`[TOOL-EXECUTOR] ${toolId} requires approval`);
        try {
            const actionId = await storeGovernanceAction(agentId, tool, params, taskId);
            return {
                status:    'pending_approval',
                action_id: actionId,
                preview:   buildActionPreview(tool, params),
                tool_name: tool.name,
                tool_id:   toolId,
                agent_id:  agentId,
            };
        } catch (e) {
            return { status: 'error', error: 'Failed to queue action for approval.' };
        }
    }

    // Immediate execution
    console.log(`[TOOL-EXECUTOR] ${agentId} → ${toolId}`, JSON.stringify(params).slice(0, 200));
    try {
        const result = await dispatchToWP(toolId, params);
        console.log(`[TOOL-EXECUTOR] ${toolId} ✓`);
        return { status: 'success', result: result.data };
    } catch (e) {
        console.error(`[TOOL-EXECUTOR] ${toolId} ✗`, e.message);
        return { status: 'error', error: e.message };
    }
}

// ── Result formatter ───────────────────────────────────────────────────────
function formatToolResult(toolId, execResult) {
    if (execResult.status === 'pending_approval') {
        return `<tool_result tool="${toolId}" status="pending_approval">
Action queued for human approval.
Action ID: ${execResult.action_id}
Preview: ${execResult.preview}
Inform the user this action is awaiting their approval and continue your response.
</tool_result>`;
    }
    if (execResult.status === 'error') {
        return `<tool_result tool="${toolId}" status="error">
Error: ${execResult.error}
Proceed with your best analysis. Do not fabricate data — acknowledge the tool was unavailable.
</tool_result>`;
    }
    const data = typeof execResult.result === 'string'
        ? execResult.result
        : JSON.stringify(execResult.result, null, 2);
    return `<tool_result tool="${toolId}" status="success">\n${data}\n</tool_result>`;
}

module.exports = {
    parseToolCall,
    executeTool,
    formatToolResult,
    getPendingActions,
    approveAction,
    rejectAction,
};
