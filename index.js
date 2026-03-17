'use strict';

require('dotenv').config();

const express = require('express');
const { createRedisConnection }    = require('./redis');
const { assembleSystemPrompt, getToolDefinitionsForLLM } = require('./prompt-assembler');
const { runAgentLoop }             = require('./llm');
const { getHistory, appendMessage, formatForLLM } = require('./conversation');
const { startMeeting, getMeeting, userMessage, directMessage, wrapUpMeeting, getPendingTasks, clearPendingTasks } = require('./meeting-room');
const taskMemory   = require('./task-memory');
const taskWorker   = require('./task-worker');
const registry     = require('./registry');
const { v4: uuidv4 }               = require('uuid');
const { registerBuilderRoutes }    = require('./builder-ai');
const synthesisRoutes              = require('./lu-synthesis-routes');

// ── Phase 1A: Lu-module imports ────────────────────────────────────────────
const taskQueueRoutes    = require('./lu-task-queue-routes');
const intelligenceRoutes = require('./lu-intelligence-routes');
const { handlePlan }     = require('./lu-intelligence-routes');
const activityRoutes     = require('./lu-activity-routes');

const app  = express();
// ── Phase 7: Global crash guard — runtime must never exit on uncaught errors ──
process.on('uncaughtException', (err) => {
    console.error('[CRASH GUARD] Uncaught exception (runtime continues):', err.message);
    console.error(err.stack?.split('\n').slice(0, 4).join('\n') || '');
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[CRASH GUARD] Unhandled rejection (runtime continues):', msg);
});

const PORT = process.env.PORT || 3000;
app.use(express.json());

console.log('[STARTUP] LevelUp Runtime v2.23.1 — Intelligence Layer');
console.log('[STARTUP] REDIS_URL          :', process.env.REDIS_URL          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_SECRET          :', process.env.WP_SECRET          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] LU_SECRET          :', process.env.LU_SECRET          ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] DEEPSEEK_KEY       :', process.env.DEEPSEEK_API_KEY   ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_URL             :', process.env.WP_URL             ? 'SET ✓' : 'NOT SET ✗ — workspace context fetches will fail');
console.log('[STARTUP] SYNTHESIS_ENDPOINT :', process.env.SYNTHESIS_ENDPOINT ? 'SET ✓' : 'NOT SET ✗ — tasks will deliver raw tool output');
console.log('[STARTUP] LLM_PROVIDER       :', process.env.LLM_PROVIDER || 'deepseek (default)');
console.log('[STARTUP] Tools (unified)    :', registry.list().length, 'tools loaded from canonical registry');

// ── Phase 9: Critical config validation — warn loudly on missing vars ────────
const CRITICAL_VARS = {
    WP_URL:             'Workspace context fetch — agents operate without business profile',
    SYNTHESIS_ENDPOINT: 'LLM synthesis — task outputs will be raw JSON instead of agent prose',
    WP_SECRET:          'Runtime authentication — all WP callbacks will fail',
    DEEPSEEK_API_KEY:   'LLM provider — no AI calls possible',
    REDIS_URL:          'Memory + queue — platform will not function',
};
const MISSING_CRITICAL = Object.entries(CRITICAL_VARS)
    .filter(([k]) => !process.env[k])
    .map(([k, desc]) => `  ✗ ${k}: ${desc}`);

if (MISSING_CRITICAL.length) {
    console.error('\n[STARTUP] ⚠️  CRITICAL CONFIGURATION MISSING:');
    MISSING_CRITICAL.forEach(m => console.error('[STARTUP]' + m));
    console.error('[STARTUP] Platform may not function correctly until these are set.\n');
}
if (process.env.LLM_PROVIDER && !['deepseek','openai'].includes(process.env.LLM_PROVIDER.toLowerCase())) {
    console.error(`[STARTUP] ✗ LLM_PROVIDER="${process.env.LLM_PROVIDER}" is not a recognised provider. Use: deepseek or openai`);
}

