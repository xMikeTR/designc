'use strict';
// Small text helpers shared by the code-level scanners (extract/code-cs.js, extract/code-js.js). Pure.

function matchClose(code, open, o, c) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return idx => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

const prevChar = (code, idx) => { let i = idx - 1; while (i >= 0 && /\s/.test(code[i])) i--; return i >= 0 ? code[i] : ''; };

// index of the ';' that ends the member starting at `from`, ignoring ones inside brackets
function skipTo(code, from, end) {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth <= 0) return i;
  }
  return end;
}

const count = (s, re) => (s.match(re) || []).length;

module.exports = { matchClose, lineIndex, prevChar, skipTo, count };
