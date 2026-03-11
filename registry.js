'use strict';

const tools = require('./tools');

class ToolRegistry {
    constructor() {
        this._registry = new Map();
        for (const tool of tools) {
            this._registry.set(tool.name, tool);
        }
        console.log(`[REGISTRY] Loaded ${this._registry.size} tool(s): ${[...this._registry.keys()].join(', ')}`);
    }

    has(toolName)  { return this._registry.has(toolName); }
    get(toolName)  { return this._registry.get(toolName) || null; }

    async execute(toolName, payload, context = {}) {
        const start = Date.now();
        const tool  = this._registry.get(toolName);

        if (!tool) {
            return { success: false, data: null, error: `Tool '${toolName}' not registered.`, execution_ms: 0 };
        }

        console.log(`[REGISTRY] Executing: ${toolName} | task=${context.task_id}`);

        try {
            const result = await Promise.race([
                tool.handler(payload, context),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool '${toolName}' timed out`)), tool.timeout_ms)
                ),
            ]);

            const execution_ms = Date.now() - start;
            console.log(`[REGISTRY] ${toolName} done in ${execution_ms}ms`);

            return {
                success:      true,
                data:         result,
                execution_ms,
                memory_hint:  tool.memory_hint ? tool.memory_hint(result) : null,
            };
        } catch (err) {
            return { success: false, data: null, error: err.message, execution_ms: Date.now() - start };
        }
    }

    list() {
        return [...this._registry.values()].map(t => ({
            name: t.name, description: t.description,
            execution_type: t.execution_type, governance_tier: t.governance_tier,
        }));
    }
}

module.exports = new ToolRegistry();