// ── Auth ───────────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    const secret = process.env.WP_SECRET;
    if (!secret) return res.status(500).json({ error: 'WP_SECRET not set.' });
    if (req.headers['x-levelup-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ── Queue (legacy Sprint A enqueue — kept for backward compat) ────────────
let taskQueue = null;
function getQueue() {
    if (taskQueue) return taskQueue;
    const { Queue } = require('bullmq');
    taskQueue = new Queue('levelup-tasks', { connection: createRedisConnection() });
    return taskQueue;
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
    status:'ok', version:'2.13.0', phase:'1A',
    agents:Object.keys(require('./agents').AGENTS),
    tools: registry.list().map(t=>t.name),
    config:{
        redis:     !!process.env.REDIS_URL,
        llm:       !!process.env.DEEPSEEK_API_KEY,
        wp_secret: !!process.env.WP_SECRET,
        lu_secret: !!process.env.LU_SECRET,
    },
    modules:{
        task_queue:   true,
        intelligence: true,
        activity:     true,
        bootstrap:    true,
    },
}));

app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        const counts = await getQueue().getJobCounts();
        res.json({ status:'ok', redis:'connected', queue:counts });
    } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// ── Sprint A: Enqueue (legacy) ────────────────────────────────────────────
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const b = req.body;
    for (const f of ['task_id','tool_name','workspace_id','agent_id','callback_url']) {
        if (!b[f]) return res.status(400).json({ error:`Missing: ${f}` });
    }
    try {
        const job = await getQueue().add('execute-tool',
            { ...b, payload:b.payload||{}, governance_tier:b.governance_tier??0, enqueued_at:new Date().toISOString() },
            { priority:b.priority||5, attempts:3, backoff:{type:'exponential',delay:2000}, removeOnComplete:{count:100}, removeOnFail:{count:50} });
        res.json({ accepted:true, task_id:b.task_id, job_id:job.id });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sprint B: Chat ─────────────────────────────────────────────────────────
app.post('/internal/chat', requireSecret, async (req, res) => {
    const { conversation_id, workspace_id=1, agent_id='dmm', message, workspace_context={} } = req.body;
    if (!message?.trim()) return res.status(400).json({ error:'message required.' });
    if (!conversation_id)  return res.status(400).json({ error:'conversation_id required.' });
    try {
        const history    = await getHistory(workspace_id, conversation_id);
        const llmHistory = formatForLLM(history, 20);
        await appendMessage(workspace_id, conversation_id, 'user', message);
        const systemPrompt = assembleSystemPrompt(agent_id, workspace_context,
            { availableTools: registry.list().map(t=>t.name) });
        const messages = [{ role:'system', content:systemPrompt }, ...llmHistory, { role:'user', content:message }];
        const toolDefs = getToolDefinitionsForLLM(registry.list().map(t=>({ name:t.name, description:t.description, parameters:registry.get(t.name)?.parameters })));
        const result   = await runAgentLoop({ messages, toolDefs, toolRegistry:registry, context:{ task_id:`chat_${conversation_id}_${Date.now()}`, agent_id, workspace_id }, maxRounds:3 }); // Part 6: capped at 3 rounds (was 5)
        await appendMessage(workspace_id, conversation_id, 'assistant', result.content);
        res.json({ response:result.content, agent_id, agent_name:agent_id==='dmm'?'Sarah':'Aria', tools_used:result.tools_used, rounds:result.rounds, conversation_id });
    } catch(e) {
        res.status(500).json({ error:e.message, response:"I'm having a technical issue. Please try again." });
    }
});

// ── Sprint C: Meeting Room ─────────────────────────────────────────────────

app.post('/internal/meeting/start', requireSecret, async (req, res) => {
    const b = req.body;
    if (!b.topic) return res.status(400).json({ error:'topic required.' });
    const meetingId = 'mtg_' + uuidv4().replace(/-/g,'').substring(0,16);
    try {
        await startMeeting(meetingId, {
            type:         b.type        || 'brainstorm',
            topic:        b.topic,
            businessName: b.businessName || '',
            website:      b.website      || '',
            goals:        b.goals        || '',
            industry:     b.industry     || '',
        });
        res.json({ meeting_id:meetingId, status:'starting', topic:b.topic });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/internal/meeting/:id/status', requireSecret, async (req, res) => {
    try {
        const m = await getMeeting(req.params.id);
        if (!m) return res.status(404).json({ error:'Meeting not found.' });
        res.json({
            meeting_id:      m.id,
            status:          m.status,
            current_speaker: m.current_speaker || null,
            topic:           m.topic,
            type:            m.type,
            phase:           m.phase || 'opening',
            messages:        m.messages || [],
            message_count:   (m.messages||[]).length,
            spokenAgents:    m.spokenAgents || [],
            files:           m.files || [],
            completed_at:    m.completed_at || null,
            error:           m.error || null,
        });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/internal/meeting/:id/message', requireSecret, async (req, res) => {
    const content = req.body.content?.trim();
    if (!content) return res.status(400).json({ error:'content required.' });
    try {
        const result = await userMessage(req.params.id, content);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// PHASE 1A FIX: Single DM route — duplicate removed
app.post('/internal/meeting/:id/dm', requireSecret, async (req, res) => {
    try {
        const { agentId, content } = req.body;
        const r = await directMessage(req.params.id, agentId, content);
        res.json(r);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/meeting/:id/upload', requireSecret, (req, res) => {
    const multer  = (() => { try { return require('multer'); } catch(e) { return null; } })();
    if (!multer) return res.status(501).json({ error: 'multer not installed. Run: npm install multer' });
    const fs   = require('fs');
    const path = require('path');
    const uploadDir = path.join(__dirname, 'uploads', 'meeting-files');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });
    upload.single('file')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        const ext  = path.extname(req.file.originalname).toLowerCase();
        const safe = req.file.filename + ext;
        const dest = path.join(uploadDir, safe);
        fs.renameSync(req.file.path, dest);
        const fileInfo = { name:req.file.originalname, type:req.file.mimetype, size:req.file.size, url:`/uploads/meeting-files/${safe}`, path:dest };
        try {
            const { addFileToMeeting } = require('./meeting-room');
            await addFileToMeeting(req.params.id, fileInfo);
            res.json({ ok: true, file: fileInfo });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });
});

app.use('/uploads', require('express').static(require('path').join(__dirname, 'uploads')));

app.post('/internal/meeting/:id/state-file', requireSecret, async (req,res) => {
    try {
        const { addFileToMeeting } = require('./meeting-room');
        await addFileToMeeting(req.params.id, req.body.file||{});
        res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { const d=await getPendingTasks(req.params.id); res.json(d||{tasks:[]}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { await clearPendingTasks(req.params.id); res.json({ok:true}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/internal/meeting/:id/wrap', requireSecret, async (req, res) => {
    try {
        const result = await wrapUpMeeting(req.params.id);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sprint D: Task Memory & Projects ──────────────────────────────────────

app.post('/internal/tasks/import', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, task } = req.body;
        if (!task?.id) return res.status(400).json({ error: 'task.id required.' });
        const imported = await taskMemory.importApprovedTask(wsId, task);
        res.json({ ok: true, task: imported });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/tasks', requireSecret, async (req, res) => {
    try {
        const wsId  = parseInt(req.query.wsId || 1);
        const tasks = await taskMemory.getAllTasks(wsId);
        res.json({ tasks });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/tasks/:id', requireSecret, async (req, res) => {
    try {
        const wsId = parseInt(req.query.wsId || 1);
        const task = await taskMemory.getTask(wsId, req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json(task);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/internal/tasks/:id/status', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, status, note, by = 'user' } = req.body;
        if (!status) return res.status(400).json({ error: 'status required.' });
        const result = await taskMemory.updateStatus(wsId, req.params.id, status, { note, by });
        if (!result) return res.status(404).json({ error: 'Task not found.' });
        if (status === taskMemory.STATUS.IN_PROGRESS) {
            taskWorker.triggerTaskDelivery(wsId, req.params.id)
                .catch(err => console.error(`[TASK] Delivery error:`, err.message));
        }
        res.json({ ok: true, task: result.task, oldStatus: result.oldStatus });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/tasks/:id/note', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, author, author_name, content, type = 'user' } = req.body;
        const task = await taskMemory.addNote(wsId, req.params.id, { author, author_name, content, type });
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json({ ok: true, task });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/workspace-memory', requireSecret, async (req, res) => {
    try {
        const wsId   = parseInt(req.query.wsId || 1);
        const memory = await require('./workspace-memory').getMemory(wsId);
        res.json(memory);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/workspace-memory', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, field, value } = req.body;
        const wsMem  = require('./workspace-memory');
        const memory = await wsMem.getMemory(wsId);
        if (field && value !== undefined) {
            memory[field] = value;
            await wsMem.saveMemory(wsId, memory);
        }
        res.json({ ok: true, memory });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Global AI Assistant (Phase 3 — Intelligence Upgrade) ─────────────────────
// Upgrades: persistent conversation history, workspace memory, tool execution,
//           1200 token budget, no 100-word restriction, unified tool access.
app.post('/internal/assistant', requireSecret, async (req, res) => {
    const { message, context={}, conversation_id='default', agent_id='dmm' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error:'message required' });

    const { routeIntent, formatToolSuggestions } = require('./assistant-tool-router');
    const { buildAssistantPrompt, buildAgentConsultPrompt, AGENTS, TOKENS } = require('./agents');
    const { callLLM }   = require('./llm');
    const { getHistory, appendMessage } = require('./conversation');
    const { longTermReadAll } = require('./lu-memory');
    const { getWorkspaceContext } = require('./lu-context');

    try {
        // ── Phase 0: Hard 8s timeout across ALL pre-work (history + context + memory) ──
        // Redis hang is the primary cause of blank responses. If ANY pre-work exceeds 8s,
        // we skip it and go straight to the LLM with whatever context we have.
        const PREWORK_TIMEOUT = 8000;
        const wp_url    = process.env.WP_URL || '';
        const wp_secret = process.env.WP_SECRET || '';

        const preworkTimeout = new Promise(resolve =>
            setTimeout(() => {
                console.warn('[ASSISTANT] Pre-work timeout — proceeding with base context only');
                resolve({ timedOut: true });
            }, PREWORK_TIMEOUT)
        );

        const preworkPromise = Promise.allSettled([
            getHistory(1, conversation_id),
            getWorkspaceContext(wp_url, wp_secret),
            longTermReadAll(),
        ]);

        const preworkResult = await Promise.race([preworkPromise, preworkTimeout]);

        let llm_history  = [];
        let workspaceCtx = { ...context };
        let memoryCtx    = {};

        if (!preworkResult.timedOut) {
            const [histResult, wsResult, memResult] = preworkResult;
            const conv_history = histResult.status === 'fulfilled' ? histResult.value : [];
            llm_history  = conv_history.slice(-14).map(m => ({ role: m.role, content: m.content }));
            workspaceCtx = { ...context, ...(wsResult.status === 'fulfilled' ? wsResult.value : {}) };
            memoryCtx    = memResult.status === 'fulfilled' ? memResult.value : {};
        }

        // ── Phase 2: Pre-reasoning tool suggestion ─────────────────────────
        const suggestions    = routeIntent(message, agent_id);
        const toolSuggestion = formatToolSuggestions(suggestions);

        // ── Part 4.5: Append newly discovered tools (guarded — non-blocking) ──
        let discoveredBlock = '';
        try {
            const { formatDiscoveredToolsBlock } = require('./tool-discovery');
            discoveredBlock = formatDiscoveredToolsBlock(agent_id);
        } catch (_) { /* tool-discovery unavailable — continue without it */ }

        // ── Phase 7: Strategic mode — complex multi-domain queries trigger agent consultation ──
        const STRATEGIC_PATTERNS = [
            /how (can|do|should) (i|we).{10,}(seo|content|campaign|crm|leads|social|ads|funnel)/i,
            /improve (our|my).{5,}(seo|marketing|content|strategy|funnel|ads)/i,
            /full.{0,10}(strategy|plan|roadmap|audit)/i,
            /what.{0,15}(should we|should i|recommend).{5,}(marketing|seo|content|campaign)/i,
            /help.{0,10}(grow|scale|increase|improve).{5,}(traffic|leads|sales|revenue|rankings)/i,
        ];
        const isStrategic = STRATEGIC_PATTERNS.some(p => p.test(message));

        if (isStrategic) {
            console.log('[ASSISTANT] Strategic mode triggered — consulting specialists');
            const { buildAgentConsultPrompt: bac } = require('./agents');
            const { getAgentsSync } = require('./agents');
            const agentMap = getAgentsSync();

            // Determine which specialists to consult based on detected intent
            const consultAgents = suggestions.tools.reduce((acc, tool) => {
                const domainAgents = {
                    serp_analysis: 'james', deep_audit: 'james', write_article: 'priya',
                    create_post: 'marcus', create_lead: 'elena', create_campaign: 'dmm',
                    get_site_pages: 'alex', scan_site_url: 'alex', generate_page_layout: 'dmm',
                };
                const ag = domainAgents[tool];
                if (ag && !acc.includes(ag)) acc.push(ag);
                return acc;
            }, []);
            const consultList = consultAgents.length ? consultAgents.slice(0, 3) : ['james', 'priya', 'elena'];

            // Parallel specialist consultations (30s each, non-blocking failures)
            const specialistResponses = await Promise.allSettled(
                consultList.map(async agId => {
                    const persona  = bac(agId, message, workspaceCtx);
                    const r = await callLLM({
                        messages: [{ role:'system', content: persona }, { role:'user', content: message }],
                        max_tokens: 400, temperature: 0.65,
                    });
                    const ag = agentMap[agId] || { name: agId };
                    return { agentId: agId, name: ag.name, response: r.content?.trim() || '' };
                })
            );

            const contributions = specialistResponses
                .filter(r => r.status === 'fulfilled' && r.value.response)
                .map(r => `[${r.value.name}]: ${r.value.response}`);

            if (contributions.length) {
                // Synthesise into a unified strategic response
                const synthPrompt = bac('dmm', message, workspaceCtx);
                const synthMessages = [
                    { role:'system', content: synthPrompt },
                    { role:'user', content: `The team has weighed in on: "${message}"

Team inputs:
${contributions.join('\n\n')}

Synthesise into one clear strategic recommendation with specific action steps.` },
                ];
                const synthR = await Promise.race([
                    callLLM({ messages: synthMessages, max_tokens: 800, temperature: 0.5 }),
                    new Promise((_,rej) => setTimeout(() => rej(new Error('synthesis_timeout')), 25000)),
                ]).catch(() => ({ content: contributions.join('\n\n') }));
                const reply  = synthR.content?.trim() || contributions.join('\n\n');
                await appendMessage(1, conversation_id, 'user', message).catch(() => {});
                await appendMessage(1, conversation_id, 'assistant', reply).catch(() => {});
                return res.json({
                    response:        reply,
                    strategic_mode:  true,
                    agents_consulted: consultList,
                });
            }
        }

        // ── Build upgraded prompt ───────────────────────────────────────────
        const fullSuggestion = [toolSuggestion, discoveredBlock].filter(Boolean).join('\n\n');
        const systemPrompt = buildAssistantPrompt(message, workspaceCtx, memoryCtx, fullSuggestion);

        const messages = [
            { role:'system', content: systemPrompt },
            ...llm_history,
            { role:'user', content: message },
        ];

        const r = await Promise.race([
            callLLM({ messages, max_tokens: 1200, temperature: 0.55 }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')), 35000)),
        ]);
        // ── Part 9: Blank-response failsafe — LLM returned empty content ────
        let raw = (r.content||'').trim();
        if (!raw) {
            console.warn('[ASSISTANT] LLM returned empty content — applying failsafe reply');
            raw = 'I processed your request but the response was empty. Please rephrase or try again.';
        }

        // ── Save to conversation history ─────────────────────────────────────
        await appendMessage(1, conversation_id, 'user', message).catch(() => {});
        await appendMessage(1, conversation_id, 'assistant', raw).catch(() => {});

        // ── Part 6: Tool call loop guard — max 3 tool calls per assistant turn ─
        // (single-turn tool calls — no multi-round agentic loop in assistant)
        let toolCallCount = 0;
        const MAX_TOOL_CALLS_PER_TURN = 3;

        // ── Tool call intercept ───────────────────────────────────────────────
        const toolMatch = raw.match(/<assistant_tool>\s*([\s\S]*?)\s*<\/assistant_tool>/i);
        if (toolMatch) {
            try {
                const toolCall = JSON.parse(toolMatch[1].trim());

                // ask_agent — delegate to specialist
                if (toolCall.tool === 'ask_agent' && toolCall.params?.agent) {
                    const agentId  = toolCall.params.agent;
                    const question = toolCall.params.question || message;
                    const persona  = buildAgentConsultPrompt(agentId, question, workspaceCtx);
                    const agentR   = await Promise.race([
                        callLLM({ messages:[{role:'system',content:persona},{role:'user',content:'Answer now.'}], max_tokens: TOKENS.specialist, temperature:0.65 }),
                        new Promise((_,rej)=>setTimeout(()=>rej(new Error('agent timeout')),30000)),
                    ]);
                    const agent = AGENTS[agentId]||{};
                    const agentReply = agentR.content?.trim() || raw || 'I reviewed your question and am working on a response.';
                    await appendMessage(1, conversation_id, 'assistant', agentReply).catch(() => {});
                    return res.json({ response:agentReply, agent_response:true, agent_id:agentId, agent_name:agent.name||agentId, agent_emoji:agent.emoji||'🤖', agent_color:agent.color||'#8B97B0' });
                }

                // execute_tool — run a tool through the unified registry (capability-checked)
                if (toolCall.tool === 'execute_tool' && toolCall.params?.tool_id) {
                    const tool_id   = toolCall.params.tool_id;
                    const toolParams = toolCall.params.params || {};
                    const { hasCapability } = require('./capability-map');
                    if (!hasCapability(agent_id, tool_id)) {
                        return res.json({ response:`I don't have permission to run ${tool_id} directly. I can consult a specialist agent instead.`, tool_error:'capability_denied' });
                    }
                    const unifiedReg = require('./registry');
                    const result = await Promise.race([
                        unifiedReg.execute(tool_id, toolParams, { agent_id }),
                        new Promise((_,rej)=>setTimeout(()=>rej(new Error('tool_timeout')),20000)),
                    ]).catch(e => ({ success:false, error:e.message }));
                    const textBefore = raw.replace(/<assistant_tool>[\s\S]*<\/assistant_tool>/i,'').trim();
                    return res.json({ response:textBefore || 'Done.', tool_executed:true, tool_id, tool_result:result });
                }

                // navigate — platform navigation
                const textBefore = raw.replace(/<assistant_tool>[\s\S]*<\/assistant_tool>/i,'').trim();
                return res.json({ response:textBefore||`Navigating now.`, tool_call:toolCall });
            } catch(e) { /* JSON parse failed — treat as plain text */ }
        }
        res.json({ response: raw });
    } catch(e) {
        console.error('[ASSISTANT] Fatal:', e.message, e.stack?.split('\n')[1] || '');
        // Part 9: Global failsafe — always return a usable response
        if (!res.headersSent) {
            res.status(200).json({
                response: 'The assistant encountered an internal issue but remains operational. Please retry.',
                error:    e.message,
                failsafe: true,
            });
        }
    }
});

// ── Phase 9: Growth Insights endpoints ───────────────────────────────────────
// Lazy — growth-insights and campaign-learning connect Redis at module load.
// Required inside handlers to avoid boot-time Redis connection race.

// ── Part 4: Tool Discovery + Health endpoints ────────────────────────────────
// Lazy requires — these modules connect Redis at load time; defer until actually needed.
// discovery, toolLearning, healthCheck are required inline inside route handlers only.

app.post('/internal/tools/discover', requireSecret, async (req, res) => {
    const wp_url = process.env.WP_URL || req.body?.wp_url || '';
    const secret = process.env.WP_SECRET || '';
    try {
        const { scanPlatformTools } = require('./tool-discovery');
        const { learnNewTools }     = require('./tool-learning');
        const result   = await scanPlatformTools(wp_url, secret);
        const newTools = (result.dynamic || []).filter(t => t.auto_discovered);
        const knowledge = newTools.length
            ? await learnNewTools(newTools).then(r => r.map(x => x.knowledge))
            : [];
        res.json({ success: true, ...result, knowledge });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/internal/tools/health', requireSecret, async (req, res) => {
    try {
        const { getHealthSummary } = require('./tool-health-check');
        const summary = await getHealthSummary();
        res.json({ success: true, ...summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/tools/health/run', requireSecret, async (req, res) => {
    const wp_url = process.env.WP_URL || '';
    const secret = process.env.WP_SECRET || '';
    try {
        const { runHealthChecks } = require('./tool-health-check');
        const result = await runHealthChecks(wp_url, secret, { force: true });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/internal/insights/refresh', requireSecret, async (req, res) => {
    const wp_url    = process.env.WP_URL || '';
    const wp_secret = process.env.WP_SECRET || '';
    try {
        const { generateInsights }           = require('./growth-insights');
        const { refreshInsights: refreshCampaignInsights } = require('./campaign-learning');
        const [growth, campaign] = await Promise.allSettled([
            generateInsights(wp_url, wp_secret),
            refreshCampaignInsights(wp_url, wp_secret),
        ]);
        res.json({
            success:  true,
            growth:   growth.status  === 'fulfilled' ? growth.value  : null,
            campaign: campaign.status === 'fulfilled' ? campaign.value : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/internal/insights/current', requireSecret, async (req, res) => {
    try {
        const { readInsights: readGrowthInsights }          = require('./growth-insights');
        const { readInsights: readCampaignInsights }         = require('./campaign-learning');
        const [growth, campaign] = await Promise.allSettled([
            readGrowthInsights(),
            readCampaignInsights(),
        ]);
        res.json({
            growth:   growth.status  === 'fulfilled' ? growth.value  : null,
            campaign: campaign.status === 'fulfilled' ? campaign.value : null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Governance ─────────────────────────────────────────────────────────────
const { getPendingActions, approveAction, rejectAction } = require('./tool-executor');

app.get('/internal/governance/pending', requireSecret, async (req, res) => {
    try { const actions = await getPendingActions(); res.json({ success:true, pending:actions, count:actions.length }); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/internal/governance/approve', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success:false, error:'action_id required.' });
    try { res.json(await approveAction(action_id)); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/internal/governance/reject', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success:false, error:'action_id required.' });
    try { res.json(await rejectAction(action_id)); }
    catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// ── PHASE 1A: New route mounts ─────────────────────────────────────────────

// Phase 6 — Task queue routes
app.use('/internal/task', taskQueueRoutes);

// Phase 7 — Intelligence routes (plan, memory, trace, collab)
app.use('/internal/intelligence', intelligenceRoutes);

// Phase 7 — Backward-compat alias: PHP lu_agent_plan_create calls this path
app.post('/internal/agent/plan', (req, res) => handlePlan(req, res));

// Phase 8 — Activity stream routes (SSE + event log)
app.use('/internal/activity', activityRoutes);

// Builder AI routes
registerBuilderRoutes(app);

// Synthesis route — called by lu-task-worker.js when SYNTHESIS_ENDPOINT is set
// Set Railway env: SYNTHESIS_ENDPOINT=https://<runtime-url>/internal/synthesize
app.use('/internal/synthesize', synthesisRoutes);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error:'Not found', path:req.path }));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✓ LevelUp Runtime v2.23.3 on :${PORT}`);
    console.log('[SERVER] Routes registered — Assistant ready');
    // Phase 2+6: Background worker starts AFTER server is live (never blocks boot)
    try {
        const worker = require('./tool-discovery-worker');
        worker.start();
        console.log('[SERVER] Background discovery scheduled');
    } catch (e) {
        // Worker failure never prevents the server from running
        console.warn('[SERVER] Background worker failed to start (non-fatal):', e.message);
    }
    // lu-bootstrap: starts lu-task-worker (Phase 7) + crash recovery
    require('./lu-bootstrap');
});

module.exports = app;
