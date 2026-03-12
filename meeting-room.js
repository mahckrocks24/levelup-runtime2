'use strict';

require('dotenv').config();
const { createRedisConnection } = require('./redis');
const { callLLM }               = require('./llm');
const {
    AGENTS, TOKENS,
    buildBriefingPrompt, buildDiscussionManagerPrompt, buildRefinementManagerPrompt,
    buildUserTurnPrompt, buildCheckinPrompt, buildSpecialistPrompt,
    buildDirectMessagePrompt, buildSynthesisPrompt, buildTaskGenerationPrompt,
    parseManagerResponse, parseTasksResponse, parseMentions, isDuplicate,
} = require('./agents');

const redis = createRedisConnection();
const TTL   = 86400 * 7; // 7 days
const rkey  = id => `meeting:${id}`;
const tkey  = id => `meeting:${id}:pending_tasks`;

// ── Redis helpers ──────────────────────────────────────────────────────────
async function getMeeting(id) {
    try { const r=await redis.get(rkey(id)); return r?JSON.parse(r):null; } catch(e) { return null; }
}
async function saveMeeting(id, data) {
    try { await redis.set(rkey(id), JSON.stringify(data), 'EX', TTL); } catch(e) { console.error('[MTG] save:',e.message); }
}
async function addMsg(id, msg) {
    const m=await getMeeting(id); if(!m) return;
    m.messages.push({...msg, timestamp:new Date().toISOString()});
    m.updated_at=new Date().toISOString();
    await saveMeeting(id, m);
}
async function setState(id, status, extra={}) {
    const m=await getMeeting(id); if(!m) return;
    Object.assign(m, {status, updated_at:new Date().toISOString(), ...extra});
    await saveMeeting(id, m);
}

// ── LLM wrappers ───────────────────────────────────────────────────────────
async function callManager(prompt, mid) {
    try {
        const r=await Promise.race([
            callLLM({messages:[{role:'system',content:prompt},{role:'user',content:'Go.'}], max_tokens:TOKENS.manager, temperature:0.7}),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),60000)),
        ]);
        return parseManagerResponse(r.content);
    } catch(e) { console.error(`[MTG:${mid}] Manager:`,e.message); return {reply:'',specialists:[],tasks:{}}; }
}

async function callSpecialist(agentId, prompt, mid, history) {
    for (let attempt=1; attempt<=3; attempt++) {
        try {
            const uMsg=attempt===1?'Your response:':`Attempt ${attempt}: previous was too similar to something already said. Give a genuinely different, more specific perspective.`;
            const r=await Promise.race([
                callLLM({messages:[{role:'system',content:prompt},{role:'user',content:uMsg}], max_tokens:TOKENS.specialist, temperature:0.65+(attempt*0.1)}),
                new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),60000)),
            ]);
            const content=r.content?.trim();
            if(!content) continue;
            if(isDuplicate(content,history)){if(attempt===3) return null; continue;}
            return content;
        } catch(e) { console.error(`[MTG:${mid}] ${agentId}:`,e.message); return null; }
    }
    return null;
}

async function postAgent(id, agentId, content, role='message', extra={}) {
    if(!content?.trim()) return;
    const a=AGENTS[agentId];
    await addMsg(id, {agent_id:agentId, name:a.name, title:a.title, emoji:a.emoji, color:a.color, role, content:content.trim(), ...extra});
}

async function markSpoken(mid, agentId) {
    const m=await getMeeting(mid); if(!m) return;
    if(!m.spokenAgents) m.spokenAgents=[];
    if(!m.spokenAgents.includes(agentId)) m.spokenAgents.push(agentId);
    await saveMeeting(mid, m);
}

// ── Round runner ───────────────────────────────────────────────────────────
async function runRound(mid, ctx, specialists, tasks, histOverride) {
    for (const agentId of specialists) {
        const task=tasks?.[agentId]||'Give your expert perspective on the current discussion.';
        await setState(mid, `speaking_${agentId}`, {current_speaker:agentId});
        const m=await getMeeting(mid);
        const hist=histOverride||m.messages;
        const prompt=buildSpecialistPrompt(agentId, ctx, hist, task);
        const content=await callSpecialist(agentId, prompt, mid, m.messages);
        if(content){await postAgent(mid, agentId, content); await sleep(300);}
    }
}

// ── Start meeting ──────────────────────────────────────────────────────────
async function startMeeting(mid, ctx) {
    await saveMeeting(mid, {
        id:mid, topic:ctx.topic, type:ctx.type||'brainstorm', context:ctx,
        status:'starting', phase:'starting', messages:[], spokenAgents:[], current_speaker:null,
        created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
    });
    runMeeting(mid, ctx).catch(err=>{
        console.error(`[MTG:${mid}] Fatal:`,err.message);
        setState(mid,'error',{error:err.message});
    });
    return getMeeting(mid);
}

