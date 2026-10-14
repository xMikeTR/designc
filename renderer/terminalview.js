/* designc desktop: integrated terminal (bottom panel, beside Problems and Output). Classic script after app.js.
   One shell per window, started in the registry folder on first show, kept alive across panel switches (the xterm
   element is hidden, not re-rendered). Human only: no agent tool reaches it. Shell output is written to xterm.js,
   which renders text, never HTML. */
const TM = { term: null, fit: null, id: null, starting: false, lastData: 0 };

function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  return { background: v('--editor'), foreground: v('--fg'), cursor: v('--accent'), cursorAccent: v('--editor'), selectionBackground: v('--sel') };
}

function termFit() {
  if (!TM.term || $('#termBody').hidden) return;
  try { TM.fit.fit(); } catch { /* not laid out yet */ }
}

// A second caller while a shell is starting waits for the same start, so Dispatch can type once the shell exists.
function termStart() {
  if (TM.id) return Promise.resolve();
  if (TM.starting) return TM.starting;
  if (!A.root) { TM.term.writeln('Open a folder to start a shell in it.'); return Promise.resolve(); }
  TM.starting = (async () => {
    const r = await host.termOpen(TM.term.cols, TM.term.rows);
    TM.starting = false;
    if (r.error) { TM.term.writeln(`\r\n${r.error}`); return; }
    if (r.cancelled) { TM.term.writeln('\r\nNo shell was started because this folder is not trusted. Press Enter to be asked again.'); return; }
    TM.id = r.id;
  })();
  return TM.starting;
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
    host.onTermData((id, s) => { if (id === TM.id) { TM.lastData = Date.now(); TM.term.write(s); } });
    host.onTermExit((id, code) => {
      if (id !== TM.id) return;
      TM.id = null;
      TM.term.writeln(`\r\n[The shell exited${code != null ? ` with code ${code}` : ''}. Press Enter to start a new one in ${A.root ? A.root.root : 'the open folder'}.]`);
    });
  }
  termFit();
  await termStart();
  TM.term.focus();
}

// Dispatch: types the person's own build command (designc.json dispatch) for a frozen handover into the shell,
// without Enter. The person reads it and presses Enter; designc runs nothing. Human only: no agent tool reaches it.
function dispatchSetting() { return Dispatch.settings(A.cfg.dispatch); }
function dispatchAbs(p) { return !p || /^([\\/]|[A-Za-z]:[\\/])/.test(p) ? p : `${A.root.root}/${p}`; }
async function dispatchHandover(id, item) {
  const s = dispatchSetting();
  if (!s) return;
  if (s.error) { toast(s.error, 'error'); return; }
  const cmd = Dispatch.command(s.command, {
    handover: dispatchAbs(`handovers/${id}`), registry: A.root.root,
    repo: dispatchAbs((item && item.repo) || A.cfg.codebase || null), base: (A.cfg.work || {}).mainBranch || 'main',
  }, A.platform);
  if (cmd.error) { toast(cmd.error, 'error'); return; }
  const fresh = !TM.id;
  showPanel('terminal');
  await termShow();
  // A shell that has just started is still printing its prompt; text typed before it is echoed twice.
  if (fresh && TM.id) for (const t0 = Date.now(); Date.now() - t0 < 3000 && !(TM.lastData && Date.now() - TM.lastData > 300);) await new Promise(r => setTimeout(r, 50));
  if (!TM.id) { toast('No shell is running, so nothing was typed. Start one in the Terminal and press Dispatch again.', 'warning'); return; }
  host.termInput(TM.id, cmd);
  TM.term.focus();
  toast('The command is in the Terminal. Read it, then press Enter to run it.');
}
