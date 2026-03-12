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

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

console.log('[STARTUP] LevelUp Runtime Sprint C v2 (Natural Conversation)');
console.log('[STARTUP] REDIS_URL    :', process.env.REDIS_URL        ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] WP_SECRET    :', process.env.WP_SECRET        ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] DEEPSEEK_KEY :', process.env.DEEPSEEK_API_KEY ? 'SET ✓' : 'NOT SET ✗');
console.log('[STARTUP] Tools        :', registry.list().map(t=>t.name).join(', '));

// ── Auth ───────────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    const secret = process.env.WP_SECRET;
    if (!secret) return res.status(500).json({ error: 'WP_SECRET not set.' });
    if (req.headers['x-levelup-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized.' });
    next();
}

// ── Queue (Sprint A) ───────────────────────────────────────────────────────
let taskQueue = null;
function getQueue() {
    if (taskQueue) return taskQueue;
    const { Queue } = require('bullmq');
    taskQueue = new Queue('levelup-tasks', { connection: createRedisConnection() });
    return taskQueue;
}

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
    status:'ok', sprint:'C-v2', version:'0.3.1',
    agents:Object.keys(require('./agents').AGENTS),
    tools: registry.list().map(t=>t.name),
    config:{ redis:!!process.env.REDIS_URL, llm:!!process.env.DEEPSEEK_API_KEY, wp:!!process.env.WP_SECRET },
}));

app.get('/internal/health', requireSecret, async (req, res) => {
    try {
        const counts = await getQueue().getJobCounts();
        res.json({ status:'ok', redis:'connected', queue:counts });
    } catch(e) { res.status(500).json({ status:'error', message:e.message }); }
});

