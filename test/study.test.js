// Study topics (renderer/study.js): what a topic file holds, what the Researcher may append, and the
// human-only edits. Every edit returns a new topic or {error}; nothing is changed in place.
const { test } = require('node:test');
const assert = require('node:assert');
const yaml = require('js-yaml');
const Study = require('../renderer/study.js');

const topic = (over = {}) => ({
  id: 'compiler-passes', question: 'How do mature compilers structure their passes?', status: 'open',
  sources: [{ url: 'https://github.com/llvm/llvm-project/blob/abc/PassManager.h', note: 'Pass manager' }],
  findings: [{ pattern: 'Passes declare what they preserve', why: 'Lets the manager skip recomputing analyses', good_or_bad: 'good', sources: [1] }],
  questions: [{ text: 'Why not one big pass?', asked: '2026-10-18', answer_in: [] }],
  opinion: '', pocs: [], ...over,
});

test('a new topic gets a slug id from its question and the canonical fields', () => {
  const t = Study.newTopic('How do compilers structure passes?', ['how-do-compilers-structure-passes']);
  assert.equal(t.id, 'how-do-compilers-structure-passes-2');
  assert.deepEqual(t, { id: t.id, question: 'How do compilers structure passes?', status: 'open', sources: [], findings: [], questions: [], opinion: '', pocs: [] });
  assert.deepEqual(Study.newTopic('  '), { error: 'Say what you want to learn: the question is empty.' });
});

test('validate names what is malformed', () => {
  assert.deepEqual(Study.validate(topic()), []);
  const p = Study.validate(topic({ status: 'done', findings: [{ pattern: '', why: 'x', good_or_bad: 'meh', sources: [3] }] }));
  assert.ok(p.some(x => /status must be open, settled or abandoned/.test(x)));
  assert.ok(p.some(x => /finding 1 needs a pattern/.test(x)));
  assert.ok(p.some(x => /finding 1: good_or_bad must be good, bad or tradeoff/.test(x)));
  assert.ok(p.some(x => /finding 1 cites source 3, which does not exist/.test(x)));
  assert.ok(Study.validate(topic({ status: 'settled', opinion: ' ' })).some(x => /settled topic needs your opinion/.test(x)));
});

test('the Researcher appends a source: https only, no repeats, open topics only', () => {
  const r = Study.addSource(topic(), { url: 'https://doc.rust-lang.org/rustc/', note: 'rustc guide' });
  assert.equal(r.topic.sources.length, 2);
  assert.deepEqual(r.topic.sources[1], { url: 'https://doc.rust-lang.org/rustc/', note: 'rustc guide' });
  assert.equal(r.index, 2);
  assert.match(Study.addSource(topic(), { url: 'ftp://x', note: '' }).error, /https link/);
  assert.match(Study.addSource(topic(), { url: 'https://github.com/llvm/llvm-project/blob/abc/PassManager.h' }).error, /already source 1/);
  assert.match(Study.addSource(topic({ status: 'settled', opinion: 'x' }), { url: 'https://a.example/' }).error, /is settled/);
});

test('the Researcher appends a finding that cites existing sources, and may correct an earlier one', () => {
  const r = Study.addFinding(topic(), { pattern: 'One giant pass', why: 'Hard to test', good_or_bad: 'bad', sources: [1], corrects: 1 });
  assert.deepEqual(r.topic.findings[1], { pattern: 'One giant pass', why: 'Hard to test', good_or_bad: 'bad', sources: [1], corrects: 1 });
  assert.equal(r.topic.findings[0].pattern, 'Passes declare what they preserve', 'the earlier finding is kept');
  assert.match(Study.addFinding(topic(), { pattern: 'p', why: 'w', good_or_bad: 'good', sources: [2] }).error, /source 2/);
  assert.match(Study.addFinding(topic(), { pattern: 'p', why: 'w', good_or_bad: 'good', sources: [] }).error, /at least one source/);
  assert.match(Study.addFinding(topic(), { pattern: 'p', why: 'w', good_or_bad: 'great', sources: [1] }).error, /good, bad or tradeoff/);
  assert.match(Study.addFinding(topic(), { pattern: 'p', why: 'w', good_or_bad: 'good', sources: [1], corrects: 4 }).error, /finding 4/);
  assert.match(Study.addFinding(topic(), { pattern: 'p', why: '', good_or_bad: 'good', sources: [1] }).error, /why/);
});

test('the Researcher links findings to a question without touching its text', () => {
  const r = Study.answerQuestion(topic(), { question: 1, findings: [1, 1] });
  assert.deepEqual(r.topic.questions[0], { text: 'Why not one big pass?', asked: '2026-10-18', answer_in: [1] });
  assert.match(Study.answerQuestion(topic(), { question: 2, findings: [1] }).error, /question 2/);
  assert.match(Study.answerQuestion(topic(), { question: 1, findings: [9] }).error, /finding 9/);
});

test('human edits: questions, PoCs, opinion, and settling needs an opinion', () => {
  assert.deepEqual(Study.addQuestion(topic(), 'What breaks?', '2026-10-19').topic.questions[1], { text: 'What breaks?', asked: '2026-10-19', answer_in: [] });
  assert.deepEqual(Study.addPoc(topic(), { question: 'Can I write one?', where: '~/scratch/pm @ 3f2a1c9', result: '' }).topic.pocs[0], { question: 'Can I write one?', where: '~/scratch/pm @ 3f2a1c9', result: '' });
  assert.equal(Study.setOpinion(topic(), 'Use a pass manager').topic.opinion, 'Use a pass manager');
  assert.match(Study.setStatus(topic(), 'settled').error, /opinion/);
  assert.equal(Study.setStatus(topic({ opinion: 'Use one' }), 'settled').topic.status, 'settled');
  assert.equal(Study.setStatus(topic(), 'abandoned').topic.status, 'abandoned');
  assert.equal(Study.setStatus(topic({ status: 'settled', opinion: 'x' }), 'open').topic.status, 'open', 'a settled topic can be reopened');
});

test('toYaml round-trips and keeps the field order of the contract', () => {
  const text = Study.toYaml(topic(), yaml.dump);
  assert.deepEqual(yaml.load(text), topic());
  assert.deepEqual(Object.keys(yaml.load(Study.toYaml({ pocs: [], opinion: '', id: 'a', question: 'q', status: 'open' }, yaml.dump))), ['id', 'question', 'status', 'sources', 'findings', 'questions', 'opinion', 'pocs']);
});

test('parse reads a topic file and fills the missing lists', () => {
  const r = Study.parse('id: a\nquestion: q\n', yaml.load);
  assert.deepEqual(r.topic, { id: 'a', question: 'q', status: 'open', sources: [], findings: [], questions: [], opinion: '', pocs: [] });
  assert.match(Study.parse('- a\n', yaml.load).error, /mapping/);
});

test('a decision drafted from a settled topic carries the opinion as its rationale and where it came from', () => {
  const d = Study.decisionDraft(topic({ status: 'settled', opinion: 'Use a pass manager with declared preservation.' }), 'study');
  assert.deepEqual(d, { statement: '', rationale: 'Use a pass manager with declared preservation.', informed_by: [{ registry: 'study', topic: 'compiler-passes' }] });
  assert.match(Study.decisionDraft(topic(), 'study').error, /not settled/);
  assert.deepEqual(Study.settled([topic(), topic({ id: 'b', status: 'settled', opinion: 'x' })]).map(t => t.id), ['b']);
});
