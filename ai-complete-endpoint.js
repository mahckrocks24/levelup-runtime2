/**
 * POST /internal/ai/complete
 * 
 * Add this to your existing Express runtime (levelup-runtime2).
 * This endpoint proxies AI completion requests to DeepSeek.
 * 
 * USAGE: Add these lines to your main server file (e.g., index.js or server.js)
 * right after your existing route definitions.
 * 
 * REQUIRED ENV VAR: DEEPSEEK_API_KEY (already set in Railway)
 */

// --- Copy from here into your runtime's route file ---

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

app.post('/internal/ai/complete', async (req, res) => {
  // Verify secret
  const secret = req.headers['x-levelup-secret'] || req.headers['x-lu-secret'] || '';
  const expectedSecret = process.env.LEVELUP_SECRET || process.env.LU_SECRET || '';
  if (expectedSecret && secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY not configured in environment' });
  }

  const { model, messages, max_tokens, temperature, source } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages: messages,
        max_tokens: max_tokens || 4000,
        temperature: temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[AI Complete] DeepSeek error: ${response.status}`, errBody);
      return res.status(response.status).json({ 
        error: `DeepSeek API error: ${response.status}`,
        detail: errBody 
      });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';

    // Return in a format the WP plugin expects
    res.json({
      text: text,
      content: text,
      choices: data.choices,
      model: data.model,
      usage: data.usage,
    });

  } catch (err) {
    console.error('[AI Complete] Error:', err.message);
    res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
});

// --- End of endpoint code ---