// ── Sprint A: Enqueue ──────────────────────────────────────────────────────
app.post('/internal/enqueue', requireSecret, async (req, res) => {
    const b = req.body;
    for (const f of ['task_id','tool_name','workspace_id','agent_id','callback_url']) {
        if (!b[f]) return res.status(400).json({ error:`Missing: ${f}` });
    }
    try {
        const job = await getQueue().add('execute-tool', { ...b, payload:b.payload||{}, governance_tier:b.governance_tier??0, enqueued_at:new Date().toISOString() },
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
        const history     = await getHistory(workspace_id, conversation_id);
        const llmHistory  = formatForLLM(history, 20);
        await appendMessage(workspace_id, conversation_id, 'user', message);

        const systemPrompt = assembleSystemPrompt(agent_id, workspace_context,
            { availableTools: registry.list().map(t=>t.name) });

        const messages = [{ role:'system', content:systemPrompt }, ...llmHistory, { role:'user', content:message }];
        const toolDefs = getToolDefinitionsForLLM(registry.list().map(t=>({ name:t.name, description:t.description, parameters:registry.get(t.name)?.parameters })));
        const result   = await runAgentLoop({ messages, toolDefs, toolRegistry:registry, context:{ task_id:`chat_${conversation_id}_${Date.now()}`, agent_id, workspace_id }, maxRounds:5 });

        await appendMessage(workspace_id, conversation_id, 'assistant', result.content);
        res.json({ response:result.content, agent_id, agent_name:agent_id==='dmm'?'Sarah':'Aria', tools_used:result.tools_used, rounds:result.rounds, conversation_id });
    } catch(e) {
        res.status(500).json({ error:e.message, response:"I'm having a technical issue. Please try again." });
    }
});

// ── Sprint C: Meeting Room ─────────────────────────────────────────────────

/** Start meeting */
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

/** Poll meeting status */
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

/** User sends a message mid-meeting */
app.post('/internal/meeting/:id/message', requireSecret, async (req, res) => {
    const content = req.body.content?.trim();
    if (!content) return res.status(400).json({ error:'content required.' });
    try {
        const result = await userMessage(req.params.id, content);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

/** Direct message to specific agent */
app.post('/internal/meeting/:id/dm', requireSecret, async (req, res) => {
    try {
        const { agentId, content } = req.body;
        const r = await directMessage(req.params.id, agentId, content);
        res.json(r);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Direct message */
app.post('/internal/meeting/:id/dm', requireSecret, async (req,res) => {
    try { const {agentId,content}=req.body; res.json(await directMessage(req.params.id,agentId,content)); }
    catch(e){ res.status(500).json({error:e.message}); }
});

/** File upload to meeting */
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
        const fileInfo = {
            name: req.file.originalname,
            type: req.file.mimetype,
            size: req.file.size,
            url:  `/uploads/meeting-files/${safe}`,
            path: dest,
        };
        try {
            const { addFileToMeeting } = require('./meeting-room');
            await addFileToMeeting(req.params.id, fileInfo);
            res.json({ ok: true, file: fileInfo });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });
});

/** Serve uploaded files */
app.use('/uploads', require('express').static(require('path').join(__dirname, 'uploads')));

/** Register file in meeting state (called from WP upload handler) */
app.post('/internal/meeting/:id/state-file', requireSecret, async (req,res) => {
    try {
        const { addFileToMeeting } = require('./meeting-room');
        await addFileToMeeting(req.params.id, req.body.file||{});
        res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
});

/** Get pending tasks awaiting approval */
app.get('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { const d=await getPendingTasks(req.params.id); res.json(d||{tasks:[]}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

/** Clear pending tasks (after WP approves/rejects) */
app.delete('/internal/meeting/:id/pending-tasks', requireSecret, async (req,res) => {
    try { await clearPendingTasks(req.params.id); res.json({ok:true}); }
    catch(e){ res.status(500).json({error:e.message}); }
});

/** Wrap up meeting — user triggered */
app.post('/internal/meeting/:id/wrap', requireSecret, async (req, res) => {
    try {
        const result = await wrapUpMeeting(req.params.id);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Sprint D: Task Memory & Projects ──────────────────────────────────────

/** Import approved task from WP → task memory */
app.post('/internal/tasks/import', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, task } = req.body;
        if (!task?.id) return res.status(400).json({ error: 'task.id required.' });
        const imported = await taskMemory.importApprovedTask(wsId, task);
        res.json({ ok: true, task: imported });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Get all tasks for workspace */
app.get('/internal/tasks', requireSecret, async (req, res) => {
    try {
        const wsId  = parseInt(req.query.wsId || 1);
        const tasks = await taskMemory.getAllTasks(wsId);
        res.json({ tasks });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Get single task with full history + deliverable */
app.get('/internal/tasks/:id', requireSecret, async (req, res) => {
    try {
        const wsId = parseInt(req.query.wsId || 1);
        const task = await taskMemory.getTask(wsId, req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json(task);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Update task status — triggers agent delivery when moving to in_progress */
app.put('/internal/tasks/:id/status', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, status, note, by = 'user' } = req.body;
        if (!status) return res.status(400).json({ error: 'status required.' });
        const result = await taskMemory.updateStatus(wsId, req.params.id, status, { note, by });
        if (!result) return res.status(404).json({ error: 'Task not found.' });

        // Trigger agent delivery when moved to in_progress
        if (status === taskMemory.STATUS.IN_PROGRESS) {
            taskWorker.triggerTaskDelivery(wsId, req.params.id)
                .catch(err => console.error(`[TASK] Delivery error:`, err.message));
        }

        res.json({ ok: true, task: result.task, oldStatus: result.oldStatus });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Add a note to a task */
app.post('/internal/tasks/:id/note', requireSecret, async (req, res) => {
    try {
        const { wsId = 1, author, author_name, content, type = 'user' } = req.body;
        const task = await taskMemory.addNote(wsId, req.params.id, { author, author_name, content, type });
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        res.json({ ok: true, task });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Get workspace memory */
app.get('/internal/workspace-memory', requireSecret, async (req, res) => {
    try {
        const wsId   = parseInt(req.query.wsId || 1);
        const memory = await require('./workspace-memory').getMemory(wsId);
        res.json(memory);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

/** Update workspace memory field */
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

// ── Global AI Assistant ───────────────────────────────────────────────────
app.post('/internal/assistant', requireSecret, async (req, res) => {
    const { message, context={}, history=[] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error:'message required' });

    const { buildAssistantPrompt, buildAgentConsultPrompt, AGENTS, TOKENS } = require('./agents');
    const { callLLM } = require('./llm');

    try {
        // Build conversation messages with history
        const systemPrompt = buildAssistantPrompt(message, context);
        const messages = [
            { role:'system', content: systemPrompt },
            ...history.slice(-10).map(h=>({ role: h.role, content: h.content })),
            { role:'user', content: message },
        ];

        const r = await Promise.race([
            callLLM({ messages, max_tokens: 500, temperature: 0.5 }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')), 30000)),
        ]);

        const raw = (r.content||'').trim();

        // Detect tool call
        const toolMatch = raw.match(/<assistant_tool>\s*([\s\S]*?)\s*<\/assistant_tool>/i);
        if (toolMatch) {
            try {
                const toolCall = JSON.parse(toolMatch[1].trim());

                // Handle ask_agent server-side: consult the specialist
                if (toolCall.tool === 'ask_agent' && toolCall.params?.agent) {
                    const agentId  = toolCall.params.agent;
                    const question = toolCall.params.question || message;
                    const persona  = buildAgentConsultPrompt(agentId, question, context);
                    const agentR   = await Promise.race([
                        callLLM({ messages:[{role:'system',content:persona},{role:'user',content:'Answer now.'}], max_tokens: TOKENS.specialist, temperature:0.65 }),
                        new Promise((_,rej)=>setTimeout(()=>rej(new Error('agent timeout')),30000)),
                    ]);
                    const agent = AGENTS[agentId]||{};
                    return res.json({
                        response: agentR.content?.trim()||'',
                        agent_response: true,
                        agent_id: agentId,
                        agent_name: agent.name||agentId,
                        agent_emoji: agent.emoji||'🤖',
                        agent_color: agent.color||'#8B97B0',
                    });
                }

                // All other tools: return tool_call for client execution
                const textBefore = raw.replace(/<assistant_tool>[\s\S]*<\/assistant_tool>/i,'').trim();
                return res.json({ response: textBefore||`I'll ${toolCall.tool.replace(/_/g,' ')} that for you.`, tool_call: toolCall });
            } catch(e) {
                // JSON parse failed — treat as plain response
            }
        }

        res.json({ response: raw });
    } catch(e) {
        console.error('[ASSISTANT]', e.message);
        res.status(500).json({ error: e.message, response:"I'm having a technical issue. Please try again." });
    }
});

// ── Governance endpoints ───────────────────────────────────────────────────
const { getPendingActions, approveAction, rejectAction } = require('./tool-executor');

// GET /internal/governance/pending — list all pending tool approval actions
app.get('/internal/governance/pending', requireSecret, async (req, res) => {
    try {
        const actions = await getPendingActions();
        res.json({ success: true, pending: actions, count: actions.length });
    } catch (e) {
        console.error('[GOVERNANCE]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /internal/governance/approve — approve and execute a pending action
app.post('/internal/governance/approve', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success: false, error: 'action_id required.' });
    try {
        const result = await approveAction(action_id);
        res.json(result);
    } catch (e) {
        console.error('[GOVERNANCE]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /internal/governance/reject — reject a pending action
app.post('/internal/governance/reject', requireSecret, async (req, res) => {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ success: false, error: 'action_id required.' });
    try {
        const result = await rejectAction(action_id);
        res.json(result);
    } catch (e) {
        console.error('[GOVERNANCE]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error:'Not found', path:req.path }));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] ✓ LevelUp Runtime Sprint C v2 on :${PORT}`);
    require('./worker');
});

module.exports = app;
