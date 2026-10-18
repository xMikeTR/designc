/* designc desktop: study topics (step 0, learn before deciding). Pure, no I/O, no dependencies.
   Dual-load like renderer/look.js: <script src="study.js"> in the renderer, require('./renderer/study.js')
   from tests. A topic is `study/<id>.yaml` in a registry whose designc.json says `"kind": "study"`.
   The Researcher appends sources and findings and links findings to questions (addSource, addFinding,
   answerQuestion); status, opinion, question text and PoC results are the person's (addQuestion, addPoc,
   setOpinion, setStatus). Every edit returns {topic} (a new object) or {error}. Citations are not judged:
   the person checks them. Indexes the person and the agent see are 1-based. */
const Study = (() => {
  const STATUSES = ['open', 'settled', 'abandoned'];
  const GOOD_OR_BAD = ['good', 'bad', 'tradeoff'];
  const FIELDS = ['id', 'question', 'status', 'sources', 'findings', 'questions', 'opinion', 'pocs'];
  const str = v => (v == null ? '' : String(v));
  const blank = v => !str(v).trim();
  const list = v => (Array.isArray(v) ? v : []);
  const copy = t => JSON.parse(JSON.stringify(t));
  const slug = s => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'topic';

  function normal(o) {
    return { id: str(o.id), question: str(o.question), status: o.status || 'open', sources: list(o.sources), findings: list(o.findings),
      questions: list(o.questions), opinion: str(o.opinion), pocs: list(o.pocs) };
  }
  function newTopic(question, taken = []) {
    if (blank(question)) return { error: 'Say what you want to learn: the question is empty.' };
    const base = slug(question); let id = base, n = 2;
    while (taken.includes(id)) id = `${base}-${n++}`;
    return normal({ id, question: str(question).trim() });
  }
  function parse(text, load) {
    let o; try { o = load(text); } catch (e) { return { error: e.reason || e.message }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'expected a mapping at the top level' };
    return { topic: normal(o) };
  }
  // Keys in the contract's order, so files read the same whoever wrote them; unknown keys are kept after.
  function toYaml(t, dump) {
    const n = normal(t), o = {};
    for (const k of FIELDS) o[k] = n[k];
    for (const k of Object.keys(t)) if (!FIELDS.includes(k) && !k.startsWith('_')) o[k] = t[k];
    return dump(o, { lineWidth: 120, noRefs: true });
  }

  const intList = v => Array.isArray(v) && v.every(n => Number.isInteger(n));
  function validate(t) {
    const p = [];
    if (blank(t.id)) p.push('the topic needs an id');
    if (blank(t.question)) p.push('the topic needs a question');
    if (!STATUSES.includes(t.status)) p.push('status must be open, settled or abandoned');
    if (t.status === 'settled' && blank(t.opinion)) p.push('a settled topic needs your opinion');
    const src = list(t.sources), fnd = list(t.findings);
    src.forEach((s, i) => { if (!s || blank(s.url)) p.push(`source ${i + 1} needs a url`); });
    fnd.forEach((f, i) => {
      const n = i + 1;
      if (!f || typeof f !== 'object') { p.push(`finding ${n} is not a mapping`); return; }
      if (blank(f.pattern)) p.push(`finding ${n} needs a pattern`);
      if (blank(f.why)) p.push(`finding ${n} needs a why`);
      if (!GOOD_OR_BAD.includes(f.good_or_bad)) p.push(`finding ${n}: good_or_bad must be good, bad or tradeoff`);
      if (!intList(f.sources)) p.push(`finding ${n}: sources must be a list of source numbers`);
      else for (const s of f.sources) if (s < 1 || s > src.length) p.push(`finding ${n} cites source ${s}, which does not exist`);
      if (f.corrects != null && !(Number.isInteger(f.corrects) && f.corrects >= 1 && f.corrects < n)) p.push(`finding ${n} corrects finding ${f.corrects}, which is not an earlier one`);
    });
    list(t.questions).forEach((q, i) => {
      if (!q || blank(q.text)) p.push(`question ${i + 1} needs text`);
      else for (const f of list(q.answer_in)) if (!Number.isInteger(f) || f < 1 || f > fnd.length) p.push(`question ${i + 1} points at finding ${f}, which does not exist`);
    });
    list(t.pocs).forEach((x, i) => { if (!x || blank(x.question)) p.push(`PoC ${i + 1} needs a question`); });
    return p;
  }

  const closed = t => (t.status === 'open' ? null : { error: `${t.id} is ${t.status}. Reopen it before adding to it.` });
  function addSource(t, { url, note } = {}) {
    const c = closed(t); if (c) return c;
    const u = str(url).trim();
    if (!/^https:\/\/[^\s/]+\S*$/.test(u)) return { error: 'A source needs an https link to the page or file (a commit link for code, so it does not move).' };
    const at = t.sources.findIndex(s => s.url === u);
    if (at >= 0) return { error: `${u} is already source ${at + 1}.` };
    const topic = copy(t); topic.sources.push({ url: u, note: str(note).trim() });
    return { topic, index: topic.sources.length };
  }
  function addFinding(t, { pattern, why, good_or_bad, sources, corrects } = {}) {
    const c = closed(t); if (c) return c;
    if (blank(pattern)) return { error: 'A finding needs a pattern: what the code or source does.' };
    if (blank(why)) return { error: 'A finding needs a why: why it works or does not.' };
    if (!GOOD_OR_BAD.includes(good_or_bad)) return { error: 'good_or_bad must be good, bad or tradeoff.' };
    if (!intList(sources) || !sources.length) return { error: 'A finding cites at least one source by number. Add the source first with add_source.' };
    const bad = sources.find(s => s < 1 || s > t.sources.length);
    if (bad != null) return { error: `There is no source ${bad} in ${t.id} (it has ${t.sources.length}).` };
    if (corrects != null && !(Number.isInteger(corrects) && corrects >= 1 && corrects <= t.findings.length)) return { error: `There is no finding ${corrects} in ${t.id} to correct.` };
    const f = { pattern: str(pattern).trim(), why: str(why).trim(), good_or_bad, sources: [...new Set(sources)] };
    if (corrects != null) f.corrects = corrects;
    const topic = copy(t); topic.findings.push(f);
    return { topic, index: topic.findings.length };
  }
  function answerQuestion(t, { question, findings } = {}) {
    const c = closed(t); if (c) return c;
    if (!Number.isInteger(question) || question < 1 || question > t.questions.length) return { error: `There is no question ${question} in ${t.id} (it has ${t.questions.length}).` };
    if (!intList(findings) || !findings.length) return { error: 'Name the findings that answer the question, by number.' };
    const bad = findings.find(f => f < 1 || f > t.findings.length);
    if (bad != null) return { error: `There is no finding ${bad} in ${t.id} (it has ${t.findings.length}).` };
    const topic = copy(t), q = topic.questions[question - 1];
    q.answer_in = [...new Set([...list(q.answer_in), ...findings])];
    return { topic };
  }

  // The person's edits.
  function addQuestion(t, text, date) {
    if (blank(text)) return { error: 'The question is empty.' };
    const topic = copy(t); topic.questions.push({ text: str(text).trim(), asked: date, answer_in: [] });
    return { topic };
  }
  function addPoc(t, { question, where = '', result = '' } = {}) {
    if (blank(question)) return { error: 'Say what the PoC is to find out.' };
    const topic = copy(t); topic.pocs.push({ question: str(question).trim(), where: str(where).trim(), result: str(result).trim() });
    return { topic };
  }
  function setOpinion(t, text) { const topic = copy(t); topic.opinion = str(text).trim(); return { topic }; }
  function setStatus(t, status) {
    if (!STATUSES.includes(status)) return { error: 'status must be open, settled or abandoned.' };
    if (status === 'settled' && blank(t.opinion)) return { error: 'Write your opinion first: settling a topic records what you now think.' };
    const topic = copy(t); topic.status = status;
    return { topic };
  }

  const settled = topics => topics.filter(t => t.status === 'settled');
  // The exit: a decision in a project registry, informed by a settled topic. The statement is the person's to write.
  function decisionDraft(t, registry) {
    if (t.status !== 'settled') return { error: `${t.id} is not settled. Settle it in the study registry first.` };
    return { statement: '', rationale: str(t.opinion).trim(), informed_by: [{ registry, topic: t.id }] };
  }

  return { STATUSES, GOOD_OR_BAD, newTopic, parse, toYaml, validate, addSource, addFinding, answerQuestion, addQuestion, addPoc, setOpinion, setStatus, settled, decisionDraft };
})();
if (typeof module !== 'undefined') module.exports = Study;
