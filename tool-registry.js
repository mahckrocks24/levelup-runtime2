'use strict';

/**
 * LevelUp Tool Registry — Phase 1 (flat single-file version)
 *
 * Domain structure is maintained via the `domain` property on each tool.
 * When Phase 2 splits into 3 plugins, this file splits into separate domain
 * files — no logic changes needed, just reorganisation.
 *
 * Domains registered here: seo (15 tools)
 * Domains stubbed for Phase 3+: crm, marketing, social, calendar, builder, governance
 */

// ── Lazy ref to capability-map to avoid circular dep ──────────────────────
let _capMap = null;
function capMap() {
    if (!_capMap) _capMap = require('./capability-map');
    return _capMap;
}

// ══════════════════════════════════════════════════════════════════════════
// SEO DOMAIN — 15 verified tools (source-confirmed v5.9.1)
// All endpoints confirmed live: 401/403 on health check = exists, auth ok
// ══════════════════════════════════════════════════════════════════════════
const SEO_TOOLS = {

    // ── SERP & Analysis ────────────────────────────────────────────────────

    serp_analysis: {
        id:               'serp_analysis',
        domain:           'seo',
        name:             'SERP Analysis',
        description:      'Fetch live SERP competitor data for a keyword. Returns top-ranking pages, competitor content, and a serp_run_id for use in ai_report.',
        wp_path:          '/lugs/v1/serp-analysis',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'post_id', 'location', 'language'],
        query_params:     [],
        params: {
            keyword:  { type: 'string',  required: true,  description: 'Target keyword to analyse SERP for' },
            post_id:  { type: 'integer', required: false, description: 'Optional post ID to associate results with' },
            location: { type: 'string',  required: false, description: 'Location code for localised results' },
            language: { type: 'string',  required: false, description: 'Language code, default en' },
        },
        returns:          '{ success, results[], result_count, serp_run_id }',
        requires_approval: false,
        allowed_agents:   ['james'],
    },

    ai_report: {
        id:               'ai_report',
        domain:           'seo',
        name:             'AI Content Intelligence Report',
        description:      'Generate a full AI content intelligence report for a post. Analyses GSC data, competitor content, and returns strategic recommendations. Run serp_analysis first to get serp_run_id.',
        wp_path:          '/lugs/v1/ai-report',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'serp_run_id'],
        query_params:     [],
        params: {
            post_id:     { type: 'integer', required: true,  description: 'WordPress post ID to generate report for' },
            keyword:     { type: 'string',  required: true,  description: 'Focus keyword for the report' },
            serp_run_id: { type: 'integer', required: false, description: 'serp_run_id from a prior serp_analysis call' },
        },
        returns:          '{ success, report, cached, timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya'],
    },

    deep_audit: {
        id:               'deep_audit',
        domain:           'seo',
        name:             'Deep Content Audit',
        description:      'Run a deep SEO audit on a specific post. Pulls GSC data, audit breakdown, competitor SERP, and generates a comprehensive AI analysis report.',
        wp_path:          '/lugs/v1/deep-audit',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword'],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true,  description: 'WordPress post ID to audit' },
            keyword: { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
        },
        returns:          '{ success, report, competitors[], timestamp }',
        requires_approval: false,
        allowed_agents:   ['james', 'alex'],
    },

    ai_status: {
        id:               'ai_status',
        domain:           'seo',
        name:             'AI Status Check',
        description:      'Check whether the AI engine (LevelUp Core + DeepSeek) is configured and ready. Use this before running AI-dependent tools.',
        wp_path:          '/lugs/v1/ai-status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ core_active, ai_ready }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    // ── Content Generation ─────────────────────────────────────────────────

    improve_draft: {
        id:               'improve_draft',
        domain:           'seo',
        name:             'Improve Draft',
        description:      'Generate an AI-improved version of an existing post draft. Requires a prior AI report to exist for this post. Returns improved content with SEO enhancements.',
        wp_path:          '/lugs/v1/ai-draft',
        method:           'POST',
        url_params:       [],
        body_params:      ['post_id', 'keyword', 'ai_report_id'],
        query_params:     [],
        params: {
            post_id:      { type: 'integer', required: true,  description: 'WordPress post ID to improve' },
            keyword:      { type: 'string',  required: false, description: 'Focus keyword — auto-resolved from post meta if omitted' },
            ai_report_id: { type: 'integer', required: false, description: 'Specific AI report ID. Uses latest if omitted.' },
        },
        returns:          '{ success, draft_id, draft_content, created_at, cached }',
        requires_approval: true,
        approval_preview: 'Generate an improved draft for post #{post_id} targeting "{keyword}". Creates a new draft version — does not modify the live post.',
        allowed_agents:   ['priya'],
    },

    write_article: {
        id:               'write_article',
        domain:           'seo',
        name:             'Write SEO Article',
        description:      'Generate a full SEO-optimised article and save it as a WordPress draft post. Auto-selects the best keyword from site audit data if none given. Returns the edit URL.',
        wp_path:          '/lugs/v1/generate-seo-article',
        method:           'POST',
        url_params:       [],
        body_params:      ['keyword', 'context'],
        query_params:     [],
        params: {
            keyword: { type: 'string', required: false, description: 'Target keyword — auto-selected from site audit if omitted' },
            context: { type: 'string', required: false, description: 'Additional context or instructions for the article' },
        },
        returns:          '{ success, keyword, post_id, title, edit_url, preview_url, tokens_used, message }',
        requires_approval: true,
        approval_preview: 'Write and save a new SEO article{keyword ? \' targeting "\' + keyword + \'"\' : \' (keyword auto-selected)\'}. Creates a new WordPress draft post.',
        allowed_agents:   ['priya'],
    },

    // ── Internal Links ─────────────────────────────────────────────────────

    link_suggestions: {
        id:               'link_suggestions',
        domain:           'seo',
        name:             'Link Suggestions',
        description:      'Get internal link suggestions for a specific post. Returns up to 5 relevant target pages with relevance scores.',
        wp_path:          '/lugs/v1/link-suggestions/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get link suggestions for' },
        },
        returns:          '[{ id, target_post_id, target_title, target_url, relevance_score, status }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    insert_link: {
        id:               'insert_link',
        domain:           'seo',
        name:             'Insert Internal Link',
        description:      'Insert a suggested internal link into post content. Finds matching anchor text and wraps it with the target link. Modifies live post content.',
        wp_path:          '/lugs/v1/link-suggestions/:id/insert',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID from link_suggestions result' },
        },
        returns:          '{ success } or { success: false, message }',
        requires_approval: true,
        approval_preview: 'Insert internal link suggestion #{id} into live post content. This directly modifies the post.',
        allowed_agents:   ['alex'],
    },

    dismiss_link: {
        id:               'dismiss_link',
        domain:           'seo',
        name:             'Dismiss Link Suggestion',
        description:      'Mark an internal link suggestion as rejected so it no longer appears.',
        wp_path:          '/lugs/v1/link-suggestions/:id/dismiss',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Suggestion ID to dismiss' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Outbound Links ─────────────────────────────────────────────────────

    outbound_links: {
        id:               'outbound_links',
        domain:           'seo',
        name:             'Outbound Links',
        description:      'Get all outbound (external) links for a post. Returns each link with HTTP status, anchor text, and rel attributes.',
        wp_path:          '/lugs/v1/outbound-links/:post_id',
        method:           'GET',
        url_params:       ['post_id'],
        body_params:      [],
        query_params:     [],
        params: {
            post_id: { type: 'integer', required: true, description: 'WordPress post ID to get outbound links for' },
        },
        returns:          '[{ id, outbound_url, outbound_domain, anchor_text, rel_nofollow, http_status, recommended }]',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    check_outbound: {
        id:               'check_outbound',
        domain:           'seo',
        name:             'Check Outbound Link Health',
        description:      'Run a live health scan of all outbound links in a post. Checks each external URL for 404s, redirects, and errors.',
        wp_path:          '/lugs/v1/outbound-links/:id/check',
        method:           'POST',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Post ID to scan outbound links for' },
        },
        returns:          '{ post_id, total, broken, redirects, links[{ url, anchor, status, ok, fix }] }',
        requires_approval: false,
        allowed_agents:   ['alex'],
    },

    // ── Autonomous Agent ───────────────────────────────────────────────────

    autonomous_goal: {
        id:               'autonomous_goal',
        domain:           'seo',
        name:             'Submit Autonomous Goal',
        description:      'Submit a natural language goal to the SEO agent system. The agent will autonomously break it into tasks and execute them in the background.',
        wp_path:          '/lugs/v1/agent/goal',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal'],
        query_params:     [],
        params: {
            goal: { type: 'string', required: true, description: 'Natural language goal for the autonomous agent' },
        },
        returns:          '{ success, goal_id }',
        requires_approval: true,
        approval_preview: 'Submit autonomous goal to the SEO agent: "{goal}". This will run background tasks on the site.',
        allowed_agents:   ['dmm'],
    },

    agent_status: {
        id:               'agent_status',
        domain:           'seo',
        name:             'Agent Goal Status',
        description:      'Get the current progress of an autonomous agent goal and its sub-tasks.',
        wp_path:          '/lugs/v1/agent/status',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['goal_id'],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID returned from autonomous_goal' },
        },
        returns:          '{ success, goal, tasks[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    list_goals: {
        id:               'list_goals',
        domain:           'seo',
        name:             'List Agent Goals',
        description:      'List all autonomous agent goals and their current statuses.',
        wp_path:          '/lugs/v1/agent/goals',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          '{ success, goals[] }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },

    pause_goal: {
        id:               'pause_goal',
        domain:           'seo',
        name:             'Pause Agent Goal',
        description:      'Pause a running autonomous agent goal.',
        wp_path:          '/lugs/v1/agent/pause',
        method:           'POST',
        url_params:       [],
        body_params:      ['goal_id'],
        query_params:     [],
        params: {
            goal_id: { type: 'integer', required: true, description: 'Goal ID to pause' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['james', 'priya', 'alex', 'dmm', 'marcus', 'elena'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// CRM DOMAIN — 8 tools (lucrm/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const CRM_TOOLS = {

    create_lead: {
        id:               'create_lead',
        domain:           'crm',
        name:             'Create Lead',
        description:      'Create a new lead in the CRM. Sets name, email, phone, company, source, and optionally assigns to a pipeline stage and agent.',
        wp_path:          '/lucrm/v1/leads',
        method:           'POST',
        url_params:       [],
        body_params:      ['name', 'email', 'phone', 'company', 'source', 'pipeline_stage_id', 'assigned_agent', 'score'],
        query_params:     [],
        params: {
            name:              { type: 'string',  required: true,  description: 'Full name of the lead' },
            email:             { type: 'string',  required: false, description: 'Email address' },
            phone:             { type: 'string',  required: false, description: 'Phone number' },
            company:           { type: 'string',  required: false, description: 'Company name' },
            source:            { type: 'string',  required: false, description: 'Lead source (e.g. website, referral, social)' },
            pipeline_stage_id: { type: 'integer', required: false, description: 'Pipeline stage ID to place lead in' },
            assigned_agent:    { type: 'string',  required: false, description: 'Agent slug to assign lead to (e.g. elena)' },
            score:             { type: 'integer', required: false, description: 'Lead score 0-100' },
        },
        returns:          '{ success, lead }',
        requires_approval: true,
        approval_preview: 'Create a new CRM lead: "{name}" ({email}). Adds to the pipeline.',
        allowed_agents:   ['elena', 'dmm'],
    },

    get_lead: {
        id:               'get_lead',
        domain:           'crm',
        name:             'Get Lead',
        description:      'Retrieve full details for a lead including recent activities and notes.',
        wp_path:          '/lucrm/v1/leads/:id',
        method:           'GET',
        url_params:       ['id'],
        body_params:      [],
        query_params:     [],
        params: {
            id: { type: 'integer', required: true, description: 'Lead ID to retrieve' },
        },
        returns:          'lead object with activities[] and notes[]',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm', 'james'],
    },

    update_lead: {
        id:               'update_lead',
        domain:           'crm',
        name:             'Update Lead',
        description:      'Update fields on an existing lead. Only provided fields are changed.',
        wp_path:          '/lucrm/v1/leads/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['name', 'email', 'phone', 'company', 'status', 'assigned_agent', 'score'],
        query_params:     [],
        params: {
            id:             { type: 'integer', required: true,  description: 'Lead ID to update' },
            name:           { type: 'string',  required: false, description: 'Updated name' },
            email:          { type: 'string',  required: false, description: 'Updated email' },
            status:         { type: 'string',  required: false, description: 'active | archived | lost' },
            assigned_agent: { type: 'string',  required: false, description: 'Reassign to agent slug' },
            score:          { type: 'integer', required: false, description: 'Updated lead score' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    list_leads: {
        id:               'list_leads',
        domain:           'crm',
        name:             'List Leads',
        description:      'List leads with optional filters by status, pipeline stage, assigned agent, or search term.',
        wp_path:          '/lucrm/v1/leads',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['status', 'stage', 'agent', 'search', 'limit', 'offset'],
        params: {
            status: { type: 'string',  required: false, description: 'Filter by status: active | archived | lost' },
            stage:  { type: 'integer', required: false, description: 'Filter by pipeline stage ID' },
            agent:  { type: 'string',  required: false, description: 'Filter by assigned agent slug' },
            search: { type: 'string',  required: false, description: 'Search name, email, or company' },
            limit:  { type: 'integer', required: false, description: 'Max results (default 50, max 200)' },
            offset: { type: 'integer', required: false, description: 'Pagination offset' },
        },
        returns:          '{ leads[], total, limit, offset }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm', 'james'],
    },

    move_lead: {
        id:               'move_lead',
        domain:           'crm',
        name:             'Move Lead to Stage',
        description:      'Move a lead to a different pipeline stage. Automatically logs an activity.',
        wp_path:          '/lucrm/v1/leads/:id/move',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['stage_id'],
        query_params:     [],
        params: {
            id:       { type: 'integer', required: true, description: 'Lead ID to move' },
            stage_id: { type: 'integer', required: true, description: 'Target pipeline stage ID' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    log_activity: {
        id:               'log_activity',
        domain:           'crm',
        name:             'Log Activity',
        description:      'Log an activity against a lead (call, email, meeting, or note).',
        wp_path:          '/lucrm/v1/leads/:id/activities',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['type', 'description', 'created_by'],
        query_params:     [],
        params: {
            id:          { type: 'integer', required: true,  description: 'Lead ID to log activity for' },
            type:        { type: 'string',  required: true,  description: 'call | email | meeting | note' },
            description: { type: 'string',  required: true,  description: 'Activity description' },
            created_by:  { type: 'string',  required: false, description: 'Agent slug who performed this activity' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    add_note: {
        id:               'add_note',
        domain:           'crm',
        name:             'Add Note to Lead',
        description:      'Add a structured note to a lead record.',
        wp_path:          '/lucrm/v1/leads/:id/notes',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['note', 'created_by'],
        query_params:     [],
        params: {
            id:         { type: 'integer', required: true,  description: 'Lead ID to add note to' },
            note:       { type: 'string',  required: true,  description: 'Note content' },
            created_by: { type: 'string',  required: false, description: 'Agent slug authoring the note' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['elena', 'dmm'],
    },

    enroll_sequence: {
        id:               'enroll_sequence',
        domain:           'crm',
        name:             'Enroll Lead in Sequence',
        description:      'Enroll a lead in an email sequence. The sequence must already exist. Prevents duplicate active enrollments.',
        wp_path:          '/lucrm/v1/sequences/:id/enroll',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['lead_id'],
        query_params:     [],
        params: {
            id:      { type: 'integer', required: true, description: 'Sequence ID to enroll the lead in' },
            lead_id: { type: 'integer', required: true, description: 'Lead ID to enroll' },
        },
        returns:          '{ success, enrollment_id }',
        requires_approval: true,
        approval_preview: 'Enroll lead #{lead_id} in email sequence #{id}. Will begin automated email steps.',
        allowed_agents:   ['elena', 'dmm'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// MARKETING DOMAIN — 7 tools (lumkt/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const MARKETING_TOOLS = {

    create_campaign: {
        id:               'create_campaign',
        domain:           'marketing',
        name:             'Create Campaign',
        description:      'Create a new marketing campaign. Types: email, social, content, ads.',
        wp_path:          '/lumkt/v1/campaigns',
        method:           'POST',
        url_params:       [],
        body_params:      ['name', 'type', 'status', 'target_audience', 'start_date', 'end_date'],
        query_params:     [],
        params: {
            name:            { type: 'string', required: true,  description: 'Campaign name' },
            type:            { type: 'string', required: false, description: 'email | social | content | ads' },
            status:          { type: 'string', required: false, description: 'draft | active | paused | completed' },
            target_audience: { type: 'string', required: false, description: 'Description of target audience' },
            start_date:      { type: 'string', required: false, description: 'Start date YYYY-MM-DD' },
            end_date:        { type: 'string', required: false, description: 'End date YYYY-MM-DD' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create a new {type} campaign: "{name}". Status: {status}.',
        allowed_agents:   ['priya', 'dmm'],
    },

    update_campaign: {
        id:               'update_campaign',
        domain:           'marketing',
        name:             'Update Campaign',
        description:      'Update an existing campaign. Only provided fields are changed.',
        wp_path:          '/lumkt/v1/campaigns/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['name', 'status', 'target_audience', 'start_date', 'end_date'],
        query_params:     [],
        params: {
            id:     { type: 'integer', required: true,  description: 'Campaign ID to update' },
            name:   { type: 'string',  required: false, description: 'Updated name' },
            status: { type: 'string',  required: false, description: 'draft | active | paused | completed | archived' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['priya', 'dmm'],
    },

    list_campaigns: {
        id:               'list_campaigns',
        domain:           'marketing',
        name:             'List Campaigns',
        description:      'List all campaigns, optionally filtered by type or status.',
        wp_path:          '/lumkt/v1/campaigns',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['type', 'status'],
        params: {
            type:   { type: 'string', required: false, description: 'Filter by type: email | social | content | ads' },
            status: { type: 'string', required: false, description: 'Filter by status' },
        },
        returns:          'campaign[]',
        requires_approval: false,
        allowed_agents:   ['priya', 'dmm', 'james', 'marcus', 'elena'],
    },

    create_template: {
        id:               'create_template',
        domain:           'marketing',
        name:             'Create Email Template',
        description:      'Create a reusable email template with subject, HTML body, and variable placeholders (e.g. {{lead_name}}).',
        wp_path:          '/lumkt/v1/templates',
        method:           'POST',
        url_params:       [],
        body_params:      ['name', 'subject', 'body', 'variables'],
        query_params:     [],
        params: {
            name:      { type: 'string', required: true,  description: 'Template name' },
            subject:   { type: 'string', required: true,  description: 'Email subject line' },
            body:      { type: 'string', required: true,  description: 'HTML email body' },
            variables: { type: 'array',  required: false, description: 'Variable names used in template e.g. ["lead_name","company"]' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['priya', 'dmm'],
    },

    list_templates: {
        id:               'list_templates',
        domain:           'marketing',
        name:             'List Email Templates',
        description:      'List all email templates for the workspace.',
        wp_path:          '/lumkt/v1/templates',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     [],
        params:           {},
        returns:          'template[] (id, name, subject, variables_json, created_at — no body for performance)',
        requires_approval: false,
        allowed_agents:   ['priya', 'dmm', 'elena'],
    },

    create_automation: {
        id:               'create_automation',
        domain:           'marketing',
        name:             'Create Automation Sequence',
        description:      'Create a new automation workflow sequence with a trigger type.',
        wp_path:          '/lumkt/v1/sequences',
        method:           'POST',
        url_params:       [],
        body_params:      ['name', 'trigger_type'],
        query_params:     [],
        params: {
            name:         { type: 'string', required: true,  description: 'Sequence name' },
            trigger_type: { type: 'string', required: false, description: 'What triggers this sequence (e.g. lead_created, form_submit)' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create automation sequence "{name}" triggered by "{trigger_type}".',
        allowed_agents:   ['priya', 'dmm'],
    },

    record_metric: {
        id:               'record_metric',
        domain:           'marketing',
        name:             'Record Campaign Metric',
        description:      'Record a metric data point for a campaign. Metrics: opens, clicks, conversions, unsubscribes.',
        wp_path:          '/lumkt/v1/campaigns/:id/analytics',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['metric_type', 'metric_value'],
        query_params:     [],
        params: {
            id:           { type: 'integer', required: true,  description: 'Campaign ID' },
            metric_type:  { type: 'string',  required: true,  description: 'opens | clicks | conversions | unsubscribes' },
            metric_value: { type: 'number',  required: false, description: 'Numeric value (default 1)' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['priya', 'dmm', 'james'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// SOCIAL DOMAIN — 6 tools (lusocial/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const SOCIAL_TOOLS = {

    create_post: {
        id:               'create_post',
        domain:           'social',
        name:             'Create Social Post',
        description:      'Create a social media post as a draft. Platform can be any string: linkedin, facebook, instagram, x, tiktok, google_business, or custom.',
        wp_path:          '/lusocial/v1/posts',
        method:           'POST',
        url_params:       [],
        body_params:      ['content', 'platform', 'media_url', 'scheduled_at', 'status'],
        query_params:     [],
        params: {
            content:      { type: 'string', required: true,  description: 'Post copy/content' },
            platform:     { type: 'string', required: true,  description: 'Target platform: linkedin | facebook | instagram | x | tiktok | google_business' },
            media_url:    { type: 'string', required: false, description: 'Media attachment URL' },
            scheduled_at: { type: 'string', required: false, description: 'Schedule datetime (ISO 8601). Leave empty for draft.' },
            status:       { type: 'string', required: false, description: 'draft | scheduled | published. Default: draft' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['marcus', 'dmm', 'priya'],
    },

    schedule_post: {
        id:               'schedule_post',
        domain:           'social',
        name:             'Schedule Social Post',
        description:      'Update a draft post to scheduled status with a specific publish datetime.',
        wp_path:          '/lusocial/v1/posts/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['scheduled_at', 'status'],
        query_params:     [],
        params: {
            id:           { type: 'integer', required: true,  description: 'Post ID to schedule' },
            scheduled_at: { type: 'string',  required: true,  description: 'Publish datetime ISO 8601' },
        },
        returns:          '{ success }',
        requires_approval: true,
        approval_preview: 'Schedule post #{id} to publish at {scheduled_at} on the connected platform.',
        allowed_agents:   ['marcus', 'dmm'],
    },

    list_posts: {
        id:               'list_posts',
        domain:           'social',
        name:             'List Social Posts',
        description:      'List social posts with optional filters by platform or status.',
        wp_path:          '/lusocial/v1/posts',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['platform', 'status', 'limit', 'offset'],
        params: {
            platform: { type: 'string',  required: false, description: 'Filter by platform' },
            status:   { type: 'string',  required: false, description: 'Filter by status: draft | scheduled | published | failed' },
            limit:    { type: 'integer', required: false, description: 'Max results (default 50)' },
            offset:   { type: 'integer', required: false, description: 'Pagination offset' },
        },
        returns:          '{ posts[], total, limit, offset }',
        requires_approval: false,
        allowed_agents:   ['marcus', 'dmm', 'priya', 'james'],
    },

    update_post: {
        id:               'update_post',
        domain:           'social',
        name:             'Update Social Post',
        description:      'Edit content, platform, media, or status of an existing post.',
        wp_path:          '/lusocial/v1/posts/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['content', 'platform', 'media_url', 'status'],
        query_params:     [],
        params: {
            id:       { type: 'integer', required: true,  description: 'Post ID to update' },
            content:  { type: 'string',  required: false, description: 'Updated post copy' },
            platform: { type: 'string',  required: false, description: 'Updated platform' },
            status:   { type: 'string',  required: false, description: 'Updated status' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['marcus', 'dmm', 'priya'],
    },

    get_queue: {
        id:               'get_queue',
        domain:           'social',
        name:             'Get Scheduled Queue',
        description:      'Get all scheduled posts queued for publishing. Optionally filter by an until datetime.',
        wp_path:          '/lusocial/v1/queue',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['until'],
        params: {
            until: { type: 'string', required: false, description: 'Show queue until this datetime (ISO 8601). Defaults to next 7 days.' },
        },
        returns:          '{ queue[], count, until }',
        requires_approval: false,
        allowed_agents:   ['marcus', 'dmm', 'james'],
    },

    record_social_analytics: {
        id:               'record_social_analytics',
        domain:           'social',
        name:             'Record Social Analytics',
        description:      'Record engagement metrics for a published post: reach, impressions, likes, comments, shares.',
        wp_path:          '/lusocial/v1/posts/:id/analytics',
        method:           'POST',
        url_params:       ['id'],
        body_params:      ['platform', 'reach', 'impressions', 'engagement', 'likes', 'comments', 'shares'],
        query_params:     [],
        params: {
            id:          { type: 'integer', required: true,  description: 'Post ID to record analytics for' },
            platform:    { type: 'string',  required: false, description: 'Platform these metrics are from' },
            reach:       { type: 'integer', required: false, description: 'Unique accounts reached' },
            impressions: { type: 'integer', required: false, description: 'Total impressions' },
            likes:       { type: 'integer', required: false, description: 'Likes/reactions' },
            comments:    { type: 'integer', required: false, description: 'Comment count' },
            shares:      { type: 'integer', required: false, description: 'Share/repost count' },
        },
        returns:          '{ success, id }',
        requires_approval: false,
        allowed_agents:   ['marcus', 'dmm'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// CALENDAR DOMAIN — 5 tools (lucal/v1/*)
// ══════════════════════════════════════════════════════════════════════════
const CALENDAR_TOOLS = {

    create_event: {
        id:               'create_event',
        domain:           'calendar',
        name:             'Create Event',
        description:      'Create a calendar event. Types: meeting, task, call, booking. Can be linked to a CRM lead.',
        wp_path:          '/lucal/v1/events',
        method:           'POST',
        url_params:       [],
        body_params:      ['title', 'type', 'start_time', 'end_time', 'assigned_to', 'linked_lead_id'],
        query_params:     [],
        params: {
            title:          { type: 'string',  required: true,  description: 'Event title' },
            type:           { type: 'string',  required: false, description: 'meeting | task | call | booking. Default: meeting' },
            start_time:     { type: 'string',  required: true,  description: 'Start datetime (YYYY-MM-DD HH:MM:SS)' },
            end_time:       { type: 'string',  required: true,  description: 'End datetime (YYYY-MM-DD HH:MM:SS)' },
            assigned_to:    { type: 'string',  required: false, description: 'Agent slug or person name' },
            linked_lead_id: { type: 'integer', required: false, description: 'CRM lead ID to associate this event with' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create a {type} event: "{title}" on {start_time}.',
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'marcus', 'alex'],
    },

    list_events: {
        id:               'list_events',
        domain:           'calendar',
        name:             'List Events',
        description:      'List calendar events, optionally filtered by date range, type, or assigned agent.',
        wp_path:          '/lucal/v1/events',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['from', 'to', 'type', 'assigned_to'],
        params: {
            from:        { type: 'string', required: false, description: 'Filter events from this datetime' },
            to:          { type: 'string', required: false, description: 'Filter events until this datetime' },
            type:        { type: 'string', required: false, description: 'Filter by type: meeting | task | call | booking' },
            assigned_to: { type: 'string', required: false, description: 'Filter by assigned agent/person' },
        },
        returns:          'event[]',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'marcus', 'alex'],
    },

    update_event: {
        id:               'update_event',
        domain:           'calendar',
        name:             'Update Event',
        description:      'Update an existing calendar event. Only provided fields are changed.',
        wp_path:          '/lucal/v1/events/:id',
        method:           'PUT',
        url_params:       ['id'],
        body_params:      ['title', 'event_type', 'start_time', 'end_time', 'assigned_to'],
        query_params:     [],
        params: {
            id:         { type: 'integer', required: true,  description: 'Event ID to update' },
            title:      { type: 'string',  required: false, description: 'Updated title' },
            start_time: { type: 'string',  required: false, description: 'Updated start datetime' },
            end_time:   { type: 'string',  required: false, description: 'Updated end datetime' },
        },
        returns:          '{ success }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'marcus', 'alex'],
    },

    check_availability: {
        id:               'check_availability',
        domain:           'calendar',
        name:             'Check Availability',
        description:      'Check working hours, blackout dates, existing events, and available booking slots for a given date.',
        wp_path:          '/lucal/v1/availability',
        method:           'GET',
        url_params:       [],
        body_params:      [],
        query_params:     ['date'],
        params: {
            date: { type: 'string', required: false, description: 'Date to check (YYYY-MM-DD). Defaults to today.' },
        },
        returns:          '{ date, is_working_day, is_blackout, working_hours, events[], available_slots[] }',
        requires_approval: false,
        allowed_agents:   ['dmm', 'elena', 'james', 'priya', 'marcus', 'alex'],
    },

    create_booking_slot: {
        id:               'create_booking_slot',
        domain:           'calendar',
        name:             'Create Booking Slot',
        description:      'Create a client-facing booking slot for a specific time window.',
        wp_path:          '/lucal/v1/booking-slots',
        method:           'POST',
        url_params:       [],
        body_params:      ['start_time', 'end_time', 'status'],
        query_params:     [],
        params: {
            start_time: { type: 'string', required: true,  description: 'Slot start datetime' },
            end_time:   { type: 'string', required: true,  description: 'Slot end datetime' },
            status:     { type: 'string', required: false, description: 'available | booked | blocked. Default: available' },
        },
        returns:          '{ success, id }',
        requires_approval: true,
        approval_preview: 'Create a booking slot from {start_time} to {end_time}.',
        allowed_agents:   ['dmm', 'elena'],
    },
};

// ══════════════════════════════════════════════════════════════════════════
// FUTURE DOMAINS — Phase 4+ stubs
// ══════════════════════════════════════════════════════════════════════════
const BUILDER_TOOLS    = {}; // Phase 4
const GOVERNANCE_TOOLS = {}; // Phase 4

// ── Merge all domains ──────────────────────────────────────────────────────
const ALL_TOOLS = Object.assign(
    {},
    SEO_TOOLS,
    CRM_TOOLS,
    MARKETING_TOOLS,
    SOCIAL_TOOLS,
    CALENDAR_TOOLS,
    BUILDER_TOOLS,
    GOVERNANCE_TOOLS
);

// ── Core API ───────────────────────────────────────────────────────────────

function getTool(toolId) {
    return ALL_TOOLS[toolId] || null;
}

function listAll() {
    return Object.values(ALL_TOOLS);
}

function listByDomain(domain) {
    return Object.values(ALL_TOOLS).filter(t => t.domain === domain);
}

function getToolsForAgent(agentId) {
    const permitted = capMap().getToolIds(agentId);
    return permitted.map(id => ALL_TOOLS[id]).filter(Boolean);
}

function agentCanUseTool(agentId, toolId) {
    const tool = getTool(toolId);
    if (!tool) return false;
    return tool.allowed_agents.includes(agentId);
}

function buildToolPromptBlock(agentId) {
    const tools = getToolsForAgent(agentId);
    if (!tools.length) return '';

    const defs = tools.map(t => {
        const paramLines = Object.entries(t.params).map(([k, v]) =>
            `      ${k} (${v.type}${v.required ? ', REQUIRED' : ', optional'}): ${v.description}`
        ).join('\n');
        const approvalNote = t.requires_approval
            ? '\n  ⚠️  REQUIRES HUMAN APPROVAL before execution.'
            : '\n  ✓  Executes immediately.';
        return [
            `TOOL: ${t.id}`,
            `Name: ${t.name}`,
            `Description: ${t.description}`,
            paramLines ? `Parameters:\n${paramLines}` : 'Parameters: none',
            `Returns: ${t.returns}`,
            approvalNote,
        ].join('\n');
    }).join('\n\n');

    return `
═══════════════════════════════════════════════
REAL TOOLS AVAILABLE TO YOU
═══════════════════════════════════════════════
You have access to the following tools that return REAL data from the client's live systems.
When a tool would meaningfully improve your response with real data, use it. Do NOT hallucinate numbers or results.

${defs}

═══════════════════════════════════════════════
HOW TO CALL A TOOL
═══════════════════════════════════════════════
Output ONLY this block on that turn (nothing else):

<tool_call>
{
  "tool": "tool_id_here",
  "params": { "param_name": "value" }
}
</tool_call>

Rules:
- Call ONE tool at a time
- Only call when real data adds genuine value to your response
- After the result is returned, use it in your final response
- For tools marked REQUIRES HUMAN APPROVAL: propose the action, then call the tool — human approves/rejects before it executes
- Never fabricate tool results. If a tool fails, acknowledge it and continue with best available knowledge
`;
}

function getStats() {
    const tools = Object.values(ALL_TOOLS);
    const byDomain = {};
    for (const t of tools) byDomain[t.domain] = (byDomain[t.domain] || 0) + 1;
    return { total: tools.length, byDomain, requiresApproval: tools.filter(t => t.requires_approval).length };
}

module.exports = {
    getTool,
    listAll,
    listByDomain,
    getToolsForAgent,
    agentCanUseTool,
    buildToolPromptBlock,
    getStats,
    TOOLS: ALL_TOOLS, // legacy compat
};
