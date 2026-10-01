// Scripted AG-UI agent service for demos and tests, shaped like a MAF host behind MapAGUIServer:
// frontend tool call, backend tool with TOOL_CALL_RESULT, shared state (snapshot + delta), and an
// approval-required tool that ends the run with a canonical interrupt and executes only on resume.
//   node dev/mock-agui-server.js [port]      (MOCK_REGISTRY=<registry path> lets the approved tool write the model)
// designc.json: "aguiAgents": { "maf": { "label": "MAF (mock)", "url": "http://127.0.0.1:8790/" } }
const http = require('http'), fs = require('fs'), path = require('path');
const port = +process.argv[2] || 8790;
const pendingApproval = new Map();   // threadId -> { interruptId, toolCallId, args }
let seq = 0; const id = p => `${p}-${++seq}`;

http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c));
  req.on('end', async () => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (process.env.EXPECT_AUTH && req.headers.authorization !== process.env.EXPECT_AUTH) { res.writeHead(401); return res.end('bad token'); }
    const input = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const say = async text => { const m = id('msg'); emit({ type: 'TEXT_MESSAGE_START', messageId: m, role: 'assistant' }); for (const w of text.split(/(?<= )/)) { emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: m, delta: w }); await sleep(6); } emit({ type: 'TEXT_MESSAGE_END', messageId: m }); return m; };
    const { threadId, runId } = input;
    emit({ type: 'RUN_STARTED', threadId, runId });

    if (input.resume) {                                  // resume after an approval interrupt
      const p = pendingApproval.get(threadId); const r = input.resume.find(x => p && x.interruptId === p.interruptId);
      pendingApproval.delete(threadId);                  // an interrupt resolves once; stale resumes do nothing
      if (!r) { await say('There is nothing waiting for approval on this thread.'); }
      else if (r.status === 'resolved' && r.payload && r.payload.accepted) {
        let result = 'Applied (no registry configured for the mock).';
        if (process.env.MOCK_REGISTRY) { const f = path.join(process.env.MOCK_REGISTRY, 'model', 'workspace.dsl'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"d.concurrency" "none"', '"d.concurrency" "optimistic"')); result = 'Applied to model/workspace.dsl'; }
        emit({ type: 'TOOL_CALL_RESULT', messageId: id('msg'), toolCallId: p.toolCallId, role: 'tool', content: result });
        emit({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/plan/2/status', value: 'completed' }] });
        await say('Done: Referral Worker now declares optimistic concurrency on Quote. Pricing API still needs the same; bind D-0001 once both are in.');
      } else {
        emit({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/plan/2/status', value: 'skipped' }] });
        await say(r.status === 'cancelled' ? 'Cancelled; nothing was changed.' : 'Understood, I left the model as it is. Would you prefer a single owner for Quote?');
      }
      emit({ type: 'RUN_FINISHED', threadId, runId }); return res.end();
    }

    const last = (input.messages || [])[input.messages.length - 1] || {};
    const toolNames = (input.tools || []).map(t => t.name);
    if (last.role === 'user') {                          // run 1: read state, call a designc frontend tool
      const gate = input.state && input.state.designc && input.state.designc.gate;
      emit({ type: 'STATE_SNAPSHOT', snapshot: { ...(input.state || {}), plan: [{ step: 'Read findings in designc', status: 'in_progress' }, { step: 'Check incident history', status: 'pending' }, { step: 'Fix the lost update', status: 'pending' }] } });
      emit({ type: 'STEP_STARTED', stepName: 'review' });
      await say(`From the shared state the gate has ${gate ? gate.blocking.length : '?'} blocking items. Reading the findings through designc${toolNames.length ? ` (${toolNames.length} designc tools offered)` : ''}.`);
      const call = id('call'); emit({ type: 'TOOL_CALL_START', toolCallId: call, toolCallName: 'get_findings' });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: call, delta: '{}' }); emit({ type: 'TOOL_CALL_END', toolCallId: call });
      emit({ type: 'RUN_FINISHED', threadId, runId }); return res.end();   // the client runs the frontend tool
    }
    if (last.role === 'tool') {                          // run 2: backend tool, then an approval-required tool
      let errors = '?'; try { errors = JSON.parse(last.content).filter(f => f.severity === 'error' && !f.suppressed).length; } catch { /* keep ? */ }
      emit({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/plan/0/status', value: 'completed' }, { op: 'replace', path: '/plan/1/status', value: 'in_progress' }] });
      await say(`${errors} errors. Checking incidents for Quotes DB on the server side.`);
      const b = id('call'); emit({ type: 'TOOL_CALL_START', toolCallId: b, toolCallName: 'lookup_incidents' });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: b, delta: '{"element":"Quotes DB"}' }); emit({ type: 'TOOL_CALL_END', toolCallId: b });
      emit({ type: 'TOOL_CALL_RESULT', messageId: id('msg'), toolCallId: b, role: 'tool', content: 'INC-2291 (UAT): underwriter edit overwritten by referral status update.' });
      emit({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/plan/1/status', value: 'completed' }, { op: 'replace', path: '/plan/2/status', value: 'awaiting approval' }] });
      await say('INC-2291 matches DC002. I want to set optimistic concurrency on the Referral Worker write.');
      const a = id('call'), args = { element: 'Referral Worker -> Quotes DB', set: { 'd.concurrency': 'optimistic' } };
      emit({ type: 'TOOL_CALL_START', toolCallId: a, toolCallName: 'apply_model_patch' });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: a, delta: JSON.stringify(args) }); emit({ type: 'TOOL_CALL_END', toolCallId: a });
      const interruptId = id('approval'); pendingApproval.set(threadId, { interruptId, toolCallId: a, args });
      emit({ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'interrupt', interrupts: [{ id: interruptId, reason: 'tool_call', message: 'Approve tool call apply_model_patch?', toolCallId: a,
        responseSchema: { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'] },
        metadata: { agent_framework: { type: 'function_approval_request', function_call: { call_id: a, name: 'apply_model_patch', arguments: args } } } }] } });
      return res.end();
    }
    await say('Nothing to do.'); emit({ type: 'RUN_FINISHED', threadId, runId }); res.end();
  });
}).listen(port, '127.0.0.1', () => console.log(`mock AG-UI service on http://127.0.0.1:${port}/`));
