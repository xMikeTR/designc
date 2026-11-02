/* designc desktop: the UI graph (phase 7) for the Code map's UI level. Pure, no I/O, dual-loaded like codelevel.js.
   Reads facts.ui (designc.ui.graph/1, extract/ui.js). Display only: never a gate input, finding or fingerprint input. */
const UiGraph = (() => {
  const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;

  // One screen: its components as a render tree (a component no other one renders is at depth 0, what it renders, by
  // name, below it; siblings in file order; a component rendered twice is listed once, where first reached), each with the
  // controls it holds (followed controls sit at their usage); plus the screen's followed components and unresolved entries.
  function screen(ui, name) {
    const s = ui && (ui.screens || []).find(x => x.name === name);
    if (!s) return null;
    const controls = (ui.controls || []).filter(c => c.screen === name).sort(byPlace);
    const comps = (ui.components || []).filter(c => s.components.includes(c.id)).sort(byPlace);
    const rendered = new Set(comps.flatMap(c => c.renders || []));
    const seen = new Set(), tree = [];
    const visit = (c, depth) => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      tree.push({ ...c, depth, controls: controls.filter(x => x.component === c.id) });
      for (const r of c.renders || []) comps.filter(k => k.name === r).forEach(k => visit(k, depth + 1));
    };
    comps.filter(c => !rendered.has(c.name)).forEach(c => visit(c, 0));
    comps.forEach(c => visit(c, 0));
    const placed = new Set(tree.flatMap(c => c.controls.map(x => x.id)));
    const loose = controls.filter(x => !placed.has(x.id));
    if (loose.length) tree.push({ id: null, name: '(no component)', file: '', line: 0, renders: [], depth: 0, controls: loose });
    const followed = (ui.components || []).filter(c => (s.followed || []).includes(c.id)).sort(byPlace);
    return { name, roots: s.roots.slice(), tree, controls, followed, unresolved: (ui.unresolved || []).filter(u => u.screen === name) };
  }

  // Counts per screen: controls, those without a role the source shows, those without a literal name.
  function summary(ui) {
    const screens = ((ui && ui.screens) || []).map(s => {
      const cs = (ui.controls || []).filter(c => c.screen === s.name);
      return { name: s.name, roots: s.roots.length, controls: cs.length, roleless: cs.filter(c => !c.role).length, unnamed: cs.filter(c => !c.name).length };
    });
    const sum = k => screens.reduce((n, s) => n + s[k], 0);
    return { screens, controls: sum('controls'), roleless: sum('roleless'), unnamed: sum('unnamed'), unresolved: ((ui && ui.unresolved) || []).length };
  }

  const BASIS = { native: 'HTML element', aria: 'role attribute', followed: 'followed component', mapped: 'designc.json ui.roles' };

  return { screen, summary, BASIS };
})();
if (typeof module !== 'undefined') module.exports = UiGraph;
