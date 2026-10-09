// Repo-relative path patterns for extract.components and extract.coverage. One meaning across designc:
// d.code's, which is System 2's (renderer/pathpattern.js, contract docs/path-patterns.json). A pattern that
// meaning rejects matches nothing; callers report it through `problem`.
const PathPattern = require('../renderer/pathpattern.js');

const match = (glob, file) => PathPattern.matches(glob, file);
const problem = glob => { const p = PathPattern.create(glob); return p.ok ? null : p.error; };

module.exports = { match, problem };
