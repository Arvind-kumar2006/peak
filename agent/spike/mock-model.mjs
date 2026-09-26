// Scripted OpenAI-compatible model for testing TrueForge without an API key.
// TrueForge calls POST /v1/chat/completions with stream: true.
// Script (by number of tool results seen so far):
//   0 → call get_health
//   1 → call restart_service
//   2 → call get_health (or final answer if restart was denied)
//   3+ → final answer
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 7300);

function decide(messages) {
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const last = toolMsgs.at(-1);
  if (last) console.log(`[mock-model] tool result #${toolMsgs.length}: ${text(last).slice(0, 200)}`);

  if (toolMsgs.length === 0) return { tool: 'get_health', args: {} };
  if (toolMsgs.length === 1) return { tool: 'restart_service', args: { reason: 'Error rate 42% — service unhealthy' } };
  if (toolMsgs.length === 2) {
    if (/den(y|ied)|reject/i.test(text(last))) return { text: 'Restart was denied by the operator. Leaving the service as-is for manual handling.' };
    return { tool: 'get_health', args: {} };
  }
  return { text: `Service recovered after restart. Last health: ${text(last)}` };
}

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

http
  .createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw);
    const step = decide(body.messages);
    const base = { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (step.tool) {
      console.log(`[mock-model] → tool call ${step.tool}`);
      sse(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
          },
          finish_reason: null,
        }],
      });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      console.log(`[mock-model] → final answer`);
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.end('data: [DONE]\n\n');
  })
  .listen(PORT, () => console.log(`[mock-model] listening on http://localhost:${PORT}/v1`));
