'use strict';

/**
 * LevelUp Builder AI — runtime handler
 * Receives builder commands and generates structured builder actions via DeepSeek.
 * Returns JSON action objects, never raw HTML.
 *
 * Endpoints:
 *   POST /internal/builder/ai-action     — process a natural language command on an existing page
 *   POST /internal/builder/generate-layout — generate a full page layout from a prompt
 */

const { callLLM } = require('./llm');

// ── Action types the AI can return ─────────────────────────────────────────
const BUILDER_ACTIONS = {
    ADD_SECTION:       'add_section',
    UPDATE_SECTION:    'update_section',
    DELETE_SECTION:    'delete_section',
    REORDER_SECTIONS:  'reorder_sections',
    ADD_COMPONENT:     'add_component',
    UPDATE_COMPONENT:  'update_component',
    DELETE_COMPONENT:  'delete_component',
    UPDATE_THEME:      'update_theme',
    GENERATE_LAYOUT:   'generate_layout',
};

// ── Component types vocabulary ─────────────────────────────────────────────
const COMPONENT_TYPES = [
    'heading', 'text', 'image', 'button', 'form', 'video',
    'icon', 'divider', 'spacer', 'html', 'list', 'card',
    'testimonial', 'pricing', 'faq', 'cta',
];

// ── Spacing tokens ─────────────────────────────────────────────────────────
const SPACING = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];

