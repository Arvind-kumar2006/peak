// Model providers for PEAK, in fallback order.
// TrueForge has no built-in model fallback, so trueforge.js switches
// the session to the next provider when a turn fails with a model error.

// Model name used in AgentSpec = `${provider.name}/${provider.model.name}`.
export function modelRef(provider) {
  return `${provider.name}/${provider.model.name}`;
}

const DEFINITIONS = {
  // Groq (groq.com, keys start with gsk_) — fast hosted open models, OpenAI-compatible.
  // Not to be confused with Grok (xAI, keys start with xai-), below.
  groq: () => ({
    name: 'groq',
    apiKey: process.env.GROQ_API_KEY,
    manifest: {
      type: 'custom',
      name: 'groq',
      // Through server/model/groq-proxy.js: TrueForge replays `reasoning_content`, which Groq rejects.
      base_url: process.env.GROQ_BASE_URL ?? 'http://localhost:7310/v1',
      auth: { api_key: process.env.GROQ_API_KEY },
      models: [{ model_id: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b', name: 'peak-model', properties: {} }],
    },
  }),
  // Google Gemini — native TrueForge provider type.
  gemini: () => ({
    name: 'google-gemini',
    apiKey: process.env.GEMINI_API_KEY,
    manifest: {
      type: 'google-gemini',
      auth: { api_key: process.env.GEMINI_API_KEY },
      models: [{ model_id: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash', name: 'peak-model', properties: {} }],
    },
  }),
  openai: () => ({
    name: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    manifest: {
      type: 'openai',
      auth: { api_key: process.env.OPENAI_API_KEY },
      models: [{ model_id: process.env.OPENAI_MODEL ?? 'gpt-5.2', name: 'peak-model', properties: {} }],
    },
  }),
  // Grok via xAI's OpenAI-compatible API (TrueForge "custom" provider → /chat/completions).
  xai: () => ({
    name: 'xai',
    apiKey: process.env.XAI_API_KEY,
    manifest: {
      type: 'custom',
      name: 'xai',
      base_url: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
      auth: { api_key: process.env.XAI_API_KEY },
      models: [{ model_id: process.env.XAI_MODEL ?? 'grok-4', name: 'peak-model', properties: {} }],
    },
  }),
};

// MODEL_PROVIDERS="groq,gemini,openai,xai" (default). Providers without an API key are skipped.
export function providersFromEnv() {
  const order = (process.env.MODEL_PROVIDERS ?? 'groq,gemini,openai,xai').split(',').map((s) => s.trim()).filter(Boolean);
  const providers = [];
  for (const id of order) {
    const def = DEFINITIONS[id];
    if (!def) throw new Error(`Unknown provider "${id}" in MODEL_PROVIDERS (known: ${Object.keys(DEFINITIONS).join(', ')})`);
    const p = def();
    if (!p.apiKey) {
      console.warn(`[providers] skipping ${id}: no API key set`);
      continue;
    }
    p.model = p.manifest.models[0];
    providers.push(p);
  }
  if (providers.length === 0) throw new Error('No model provider available — set GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY and/or XAI_API_KEY');
  return providers;
}
