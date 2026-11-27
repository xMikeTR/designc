/* designc desktop: the feature map in the Work view. Classic script before workview.js, shares the renderer's global scope with
   app.js (nothing here runs at load). features/<id>.yaml is read in its own loader (not REG_DIRS); renderer/featuremap.js holds the
   reader and checks FM001 to FM004. Problems go to A.featureProblems (Problems panel rows, never gate clauses). A file that does not
   parse is listed by path. Read only, buttons only, every string through esc(). */
A.features = []; A.featureProblems = []; A.featureBad = [];

// The model's elements a feature may name, by hierarchical id or name, as core-drift resolveElement finds them. Only the references the
// features actually use are resolved. null when the model did not parse or has no elements (unknown is never a problem).
function featureElements(features) {
  const m = A.model;
  if (!m || !m.elements || !m.elements.size || (m.errors || []).length) return null;
  const out = new Set();
  for (const f of features) for (const r of Array.isArray(f.record.elements) ? f.record.elements : []) {
    if (typeof r === 'string' && r.trim() && !out.has(r.trim()) && Core.resolveElement(m, r.trim())) out.add(r.trim());
  }
  return out;
}
// ui/specs/<screen>.json, read here (loadUi runs after loadWork on a reload). A spec that does not parse is null: it exists, the gate says what is wrong.
async function featureSpecs() {
  const specs = {};
  let files = [];
  try { files = await host.list('ui/specs', ['.json']); } catch { files = []; }
  for (const f of files) {
    const screen = f.path.split('/').pop().replace(/\.json$/, '');
    try { const o = JSON.parse(textOf(f.path) ?? f.text); specs[screen] = o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { specs[screen] = null; }
  }
  return specs;
}
async function loadFeatures() {
  const good = [], bad = [], probs = [];
  let files = [];
  try { files = await host.list('features', ['.yaml', '.yml']); } catch { files = []; }
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const r = FeatureMap.parseFile(f.path, textOf(f.path) ?? f.text, jsyaml.load);   // unsaved buffers count, like landings
    if (r.record) good.push({ path: f.path, record: r.record });
    else { bad.push(f.path); for (const e of r.errors) probs.push({ path: f.path, line: e.line, code: 'yaml', msg: e.msg }); }
  }
  const ctx = {
    specs: await featureSpecs(),
    elements: featureElements(good),
    requirements: Array.isArray(A.requirements) ? A.requirements.map(r => String(r.id)) : null,
    acceptance: Array.isArray(A.acceptance) ? A.acceptance.map(r => String(r.id)) : null,
    testScenarios: Array.isArray(A.testScenarioIds) ? A.testScenarioIds : null,
  };
  A.features = good; A.featureBad = bad;
  A.featureProblems = [...probs, ...FeatureMap.problems(good, ctx)];
}

// The Features section of the Work view. Only with a folder open.
function featuresHtml() {
  if (!A.root) return '';
  const feats = A.features || [], bad = A.featureBad || [];
  const rowFor = f => {
    const r = f.record, id = typeof r.id === 'string' && r.id ? r.id : f.path.split('/').pop().replace(/\.ya?ml$/, '');
    const n = (A.featureProblems || []).filter(p => p.path === f.path).length;
    const screens = (Array.isArray(r.screens) ? r.screens : []).filter(s => typeof s === 'string').join(', ');
    const j = Array.isArray(r.journeys) ? r.journeys.length : 0, e = Array.isArray(r.entry_points) ? r.entry_points.length : 0;
    return `<li><button class="lnk" data-file="${esc(f.path)}" data-feature="${esc(id)}" title="Open ${esc(f.path)}"><span class="id">${esc(id)}</span> ${esc(typeof r.title === 'string' ? r.title : '')} <span class="desc">${esc(screens)} · ${esc(plural(j, 'journey'))}, ${esc(plural(e, 'entry point'))}</span>${n ? ` <span class="tag fail">${esc(plural(n, 'problem'))}</span>` : ''}</button></li>`;
  };
  const badRow = p => `<li><button class="lnk" data-file="${esc(p)}" data-feature-bad="${esc(p)}" title="Open ${esc(p)}"><span class="id">${esc(p)}</span> <span class="desc">cannot be read</span></button></li>`;
  const body = feats.length || bad.length ? `<ul>${[...feats.map(rowFor), ...bad.map(badRow)].join('')}</ul>` : '<div class="note">No features yet. One file per feature in features/; see docs/feature-map-contract.md.</div>';
  return `<div class="block" data-features><h3>Features (${feats.length + bad.length})</h3>${body}</div>`;
}
