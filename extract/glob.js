// Built-in glob matcher for repo-relative posix paths. Supports ** (zero or more segments), * (within
// one segment) and ? (one non-/ character); everything else is literal. Case-sensitive, pure.
const cache = new Map();
function compile(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
      else if (i > 0 && glob[i - 1] === '/' && i + 2 === glob.length) { re = re.slice(0, -1) + '/.*'; i += 1; }
      else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function match(glob, file) {
  if (!cache.has(glob)) cache.set(glob, compile(glob));
  return cache.get(glob).test(file);
}
module.exports = { match };
