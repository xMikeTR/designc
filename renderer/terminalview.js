/* designc desktop: integrated terminal (bottom panel, beside Problems and Output). Classic script after app.js.
   One shell per window, started in the registry folder on first show, kept alive across panel switches (the xterm
   element is hidden, not re-rendered). Human only: no agent tool reaches it. Shell output is written to xterm.js,
   which renders text, never HTML. */
const TM = { term: null, fit: null, id: null, starting: false };

function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return { background: v('--editor'), foreground: v('--fg'), cursor: v('--accent'), cursorAccent: v('--editor'), selectionBackground: v('--sel') };
}

function termFit() {
  if (!TM.term || $('#termBody').hidden) return;
  try { TM.fit.fit(); } catch { /* not laid out yet */ }
}

async function termStart() {
  if (TM.id || TM.starting) return;
  if (!A.root) { TM.term.writeln('Open a folder to start a shell in it.'); return; }
  TM.starting = true;
  const r = await host.termOpen(TM.term.cols, TM.term.rows);
  TM.starting = false;
  if (r.error) { TM.term.writeln(`\r\n${r.error}`); return; }
  if (r.cancelled) { TM.term.writeln('\r\nNo shell was started because this folder is not trusted. Press Enter to be asked again.'); return; }
  TM.id = r.id;
}

async function termShow() {
  if (!TM.term) {
    if (typeof Terminal === 'undefined') { $('#termBody').textContent = 'The terminal library did not load. Run npm install and restart designc.'; return; }
    TM.term = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace', fontSize: 12, cursorBlink: true, theme: termTheme(), scrollback: 5000 });
    TM.fit = new FitAddon.FitAddon();
    TM.term.loadAddon(TM.fit);
    TM.term.open($('#termBody'));
    // With no shell running, Enter starts one; otherwise every keystroke goes to the shell.
    TM.term.onData(s => { if (TM.id) host.termInput(TM.id, s); else if (s === '\r') termStart(); });
    TM.term.onResize(({ cols, rows }) => { if (TM.id) host.termResize(TM.id, cols, rows); });
    new ResizeObserver(() => termFit()).observe($('#termBody'));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { TM.term.options.theme = termTheme(); });
    host.onTermData((id, s) => { if (id === TM.id) TM.term.write(s); });
    host.onTermExit((id, code) => {
      if (id !== TM.id) return;
      TM.id = null;
      TM.term.writeln(`\r\n[The shell exited${code != null ? ` with code ${code}` : ''}. Press Enter to start a new one in ${A.root || 'the open folder'}.]`);
    });
  }
  termFit();
  await termStart();
  TM.term.focus();
}