async function runMeeting(mid, ctx) {
    // Briefing
    await setState(mid,'speaking_dmm',{phase:'briefing',current_speaker:'dmm'});
    const briefing=await callManager(buildBriefingPrompt(ctx), mid);
    await postAgent(mid,'dmm',briefing.reply,'opening');
    await markSpoken(mid,'dmm'); await sleep(350);

    // Idea round
    await setState(mid,'idea_round',{phase:'idea_round',current_speaker:null});
    const ideaSpec=briefing.specialists.length?briefing.specialists:['james','priya','elena'];
    await runRound(mid, ctx, ideaSpec, briefing.tasks);
    for(const s of ideaSpec) await markSpoken(mid,s);

    // Discussion round
    await setState(mid,'speaking_dmm',{phase:'discussion_round',current_speaker:'dmm'});
    const m2=await getMeeting(mid);
    const disc=await callManager(buildDiscussionManagerPrompt(ctx,m2.messages), mid);
    await postAgent(mid,'dmm',disc.reply); await sleep(300);
    if(disc.specialists.length){await runRound(mid,ctx,disc.specialists,disc.tasks);for(const s of disc.specialists) await markSpoken(mid,s);}

    // Refinement round
    await setState(mid,'speaking_dmm',{phase:'refinement_round',current_speaker:'dmm'});
    const m3=await getMeeting(mid);
    const ref=await callManager(buildRefinementManagerPrompt(ctx,m3.messages), mid);
    await postAgent(mid,'dmm',ref.reply); await sleep(300);
    if(ref.specialists.length){await runRound(mid,ctx,ref.specialists,ref.tasks);for(const s of ref.specialists) await markSpoken(mid,s);}

    // Check-in
    await setState(mid,'speaking_dmm',{current_speaker:'dmm'});
    const m4=await getMeeting(mid);
    const checkin=await callManager(buildCheckinPrompt(m4.messages), mid);
    await postAgent(mid,'dmm',checkin.reply,'checkin');
    await setState(mid,'open',{phase:'open',current_speaker:null});
}

// ── User message — @ routing ───────────────────────────────────────────────
async function userMessage(mid, content) {
    const m=await getMeeting(mid);
    if(!m) return {error:'Meeting not found.'};
    if(m.status==='complete') return {error:'Meeting is complete.'};
    if(m.status==='synthesis') return {error:'Sarah is writing the action plan, please wait.'};

    const mention=parseMentions(content);
    handleUserTurn(mid, content, m.context, mention).catch(err=>console.error(`[MTG:${mid}] UserTurn:`,err.message));
    return {accepted:true};
}

async function handleUserTurn(mid, content, ctx, mention) {
    const m=await getMeeting(mid);
    const spokenAgents=m.spokenAgents||['dmm'];
    const histWithUser=[...m.messages,{role:'user',name:'You',content,timestamp:new Date().toISOString()}];

    // @all / @everyone
    if(mention.type==='all'){
        await setState(mid,'speaking_dmm',{current_speaker:'dmm'});
        const sarahRes=await callManager(buildUserTurnPrompt(ctx,histWithUser), mid);
        if(sarahRes.reply) await postAgent(mid,'dmm',sarahRes.reply); await sleep(300);
        const all=spokenAgents.filter(id=>id!=='dmm');
        for(const agentId of all){
            await setState(mid,`speaking_${agentId}`,{current_speaker:agentId});
            const m2=await getMeeting(mid);
            const prompt=buildSpecialistPrompt(agentId,ctx,[...histWithUser,...m2.messages.slice(histWithUser.length-1)],content);
            const resp=await callSpecialist(agentId,prompt,mid,m2.messages);
            if(resp){await postAgent(mid,agentId,resp); await sleep(300);}
        }
        await setState(mid,'open',{current_speaker:null}); return;
    }

    // Specific @mention — Sarah bypassed
    if(mention.type==='mention'){
        for(const agentId of mention.agents){
            await setState(mid,`speaking_${agentId}`,{current_speaker:agentId});
            await markSpoken(mid,agentId);
            const m2=await getMeeting(mid);
            const prompt=buildSpecialistPrompt(agentId,ctx,histWithUser,content);
            const resp=await callSpecialist(agentId,prompt,mid,m2.messages);
            if(resp){await postAgent(mid,agentId,resp,'message',{direct_reply_to:'user'}); await sleep(300);}
        }
        await setState(mid,'open',{current_speaker:null}); return;
    }

    // Normal — Sarah responds, may delegate
    await setState(mid,'speaking_dmm',{current_speaker:'dmm'});
    const sarahRes=await callManager(buildUserTurnPrompt(ctx,histWithUser), mid);
    if(sarahRes.reply) await postAgent(mid,'dmm',sarahRes.reply); await sleep(300);
    if(sarahRes.specialists.length){
        await runRound(mid,ctx,sarahRes.specialists,sarahRes.tasks,histWithUser);
        for(const s of sarahRes.specialists) await markSpoken(mid,s);
    }
    await setState(mid,'open',{current_speaker:null});
}

