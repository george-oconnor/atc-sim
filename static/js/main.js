(function (ATC) {
  'use strict';
  function start() {
    // Guard against this running twice. It has: Cloudflare's Rocket Loader
    // is documented (see the README) to reprocess script tags on this exact
    // site, and a live console trace showed two independent SpeechRecognition
    // sessions wired to the same button/space key -- two entire onstart/
    // onend/restart cycles fighting over one microphone, which is a far
    // simpler and more certain explanation for "flips back on by itself"
    // than any single-instance race inside voice.js. A second start() would
    // attach a second full set of listeners (mic, keyboard, buttons) on top
    // of the first's, which nothing removes them from.
    if (window.__atcStarted) return;
    window.__atcStarted = true;

    if (!window.SCENARIO && window.GENERATE) window.SCENARIO = generate(window.GENERATE);
    const sim = new ATC.Sim(window.SCENARIO);
    const radar = new ATC.Radar(document.getElementById('radar'), sim);
    const ui = new ATC.UI(sim, radar);
    ATC.current = { sim, radar, ui };

    let last = performance.now(), reported = false;
    (function frame(now) {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      sim.step(dt);
      radar.draw();
      ui.render();
      if (sim.finished && !reported) { reported = true; ui.finishRun(); }
      requestAnimationFrame(frame);
    })(last);
  }

  /** Unlimited mode: a fresh scenario from the seed in the URL, put through
   *  the same checks and the same auto-controller as the vetted pool. The
   *  seed is the whole recipe, so reloading flies the same one again. */
  function generate(g) {
    const r = ATC.gen.make(g.meta, g.seed);
    if (!r.scen) throw new Error('No usable scenario from seed ' + g.seed);
    r.scen.variant = 'seed:' + g.seed;
    const brief = document.querySelector('#startModal .brief');
    if (brief) brief.textContent = r.scen.briefing;
    return r.scen;
  }

  /** Put a failure on the screen -- there is no console on a phone. */
  function fail(what, err) {
    try {
      const b = document.createElement('div');
      b.id = 'bootfail';
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;' +
        'background:#6d1520;color:#fff;padding:10px 14px;white-space:pre-wrap;' +
        'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace';
      b.textContent = what + '\n' + ((err && (err.stack || err.message)) || err);
      document.body.appendChild(b);
    } catch (_) { /* nothing left to try */ }
  }

  function boot() {
    const run = () => {
      try {
        start();
      } catch (err) {
        fail('The simulator failed to start.', err);
      }
    };
    // Building a scenario takes a moment (a few seconds on a slow phone):
    // put a message up first rather than freezing on a blank page.
    if (!window.SCENARIO && window.GENERATE) {
      const note = document.createElement('div');
      note.className = 'building';
      note.textContent = 'Building a new scenario…';
      (document.querySelector('.radarwrap') || document.body).appendChild(note);
      setTimeout(() => { run(); note.remove(); }, 40);
    } else run();
  }

  window.addEventListener('error', function (ev) {
    if (document.getElementById('bootfail')) return;   // already reported
    fail('Script error.', ev.error || ev.message);
  });

  // Scripts can be executed after the document is already parsed (Cloudflare
  // Rocket Loader does exactly that), in which case DOMContentLoaded has long
  // since fired and never comes again.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.ATC = window.ATC || {});