// ══════════════════════════════════════════════════════════════════════════
// HANDLER REGISTRATION — called from index.js
// ══════════════════════════════════════════════════════════════════════════
function registerBuilderRoutes(app) {
    app.post('/internal/builder/ai-action',   handleBuilderAiAction);
    app.post('/internal/builder/generate-layout', handleGenerateLayout);

    // Generic AI completion — used by WP builder AI (Arthur + AI panel)
    app.post('/internal/ai/complete', async (req, res) => {
        try {
            const { messages, max_tokens, temperature } = req.body;
            if (!messages || !Array.isArray(messages)) {
                return res.status(400).json({ error: 'messages array required' });
            }
            const result = await callLLM({
                messages,
                max_tokens: max_tokens || 4000,
                temperature: temperature ?? 0.7,
            });
            // callLLM returns { content, tool_calls, finish_reason, usage }
            const text = result.content || '';
            res.json({ text, content: text });
        } catch (err) {
            console.error('[ai/complete]', err.message);
            res.status(500).json({ error: err.message });
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 1 — AI Action (modify existing page)
// ══════════════════════════════════════════════════════════════════════════
async function handleBuilderAiAction(req, res) {
    try {
        const { command, page_title, sections, context, theme } = req.body || {};

        if (!command) return res.status(400).json({ error: 'command required' });

        const systemPrompt = buildActionSystemPrompt();
        const userPrompt   = buildActionUserPrompt({ command, page_title, sections, context, theme });

        const raw = await callLLM({ messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: userPrompt },
        ], max_tokens: 2000, temperature: 0.3 });

        const parsed = parseBuilderResponse(raw);
        return res.json({
            success:     true,
            actions:     parsed.actions || [],
            explanation: parsed.explanation || '',
            raw_intent:  command,
        });

    } catch (err) {
        console.error('[builder-ai] ai-action error:', err.message);
        return res.status(500).json({ error: 'AI action failed', detail: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER 2 — Generate Layout (new page from prompt)
// ══════════════════════════════════════════════════════════════════════════
async function handleGenerateLayout(req, res) {
    try {
        const { prompt, industry = '', style = 'dark', sections: numSections = 5 } = req.body || {};

        if (!prompt) return res.status(400).json({ error: 'prompt required' });

        const systemPrompt = buildLayoutSystemPrompt();
        const userPrompt   = buildLayoutUserPrompt({ prompt, industry, style, numSections });

        const raw = await callLLM({ messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: userPrompt },
        ], max_tokens: 4000, temperature: 0.5 });

        const layout = parseLayoutResponse(raw);
        return res.json({
            success: true,
            layout,
            prompt,
        });

    } catch (err) {
        console.error('[builder-ai] generate-layout error:', err.message);
        return res.status(500).json({ error: 'Layout generation failed', detail: err.message });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ══════════════════════════════════════════════════════════════════════════

function buildActionSystemPrompt() {
    return `You are the LevelUp Builder AI assistant. You modify website builder pages through structured JSON actions.

COMPONENT TYPES: ${COMPONENT_TYPES.join(', ')}
SPACING VALUES: ${SPACING.join(', ')}
COLUMN OPTIONS: 1, 2, 3, 4
BG TYPES: none, color, token, gradient, image
BUTTON VARIANTS: primary, secondary, outline, ghost

AVAILABLE ACTIONS:
- add_section: { type: "add_section", position: "start|end|after_index", columns: 1-4, label: "", layout: {}, components_per_container: [{ container_index: 0, components: [] }] }
- update_section: { type: "update_section", section_index: 0, layout: {}, styles: {} }
- delete_section: { type: "delete_section", section_index: 0 }
- reorder_sections: { type: "reorder_sections", new_order: [0, 2, 1] }
- add_component: { type: "add_component", section_index: 0, container_index: 0, component: { type: "", content: {}, styles: {}, tokens: {} } }
- update_component: { type: "update_component", section_index: 0, container_index: 0, component_index: 0, changes: { content: {}, styles: {}, tokens: {} } }
- delete_component: { type: "delete_component", section_index: 0, container_index: 0, component_index: 0 }
- update_theme: { type: "update_theme", tokens: { primary: "#...", font_heading: "..." } }

COMPONENT CONTENT SCHEMAS:
- heading: { text, level: 1-6 }
- text: { text }
- image: { src, alt, link }
- button: { label, href, variant, target }
- cta: { heading, subtext, buttons: [{ label, href, variant }] }
- testimonial: { quote, author, role, avatar }
- pricing: { name, price, period, features: [], cta: { label, href } }
- faq: { items: [{ question, answer }] }
- form: { fields: [{ id, type, label, placeholder, required }], submit_label, action }
- card: { image, heading, text, cta: { label, href } }
- list: { items: [{ text }], style: "ul|ol" }
- divider: { style: "solid|dashed|dotted", thickness, color }
- spacer: { height }
- video: { src, poster, autoplay, loop, muted }
- html: { code }

STYLE PROPERTIES: color, bg, font_size, font_weight, text_align, padding, margin, border_radius, border, shadow
TOKEN REFERENCES: Use "@primary", "@accent", "@s1", "@s2", "@t1", "@t2", "@border", "@radius_md" etc.

RULES:
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Always return an array of actions even for single changes
3. content values must match the schema for that component type
4. Prefer theme tokens (@primary) over hardcoded colours
5. Keep copy professional and on-brand

RESPONSE FORMAT:
{
  "explanation": "Brief plain English explanation of what you changed",
  "actions": [ ... array of action objects ... ]
}`;
}

function buildActionUserPrompt({ command, page_title, sections, context, theme }) {
    return `Page: "${page_title}"
Sections: ${sections}
Theme tokens: ${JSON.stringify(theme || {}, null, 2)}
${context && Object.keys(context).length ? 'Context: ' + JSON.stringify(context, null, 2) : ''}

Command: ${command}

Return the JSON actions to fulfill this command.`;
}

function buildLayoutSystemPrompt() {
    return `You are the LevelUp Builder AI. You generate complete page layouts as structured JSON.

COMPONENT TYPES: ${COMPONENT_TYPES.join(', ')}
COLUMN OPTIONS: 1, 2, 3, 4
BG TYPES: none, color, token, gradient
TOKEN REFERENCES: @primary, @accent, @s1, @s2, @t1, @t2, @border, @radius_md, @radius_lg

Generate professional, modern page layouts. Each section must have containers and components.

SECTION FORMAT:
{
  "label": "Section name",
  "layout": { "columns": 1-4, "gap": "md", "padding_y": "xl", "padding_x": "md", "full_width": false, "bg_type": "none|token|color", "bg_value": "" },
  "containers": [
    {
      "span": 1,
      "components": [ { "type": "...", "content": { ... }, "styles": { "text_align": "center" }, "tokens": {} } ]
    }
  ]
}

RULES:
1. Return ONLY valid JSON, no markdown
2. Generate professional placeholder content (no lorem ipsum)
3. First section is always a hero with headline, subtext, and CTA buttons
4. Include varied section types: features, testimonials, CTA, pricing or FAQ
5. Use theme tokens for colours instead of hardcoded values
6. Keep copy specific to the industry/purpose described

RESPONSE FORMAT:
{
  "title": "Page title",
  "meta_description": "SEO description",
  "sections": [ ... array of section objects ... ]
}`;
}

function buildLayoutUserPrompt({ prompt, industry, style, numSections }) {
    return `Generate a ${numSections}-section landing page for the following:

${prompt}
${industry ? 'Industry: ' + industry : ''}
Style: ${style}

Return the complete page layout JSON.`;
}

// ══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSERS
// ══════════════════════════════════════════════════════════════════════════

function parseBuilderResponse(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : JSON.stringify(raw));
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        const parsed = JSON.parse(clean);
        // Validate structure
        if (!parsed.actions || !Array.isArray(parsed.actions)) {
            return { actions: [], explanation: 'Could not parse builder actions.' };
        }
        // Validate each action has a known type
        const valid_types = Object.values(BUILDER_ACTIONS);
        const valid_actions = parsed.actions.filter(a => valid_types.includes(a.type));
        return {
            actions:     valid_actions,
            explanation: parsed.explanation || '',
        };
    } catch (e) {
        console.error('[builder-ai] parse error:', e.message, '\nRaw:', clean.slice(0, 500));
        return { actions: [], explanation: 'Failed to parse AI response.' };
    }
}

function parseLayoutResponse(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : JSON.stringify(raw));
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
        const parsed = JSON.parse(clean);
        if (!parsed.sections || !Array.isArray(parsed.sections)) {
            throw new Error('sections array missing');
        }
        // Ensure every section has minimum required fields
        parsed.sections = parsed.sections.map((sec, i) => ({
            label:      sec.label || `Section ${i + 1}`,
            layout:     sec.layout || { columns: 1, gap: 'md', padding_y: 'xl', padding_x: 'md', full_width: false, bg_type: 'none', bg_value: '' },
            containers: (sec.containers || [{ span: 1, components: [] }]).map(con => ({
                span:       con.span || 1,
                components: (con.components || []).map(cmp => ({
                    type:    cmp.type || 'text',
                    content: cmp.content || {},
                    styles:  cmp.styles || {},
                    tokens:  cmp.tokens || {},
                })),
            })),
        }));
        return parsed;
    } catch (e) {
        console.error('[builder-ai] layout parse error:', e.message);
        return {
            title:    'Generated Page',
            sections: [{
                label: 'Hero',
                layout: { columns: 1, gap: 'md', padding_y: 'xl', padding_x: 'md', full_width: false, bg_type: 'none', bg_value: '' },
                containers: [{ span: 1, components: [{ type: 'cta', content: { heading: 'Welcome', subtext: 'Generated content coming soon.', buttons: [{ label: 'Get Started', href: '#', variant: 'primary' }] }, styles: { text_align: 'center' }, tokens: {} }] }],
            }],
        };
    }
}

module.exports = { registerBuilderRoutes, BUILDER_ACTIONS, COMPONENT_TYPES };
