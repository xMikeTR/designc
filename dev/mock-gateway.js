// Scripted OpenAI-compatible gateway for demos and tests: streams text and tool calls.
// node dev/mock-gateway.js [port]   then set llm.baseUrl to http://127.0.0.1:<port>/v1, llm.model to "mock",
// and DESIGNC_LLM_API_KEY to anything.
const http = require('http');
const port = +process.argv[2] || 8765;
const FIND = '"d.writes" "Quote"\n        "d.concurrency" "none"';
function script(messages) {
  const tools = messages.filter(m => m.role === 'tool');
  const last = tools[tools.length - 1];
  if (!tools.length) return { text: 'Let me check the findings and the model around the writers of Quote.', calls: [['get_findings', {}], ['read_model', { from: 90, to: 110 }]] };
  if (tools.length === 2) return { text: 'DC002 is an error: Referral Worker writes Quote with `d.concurrency` set to `none`. I\'ll try to bind D-0001 and propose the model fix.', calls: [['bind_decision', { id: 'D-0001' }], ['propose_model_edit', { find: FIND, replace: FIND.replace('"none"', '"optimistic"'), reason: 'Referral Worker must use optimistic concurrency on Quote, as D-0001 says.' }]] };
  if (/^Applied/.test(last.content)) return { text: 'Done. The explicit `none` is gone, so DC002 is no longer an error. It is now a **warning**: Pricing API writes Quote without declaring `d.concurrency` (line 70). Set it to `optimistic` there too, then bind D-0001 yourself; I\'m not allowed to bind decisions.' };
  return { text: 'Understood, I left the model unchanged. Would you rather give Quote a single owner with `d.owns` on Pricing API?' };
}
http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c));
  req.on('end', async () => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    const { messages } = JSON.parse(body); const s = script(messages);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const w of s.text.split(/(?<= )/)) { send({ choices: [{ delta: { content: w } }] }); await sleep(8); }
    (s.calls || []).forEach(([name, args], i) => {
      const a = JSON.stringify(args), mid = Math.floor(a.length / 2);
      send({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: 'function', function: { name, arguments: a.slice(0, mid) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: a.slice(mid) } }] } }] });
    });
    send({ choices: [{ delta: {}, finish_reason: s.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(port, () => console.log(`mock gateway on http://127.0.0.1:${port}/v1`));