// ── Direct message ─────────────────────────────────────────────────────────
async function directMessage(mid, agentId, content) {
    const m=await getMeeting(mid);
    if(!m) return {error:'Meeting not found.'};
    if(!AGENTS[agentId]) return {error:'Invalid agent.'};
    handleDM(mid,agentId,content,m.context).catch(err=>console.error(`[MTG:${mid}] DM:`,err.message));
    return {accepted:true};
}
async function handleDM(mid, agentId, content, ctx) {
    await setState(mid,`speaking_${agentId}`,{current_speaker:agentId});
    await markSpoken(mid,agentId);
    const m=await getMeeting(mid);
    const prompt=buildDirectMessagePrompt(agentId,ctx,m.messages,content);
    const resp=await callSpecialist(agentId,prompt,mid,m.messages);
    if(resp) await postAgent(mid,agentId,resp,'dm',{dm_thread:true});
    await setState(mid,'open',{current_speaker:null});
}

// ── Wrap up ────────────────────────────────────────────────────────────────
async function wrapUpMeeting(mid) {
    const m=await getMeeting(mid);
    if(!m) return {error:'Meeting not found.'};
    if(m.status==='complete') return {error:'Already complete.'};

    await setState(mid,'synthesis',{current_speaker:'dmm'});
    const fresh=await getMeeting(mid);

    try {
        // Generate synthesis
        const r=await Promise.race([
            callLLM({messages:[{role:'system',content:buildSynthesisPrompt(m.context,fresh.messages)},{role:'user',content:'Write the action plan.'}], max_tokens:TOKENS.synthesis, temperature:0.5}),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),90000)),
        ]);
        const synthesisContent=r.content;
        await postAgent(mid,'dmm',synthesisContent,'synthesis');
        await setState(mid,'complete',{current_speaker:null,completed_at:new Date().toISOString()});

        // Generate tasks for approval — stored in Redis, WP will pick up
        generatePendingTasks(mid, m.context, synthesisContent).catch(err=>console.error(`[MTG:${mid}] Tasks:`,err.message));

        return {success:true};
    } catch(e) {
        await setState(mid,'open',{current_speaker:null});
        return {error:e.message};
    }
}

async function generatePendingTasks(mid, ctx, synthesisContent) {
    try {
        const r=await Promise.race([
            callLLM({messages:[{role:'system',content:buildTaskGenerationPrompt(ctx,synthesisContent)},{role:'user',content:'Generate the tasks.'}], max_tokens:TOKENS.tasks, temperature:0.4}),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),60000)),
        ]);
        const tasks=parseTasksResponse(r.content);
        if(!tasks.length) return;

        const m=await getMeeting(mid);
        const pendingData={
            meeting_id:mid,
            topic:ctx.topic||'',
            business:ctx.businessName||'',
            tasks:tasks.map((t,i)=>({
                id:`task_${mid}_${i}`,
                title:t.title||'Untitled task',
                description:t.description||'',
                assignee:t.assignee||'james',
                coordinator:t.coordinator||null,
                priority:t.priority||'medium',
                estimated_time:parseInt(t.estimated_time)||60,
                estimated_tokens:parseInt(t.estimated_tokens)||5000,
                status:'pending_approval',
                created_at:new Date().toISOString(),
                meeting_id:mid,
            })),
            created_at:new Date().toISOString(),
        };
        await redis.set(tkey(mid), JSON.stringify(pendingData), 'EX', 86400*3); // 3 day TTL
        console.log(`[MTG:${mid}] Generated ${tasks.length} pending tasks`);
    } catch(e) {
        console.error(`[MTG:${mid}] Task generation failed:`,e.message);
    }
}

// ── Get pending tasks (called by WP) ──────────────────────────────────────
async function getPendingTasks(mid) {
    try { const r=await redis.get(tkey(mid)); return r?JSON.parse(r):null; } catch(e) { return null; }
}
async function clearPendingTasks(mid) {
    try { await redis.del(tkey(mid)); } catch(e) {}
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports = { startMeeting, getMeeting, userMessage, directMessage, wrapUpMeeting, getPendingTasks, clearPendingTasks };
