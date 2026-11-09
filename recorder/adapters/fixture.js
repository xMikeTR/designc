'use strict';
// Fixture adapter: replays a scripted app with no browser, so the recorder and the diff can be built and tested without
// a real screen. A fixture is a small state machine:
//   { start: 'list', paths: {'/tags': 'list'}, viewport: {width, height},
//     screens: {list: <raw tree>, dialog: <raw tree>},
//     on: [{screen: 'list', click: {role, name, index?}, go: 'dialog'}] }
// click follows the first matching `on` entry (or does nothing when none matches, as clicking inert text would);
// fill and select set the node's value on the current screen. A target that is not on the screen is missing.
const fs = require('fs');
const zlib = require('zlib');
const { findNode } = require('../index.js');

const copy = t => JSON.parse(JSON.stringify(t));

// A screenshot stand-in: a small PNG of one colour taken from the screen's content, so each screen (and each app's version of it) has its own picture and
// the gallery has something to show.
function png(id, w = 160, h = 100) {
  let x = 2166136261;
  for (const c of id) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
  const rgb = [x & 255, (x >> 8) & 255, (x >> 16) & 255].map(v => 96 + (v % 128));
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const v of b) c = table[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

function load(fixture) {
  return typeof fixture === 'string' ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : fixture;
}

function create(fixture, name = 'fixture') {
  const fx = load(fixture);
  return {
    name,
    async open() {
      let screen = fx.start;
      let tree = copy(fx.screens[screen]);
      const go = id => {
        if (!fx.screens[id]) throw new Error(`fixture has no screen ${id}`);
        screen = id;
        tree = copy(fx.screens[id]);
      };
      return {
        async act(step) {
          if (step.goto) {
            const id = (fx.paths || {})[step.goto.path];
            if (!id) return { missing: `no page at ${step.goto.path}` };
            go(id);
            return { ok: true };
          }
          const [k] = Object.keys(step);
          const a = step[k];
          const node = findNode(tree, a.role, a.name, a.index || 0);
          if (!node) return { missing: `no ${a.role} named "${a.name}"${a.index ? ` (#${a.index})` : ''} on screen ${screen}` };
          if (node.disabled) throw new Error(`${a.role} "${a.name}" is disabled`);
          if (k === 'click') {
            const t = (fx.on || []).find(o => o.screen === screen && o.click && o.click.role === a.role
              && o.click.name === a.name && (o.click.index || 0) === (a.index || 0));
            if (t) go(t.go);
          } else {
            node.value = a.value;
          }
          return { ok: true };
        },
        async capture() {
          return { tree: copy(tree), viewport: fx.viewport || { width: 1280, height: 800 }, url: screen };
        },
        async screenshot() { return png(JSON.stringify(fx.screens[screen])); },
        async close() {},
      };
    },
  };
}

module.exports = { create };
