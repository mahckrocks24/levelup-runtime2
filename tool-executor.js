'use strict';

/**
 * LevelUp Tool Executor — Sprint F
 * Dispatches tool calls from agents to WordPress REST endpoints.
 * Returns structured results or graceful error messages.
 */

const { getTool } = require('./tool-registry');

const WP_BASE   = (process.env.WP_CALLBACK_URL || 'https://staging1.shukranuae.com/wp-json/levelup/v1/core/task-result')
    .replace(/\/wp-json\/.+$/, '');
const WP_SECRET = process.env.WP_SECRET || '';

const TIMEOUT_MS = 20000; // 20s per tool call

// ── HTTP dispatcher ────────────────────────────────────────────────────────
async function dispatchToWP(endpoint, method, params) {
    const url  = `${WP_BASE}${endpoint}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    try {
        const opts = {
            method,
            headers: {
                'Content-Type':  'application/json',
                'X-WP-Secret':   WP_SECRET,
                'X-Runtime-Key': WP_SECRET,
            },
            signal: ctrl.signal,
        };

        if (method === 'POST' && params && Object.keys(params).length) {
            opts.body = JSON.stringify(params);
        } else if (method === 'GET' && params && Object.keys(params).length) {
            const qs = new URLSearchParams(params).toString();
            return await dispatchToWP(`${endpoint}?${qs}`, 'GET', {});
        }

        const res = await fetch(url, opts);
        clearTimeout(timer);

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`WP returned ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = await res.json();
        return { success: true, data };

    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error(`Tool call timed out after ${TIMEOUT_MS / 1000}s`);
        throw e;
    }
}

// ── Tool call parser ───────────────────────────────────────────────────────
/**
 * Detects if an LLM response contains a <tool_call> block.
 * Returns { hasToolCall: true, tool, params } or { hasToolCall: false }
 */
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
 * @param {string} agentId  - The agent making the call
 * @param {string} toolId   - Tool identifier
 * @param {object} params   - Tool parameters
 * @returns {object}        - { success, result, error }
 */
async function executeTool(agentId, toolId, params) {
    const tool = getTool(toolId);

    if (!tool) {
        console.warn(`[TOOL-EXECUTOR] Unknown tool: ${toolId}`);
        return { success: false, error: `Tool "${toolId}" not found.` };
    }

    if (!tool.agents.includes(agentId)) {
        console.warn(`[TOOL-EXECUTOR] Agent ${agentId} not permitted to use ${toolId}`);
        return { success: false, error: `You don't have permission to use the "${tool.name}" tool.` };
    }

    // Validate required params
    const missing = Object.entries(tool.params)
        .filter(([k, v]) => v.required && !params[k])
        .map(([k]) => k);

    if (missing.length) {
        return { success: false, error: `Missing required parameters: ${missing.join(', ')}` };
    }

    console.log(`[TOOL-EXECUTOR] ${agentId} → ${toolId}`, JSON.stringify(params).slice(0, 200));

    try {
        const result = await dispatchToWP(tool.endpoint, tool.method, params);
        console.log(`[TOOL-EXECUTOR] ${toolId} ✓ success`);
        return { success: true, result: result.data };
    } catch (e) {
        console.error(`[TOOL-EXECUTOR] ${toolId} ✗`, e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Format a tool result for injection back into the LLM conversation.
 */
function formatToolResult(toolId, result, error) {
    if (error) {
        return `<tool_result tool="${toolId}" status="error">\n${error}\nNote: Proceed with your best analysis based on available knowledge. Do not fabricate specific numbers — acknowledge the data wasn't available.\n</tool_result>`;
    }
    const data = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return `<tool_result tool="${toolId}" status="success">\n${data}\n</tool_result>`;
}

module.exports = { parseToolCall, executeTool, formatToolResult };
