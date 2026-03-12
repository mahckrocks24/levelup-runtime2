'use strict';

/**
 * LevelUp LLM Provider Layer — v2
 * Added: vision call support (useVision flag) for image analysis
 */

require('dotenv').config();
const axios = require('axios');

const PROVIDERS = {
    deepseek: {
        baseURL:    'https://api.deepseek.com/v1',
        model:      'deepseek-chat',
        visionModel:'deepseek-chat',    // deepseek-chat supports vision
        apiKeyEnv:  'DEEPSEEK_API_KEY',
    },
    openai: {
        baseURL:    'https://api.openai.com/v1',
        model:      'gpt-4o',
        visionModel:'gpt-4o',
        apiKeyEnv:  'OPENAI_API_KEY',
    },
};

function getProvider() {
    const name = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
    const p = PROVIDERS[name];
    if (!p) throw new Error(`Unknown LLM_PROVIDER: ${name}`);
    return { name, ...p };
}

async function callLLM({ messages, tools = [], max_tokens = 1500, temperature = 0.7, useVision = false }) {
    const provider = getProvider();
    const apiKey   = process.env[provider.apiKeyEnv];
    if (!apiKey) throw new Error(`${provider.apiKeyEnv} not set.`);

    const model = useVision ? provider.visionModel : provider.model;

    const body = { model, messages, max_tokens, temperature };
    if (tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }

    console.log(`[LLM] ${provider.name}/${model} | msgs=${messages.length} | vision=${useVision}`);

    try {
        const response = await axios.post(
            `${provider.baseURL}/chat/completions`,
            body,
            {
                timeout: 90000,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            }
        );
        const choice  = response.data.choices[0];
        const message = choice.message;
        const usage   = response.data.usage || {};
        console.log(`[LLM] done | finish=${choice.finish_reason} | tokens=${usage.total_tokens||'?'}`);
        return {
            content:       message.content || '',
            tool_calls:    message.tool_calls || [],
            finish_reason: choice.finish_reason,
            usage,
        };
    } catch(err) {
        if (err.response) {
            const d = err.response.data;
            console.error(`[LLM] API error ${err.response.status}:`, JSON.stringify(d));
            throw new Error(`LLM API ${err.response.status}: ${d?.error?.message || JSON.stringify(d)}`);
        }
        console.error(`[LLM] Network:`, err.message);
        throw new Error(`LLM network error: ${err.message}`);
    }
}

async function runAgentLoop({ messages, toolDefs, toolRegistry, context, maxRounds = 5 }) {
    const allMessages = [...messages];
    const toolsUsed   = [];
    let rounds        = 0;

    while (rounds < maxRounds) {
        rounds++;
        const r = await callLLM({ messages: allMessages, tools: toolDefs });
        if (!r.tool_calls?.length) return { content: r.content, tools_used: toolsUsed, rounds };

        allMessages.push({ role: 'assistant', content: r.content, tool_calls: r.tool_calls });

        for (const tc of r.tool_calls) {
            const name = tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
            const result = await toolRegistry.execute(name, args, context);
            toolsUsed.push({ name, args, success: result.success });
            allMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.success ? result.data : { error: result.error }) });
        }
    }

    const final = await callLLM({ messages: allMessages, tools: [] });
    return { content: final.content, tools_used: toolsUsed, rounds };
}

module.exports = { callLLM, runAgentLoop, getProvider };
