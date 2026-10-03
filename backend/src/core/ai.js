const config = require('../config');

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const FALLBACK_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
let activeModel = config.groqModel || FALLBACK_MODELS[0];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(usage, purpose, status, started, tokens = {}, modelName = activeModel) {
  const promptTokens = tokens.prompt_tokens || 0;
  const completionTokens = tokens.completion_tokens || 0;
  usage.calls.push({
    purpose,
    model: modelName,
    status,
    durationMs: Date.now() - started,
    promptTokens,
    completionTokens,
  });
  usage.promptTokens += promptTokens;
  usage.completionTokens += completionTokens;
}

async function once(usage, purpose, maxTokens, messages) {
  usage.callCount += 1;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.groqTimeoutMs);
  let recorded = false;
  const currentModel = activeModel;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: currentModel,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages,
      }),
    });
    const data = await response.json().catch(() => ({}));
    record(usage, purpose, response.status, started, data.usage, currentModel);
    recorded = true;
    if (response.status === 401 || response.status === 403) {
      return { error: new Error('Groq authentication failed') };
    }
    if (response.status === 400 || response.status === 404) {
      // Switch to next fallback model if current model rejected request or is missing
      const nextFallback = FALLBACK_MODELS.find((m) => m !== currentModel);
      if (nextFallback) {
        activeModel = nextFallback;
        return {
          retry: true,
          wait: 300,
          error: new Error(`Model ${currentModel} returned ${response.status} (${data.error?.message || ''}), retrying with ${nextFallback}`),
        };
      }
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        retry: true,
        wait: Math.min(Number(response.headers.get('retry-after') || 1) * 1000, 5000),
        error: new Error(`Groq rate limit or server error (${response.status})`),
      };
    }
    if (!response.ok) {
      const errMsg = data.error?.message || `Groq request failed (${response.status})`;
      return { error: new Error(errMsg) };
    }
    return { ok: true, json: JSON.parse(data.choices?.[0]?.message?.content || '{}') };
  } catch (error) {
    if (!recorded) record(usage, purpose, 0, started, {}, currentModel);
    const message = error.name === 'AbortError' ? 'Groq request timed out' : (error.message || 'Groq request failed');
    return { error: new Error(message) };
  } finally {
    clearTimeout(timer);
  }
}

async function ask(usage, purpose, maxTokens, messages) {
  if (!config.groqKey) throw new Error('GROQ_API_KEY is missing');
  let lastError = new Error('Groq call limit reached');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (usage.callCount >= config.groqMaxCalls) throw lastError;
    const result = await once(usage, purpose, maxTokens, messages);
    if (result.ok) return result.json;
    lastError = result.error;
    if (!result.retry) throw lastError;
    await delay(result.wait || 1000);
  }
  throw lastError;
}

function brief(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return text.slice(0, max);
}

async function rank(usage, { prompt, content, candidates }) {
  // Ultra-lightweight payload: send only id, title, and upvotes
  const compact = (candidates || []).slice(0, 15).map((item, index) => ({
    id: String(index + 1),
    title: item.title,
    upvotes: item.upvotes || 0,
  }));

  const cleanTopic = (prompt || content || '').slice(0, 120);

  const result = await ask(usage, 'rank', 800, [
    {
      role: 'system',
      content: 'You are an AI social marketing assistant. Evaluate these posts or questions based on topic relevance and engagement. Reply with JSON only containing the top 3 best: {"picks":[{"id":"1","relevance":9,"opportunity":8,"reason":"Short reason"}]}. Scores 1-10.',
    },
    { role: 'user', content: JSON.stringify({ topic: cleanTopic, candidates: compact }) },
  ]);
  return result.picks || [];
}

async function writeAnswer(usage, { prompt, content, question }) {
  const cleanObjective = (prompt || content || '').slice(0, 200);
  const isComment = Boolean(question?.isComment);
  const isEnd = Boolean(question?.isEnd);
  const isTwitter = Boolean(question?.isTwitter);
  const isFacebook = Boolean(question?.isFacebook);

  let systemPrompt = 'Write one helpful, detailed, and genuine Quora answer to this question. Reply with JSON only: {"answer":"Full text of the answer","reason":"one short sentence"}. Mention the campaign link only if naturally relevant.';

  if (isTwitter) {
    systemPrompt = 'Write one punchy, insightful, and authentic reply to this Twitter/X post. Must be strictly under 280 characters. Sound like a knowledgeable peer, natural and conversational, not a marketer. Reply with JSON only: {"answer":"Full text of the reply","reason":"one short sentence"}. Mention the campaign link/product only if it naturally fits.';
  } else if (isFacebook) {
    systemPrompt = 'Write one friendly, helpful, and natural comment on this Facebook post. Keep it engaging, authentic, and conversational, matching standard Facebook social interactions. Reply with JSON only: {"answer":"Full text of the comment","reason":"one short sentence"}. Mention the campaign link/product only if it genuinely fits.';
  } else if (isComment) {
    systemPrompt = 'Write one concise, engaging, and genuine comment replying directly to the top post on this Quora discussion. Reply with JSON only: {"answer":"Full text of the comment","reason":"one short sentence"}. Mention the campaign link only if naturally relevant.';
  } else if (isEnd) {
    systemPrompt = 'Write an insightful, value-adding answer or reply concluding the discussion thread or replying directly to the post at the end of the thread. Reply with JSON only: {"answer":"Full text of the reply or answer","reason":"one short sentence"}. Mention the campaign link only if naturally relevant.';
  }

  const result = await ask(usage, 'generate', 1000, [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify({
        objective: cleanObjective,
        questionTitle: question.title,
        context: (question.body || '').slice(0, 700),
      }),
    },
  ]);
  return { answer: String(result.answer || '').trim(), reason: String(result.reason || '').slice(0, 180) };
}

module.exports = { rank, writeAnswer };
