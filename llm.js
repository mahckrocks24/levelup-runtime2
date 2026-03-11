'use strict';

/**
 * LevelUp LLM Provider Layer
 *
 * Abstracts the LLM provider so agents never call DeepSeek directly.
 * Swap provider by changing LLM_PROVIDER env var — zero agent code changes.
 *
 * Supported providers:
 *   deepseek  (default) — https://api.deepseek.com/v1
 *   openai              — https://api.openai.com/v1
 *   anthropic           — future
 *
 * DeepSeek uses the OpenAI-compatible API format.
 * Tool/function calling follows the OpenAI spec exactly.
 */

require('dotenv').config();
const axios = require('axios');

const PROVIDERS = {
    deepseek: {
        baseURL: 'https://api.deepseek.com/v1',
        model:   'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    openai: {
        baseURL: 'https://api.openai.com/v1',
        model:   'gpt-4o',
        apiKeyEnv: 'OPENAI_API_KEY',
    },
};

function getProvider() {
    const name = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();
    const provider = PROVIDERS[name];
    if (!provider) throw new Error(`Unknown LLM_PROVIDER: ${name}. Supported: ${Object.keys(PROVIDERS).join(', ')}`);
    return { name, ...provider };
}

/**
 * Core LLM call. All agents use this function.
 *
 * @param {object} options
 * @param {array}  options.messages     — full conversation history including system prompt
 * @param {array}  [options.tools]      — OpenAI-format tool definitions
 * @param {number} [options.max_tokens] — default 1500
 * @param {number} [options.temperature]— default 0.7
 * @returns {Promise<LLMResponse>}
 */
async function callLLM({ messages, tools = [], max_tokens = 1500, temperature = 0.7 }) {
    const provider = getProvider();
    const apiKey   = process.env[provider.apiKeyEnv];

    if (!apiKey) {
        throw new Error(`${provider.apiKeyEnv} is not set. Add it to Railway Variables.`);
    }

    const body = {
        model:       provider.model,
        messages,
        max_tokens,
        temperature,
    };

    // Only include tools if provided
    if (tools.length > 0) {
        body.tools       = tools;
        body.tool_choice = 'auto';
    }

    console.log(`[LLM] Calling ${provider.name} | model=${provider.model} | messages=${messages.length} | tools=${tools.length}`);

    try {
        const response = await axios.post(
            `${provider.baseURL}/chat/completions`,
            body,
            {
                timeout: 60000,
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
            }
        );

        const choice  = response.data.choices[0];
        const message = choice.message;
        const usage   = response.data.usage || {};

        console.log(`[LLM] Response: finish_reason=${choice.finish_reason} | tokens=${usage.total_tokens || '?'}`);

        return {
            content:    message.content || '',
            tool_calls: message.tool_calls || [],
            finish_reason: choice.finish_reason,
            usage,
        };

    } catch (err) {
        if (err.response) {
            const status = err.response.status;
            const data   = err.response.data;
            console.error(`[LLM] API error ${status}:`, JSON.stringify(data));
            throw new Error(`LLM API error ${status}: ${data?.error?.message || JSON.stringify(data)}`);
        }
        console.error(`[LLM] Network error:`, err.message);
        throw new Error(`LLM network error: ${err.message}`);
    }
}

/**
 * Execute a full agent reasoning loop with tool use.
 * Handles multiple rounds of tool calls until the agent returns a final response.
 *
 * @param {object} options
 * @param {array}  options.messages      — initial messages (system + history + user)
 * @param {array}  options.toolDefs      — OpenAI-format tool definitions for the LLM
 * @param {object} options.toolRegistry  — registry.execute() callable
 * @param {object} options.context       — { task_id, agent_id, workspace_id }
 * @param {number} [options.maxRounds]   — max tool call rounds (default 5)
 * @returns {Promise<AgentResult>}
 */
async function runAgentLoop({ messages, toolDefs, toolRegistry, context, maxRounds = 5 }) {
    const allMessages   = [...messages];
    const toolsUsed     = [];
    let rounds          = 0;

    while (rounds < maxRounds) {
        rounds++;
        console.log(`[AGENT_LOOP] Round ${rounds} | agent=${context.agent_id}`);

        const llmResponse = await callLLM({
            messages: allMessages,
            tools:    toolDefs,
        });

        // No tool calls — agent is done
        if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
            return {
                content:    llmResponse.content,
                tools_used: toolsUsed,
                rounds,
            };
        }

        // Add assistant message with tool calls to history
        allMessages.push({
            role:       'assistant',
            content:    llmResponse.content,
            tool_calls: llmResponse.tool_calls,
        });

        // Execute each tool call
        for (const toolCall of llmResponse.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs   = {};

            try {
                toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (e) {
                console.warn(`[AGENT_LOOP] Could not parse tool args for ${toolName}`);
            }

            console.log(`[AGENT_LOOP] Tool call: ${toolName}`, toolArgs);
            const result = await toolRegistry.execute(toolName, toolArgs, context);

            toolsUsed.push({
                name:         toolName,
                args:         toolArgs,
                success:      result.success,
                execution_ms: result.execution_ms,
            });

            // Add tool result to messages
            allMessages.push({
                role:         'tool',
                tool_call_id: toolCall.id,
                content:      JSON.stringify(result.success ? result.data : { error: result.error }),
            });
        }
        // Loop continues — LLM will now reason on tool results
    }

    // Max rounds hit — return whatever we have
    console.warn(`[AGENT_LOOP] Max rounds (${maxRounds}) reached for agent=${context.agent_id}`);
    const finalResponse = await callLLM({ messages: allMessages, tools: [] });
    return {
        content:    finalResponse.content,
        tools_used: toolsUsed,
        rounds,
    };
}

module.exports = { callLLM, runAgentLoop, getProvider };
