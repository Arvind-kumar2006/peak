// Groq compatibility proxy (port 7310) — sits between TrueForge and Groq.
//
// TrueForge 0.2.1 replays every assistant message with a `reasoning_content`
// field, and Groq rejects that field with a 400 on the second model call
// ("property 'reasoning_content' is unsupported"). TrueForge also drops extra
// model params for custom providers, so `include_reasoning: false` can't be set
// from the AgentSpec. This proxy does both:
//   - strips reasoning_content / thinking_blocks from outgoing messages
//   - sets include_reasoning: false (reasoning still happens, it just isn't returned)
//   - drops TrueForge's harness helper tools (tool discovery, sub-agents, UI, …)
//     and their system-prompt sections. PEAK preloads every tool it uses, and
//     these extras cost ~2k tokens per call and tempted the model into
//     malformed `call_tool` calls that Groq's validator rejects
//   - on 429 (free-tier tokens-per-minute limit), waits the time Groq asks for and
//     retries, up to MAX_WAIT_MS in total, instead of failing the turn
// Everything else, including the streamed response, passes through untouched.
//
//   node model/groq-proxy.js          then GROQ_BASE_URL=http://localhost:7310/v1
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 7310);
const MAX_WAIT_MS = Number(process.env.GROQ_MAX_WAIT_MS ?? 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UPSTREAM = (process.env.GROQ_UPSTREAM_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');

const HARNESS_TOOLS = new Set([
  'ask_user_question',
  'get_current_datetime',
  'call_tool',
  'get_tool_info',
  'get_tool_output_schema',
  'list_tools',
  'get_openui_instructions',
  'create_sub_agent',
]);
const HARNESS_SECTIONS = /<(sub-agents|openui|internal-messages)>[\s\S]*?<\/\1>\s*/g;

function clean(body) {
  if (!Array.isArray(body.messages)) return body;
  const tools = Array.isArray(body.tools) ? body.tools.filter((t) => !HARNESS_TOOLS.has(t.function?.name)) : body.tools;
  return {
    ...body,
    include_reasoning: false,
    ...(tools ? { tools } : {}),
    messages: body.messages.map(({ reasoning_content, thinking_blocks, ...m }) =>
      m.role === 'system' && typeof m.content === 'string' ? { ...m, content: m.content.replace(HARNESS_SECTIONS, '') } : m,
    ),
  };
}

http
  .createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.stringify(clean(JSON.parse(raw))) : undefined;
      const send = () =>
        fetch(UPSTREAM + req.url.replace(/^\/v1/, ''), {
          method: req.method,
          headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
          body,
        });
      let upstream = await send();
      let waited = 0;
      while (upstream.status === 429 && waited < MAX_WAIT_MS) {
        const text = await upstream.text();
        const hinted = Number(/try again in ([\d.]+)s/.exec(text)?.[1] ?? upstream.headers.get('retry-after') ?? 5);
        const ms = Math.min(Math.ceil(hinted * 1000) + 250, MAX_WAIT_MS - waited);
        console.log(`[model-proxy] 429 rate limit — waiting ${(ms / 1000).toFixed(1)}s`);
        await sleep(ms);
        waited += ms;
        upstream = await send();
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (err) {
      console.error(`[model-proxy] ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `model-proxy: ${err.message}` } }));
    }
  })
  .listen(PORT, () => console.log(`[model-proxy] listening on http://localhost:${PORT}/v1 → ${UPSTREAM}`));
