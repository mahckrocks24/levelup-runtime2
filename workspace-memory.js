'use strict';

/**
 * WORKSPACE_MEMORY — Persistent memory across all meetings
 * Agents reference this in every meeting to build on past context.
 */

const { createRedisConnection } = require('./redis');
const redis = createRedisConnection();
const TTL   = 86400 * 90; // 90 days
const mkey  = (workspaceId) => `workspace:${workspaceId}:memory`;

const EMPTY_MEMORY = () => ({
    business_profile:     {},   // { name, website, industry, size, location }
    target_audience:      [],   // audience segments discovered
    brand_positioning:    '',   // brand positioning statement
    key_strategies:       [],   // strategies validated across meetings
    previous_campaigns:   [],   // { topic, date, outcome }
    successful_content:   [],   // content types/topics that worked
    channel_performance:  {},   // { channel: "notes on what worked" }
    competitor_intel:     [],   // competitor observations
    vocabulary:           [],   // brand terms, client-specific language
    updated_at:           null,
    meeting_count:        0,
});

async function getMemory(workspaceId = 1) {
    try {
        const r = await redis.get(mkey(workspaceId));
        return r ? JSON.parse(r) : EMPTY_MEMORY();
    } catch(e) {
        return EMPTY_MEMORY();
    }
}

async function saveMemory(workspaceId, memory) {
    try {
        memory.updated_at = new Date().toISOString();
        await redis.set(mkey(workspaceId), JSON.stringify(memory), 'EX', TTL);
    } catch(e) {
        console.error('[MEMORY] save failed:', e.message);
    }
}

async function updateFromMeeting(workspaceId, meetingData) {
    const m = await getMemory(workspaceId);
    m.meeting_count = (m.meeting_count || 0) + 1;

    // Upsert business profile
    if (meetingData.businessName) m.business_profile.name = meetingData.businessName;
    if (meetingData.website)      m.business_profile.website = meetingData.website;
    if (meetingData.industry)     m.business_profile.industry = meetingData.industry;

    // Record campaign
    if (meetingData.topic) {
        const existing = m.previous_campaigns.find(c => c.topic === meetingData.topic);
        if (!existing) {
            m.previous_campaigns.push({
                topic: meetingData.topic,
                date: new Date().toISOString(),
                meeting_id: meetingData.meeting_id,
            });
        }
        // Keep last 20 campaigns
        if (m.previous_campaigns.length > 20) m.previous_campaigns = m.previous_campaigns.slice(-20);
    }

    // Absorb validated strategies
    if (meetingData.validated_ideas?.length) {
        meetingData.validated_ideas.forEach(idea => {
            if (!m.key_strategies.includes(idea)) m.key_strategies.push(idea);
        });
        if (m.key_strategies.length > 30) m.key_strategies = m.key_strategies.slice(-30);
    }

    await saveMemory(workspaceId, m);
    return m;
}

async function updateAudienceInsight(workspaceId, insight) {
    const m = await getMemory(workspaceId);
    if (!m.target_audience.includes(insight)) {
        m.target_audience.push(insight);
        if (m.target_audience.length > 15) m.target_audience = m.target_audience.slice(-15);
        await saveMemory(workspaceId, m);
    }
}

function formatMemoryForPrompt(memory) {
    if (!memory) return '';
    const parts = ['WORKSPACE MEMORY (persistent context from past meetings):'];
    const biz = memory.business_profile;
    if (biz?.name) parts.push(`BUSINESS: ${biz.name}${biz.industry ? ` — ${biz.industry}` : ''}${biz.website ? ` (${biz.website})` : ''}`);
    if (memory.target_audience?.length)
        parts.push(`TARGET AUDIENCE:\n${memory.target_audience.map(a=>`• ${a}`).join('\n')}`);
    if (memory.brand_positioning)
        parts.push(`BRAND POSITIONING: ${memory.brand_positioning}`);
    if (memory.key_strategies?.length)
        parts.push(`PROVEN STRATEGIES:\n${memory.key_strategies.slice(-8).map(s=>`✓ ${s}`).join('\n')}`);
    if (memory.previous_campaigns?.length) {
        const recent = memory.previous_campaigns.slice(-5);
        parts.push(`RECENT MEETINGS:\n${recent.map(c=>`• ${c.topic} (${new Date(c.date).toLocaleDateString()})`).join('\n')}`);
    }
    if (memory.channel_performance && Object.keys(memory.channel_performance).length)
        parts.push(`CHANNEL NOTES:\n${Object.entries(memory.channel_performance).map(([ch,n])=>`• ${ch}: ${n}`).join('\n')}`);
    return parts.length > 1 ? parts.join('\n\n') : '';
}

module.exports = { getMemory, saveMemory, updateFromMeeting, updateAudienceInsight, formatMemoryForPrompt };
