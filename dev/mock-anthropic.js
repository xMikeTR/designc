#!/usr/bin/env node
// A scripted Anthropic Messages API on port 8791, for the anthropic provider (non-streaming and SSE, tool use included).
//   node dev/mock-anthropic.js     then set llm.provider "anthropic", llm.baseUrl http://127.0.0.1:8791 and ANTHROPIC_API_KEY=any
const http = require('http');
const sse = evs => evs.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    if (req.url !== '/v1/messages') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'not found' } })); }
    if (!req.headers['x-api-key']) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'x-api-key header is required' } })); }
    const body = JSON.parse(b || '{}'), last = body.messages[body.messages.length - 1];
    const answered = Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result');
    const wantsTool = !answered && (body.tools || []).some(t => t.name === 'get_gate') && body.max_tokens > 1;
    const text = answered ? 'The gate has been read.' : 'OK';
    const content = wantsTool ? [{ type: 'text', text: 'Reading the gate.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_gate', input: {} }] : [{ type: 'text', text }];
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ model: body.model, content, usage: { input_tokens: 10, output_tokens: 4 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const evs = [{ type: 'message_start', message: { model: body.model, usage: { input_tokens: 10 } } }];
    content.forEach((c, i) => {
      if (c.type === 'text') { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }); for (const w of c.text.match(/\S+\s*/g)) evs.push({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: w } }); }
      else { evs.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }); evs.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }); }
      evs.push({ type: 'content_block_stop', index: i });
    });
    evs.push({ type: 'message_delta', delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' });
    res.end(sse(evs));
  });
}).listen(Number(process.env.PORT) || 8791, '127.0.0.1', () => console.log('mock anthropic on 8791'));
