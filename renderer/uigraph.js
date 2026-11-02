/* designc desktop: the UI graph (phase 7) for the Code map's UI level. Pure, no I/O, dual-loaded like codelevel.js.
   Reads facts.ui (designc.ui.graph/1, extract/ui.js). Display only: never a gate input, finding or fingerprint input. */
const UiGraph = (() => {
  const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;

  // One screen: its components in file order, each with the controls it holds; plus the screen's unresolved entries.
  function screen(ui, name) {
    const s = ui && (ui.screens || []).find(x => x.name === name);
    if (!s) return null;
    const controls = (ui.controls || []).filter(c => c.screen === name).sort(byPlace);
    const comps = (ui.components || []).filter(c => s.components.includes(c.id)).sort(byPlace);
    const tree = comps.map(c => ({ ...c, controls: controls.filter(x => x.component === c.id) }));
    const placed = new Set(tree.flatMap(c => c.controls.map(x => x.id)));
    const loose = controls.filter(x => !placed.has(x.id));
    if (loose.length) tree.push({ id: null, name: '(no component)', file: '', line: 0, renders: [], controls: loose });
    return { name, roots: s.roots.slice(), tree, controls, unresolved: (ui.unresolved || []).filter(u => u.screen === name) };
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
