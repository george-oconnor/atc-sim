/* Phraseology drill: random prompts, graded with the same parser the
 * simulator uses, so what passes here passes there. */
(function (ATC) {
  'use strict';
  const S = ATC.speech, G = ATC.geo;

  const PREFIX = ['AAL', 'DAL', 'UAL'];
  const rnd = n => Math.floor(Math.random() * n);
  const pick = a => a[rnd(a.length)];

  /** Just enough of an aircraft for the parser to grade against. */
  class DrillAC {
    constructor(cs, hdg, fl) {
      this.callsign = cs;
      this.prefix = cs.slice(0, 3);
      this.digits = cs.slice(3);
      this.airline = ATC.AIRLINES[this.prefix];
      this.hdg = hdg;
      this.alt = fl * 100;
    }
    get fl() { return Math.round(this.alt / 100); }
    spoken() { return this.airline.spoken + ' ' + S.digits(this.digits); }
    shorterTurn(h) { return G.angDiff(h, this.hdg) >= 0 ? 'R' : 'L'; }
  }

  function makeCallsign() {
    const n = Math.random() < 0.4 ? rnd(90) + 10 : rnd(900) + 100;
    return pick(PREFIX) + n;
  }

  function makeQuestion() {
    const cs = makeCallsign();
    const hdg = rnd(36) * 10;
    const fl = (rnd(12) + 20) * 10;
    const ac = new DrillAC(cs, hdg || 360, fl);

    if (Math.random() < 0.45) {
      // Turn. Keep the turn well clear of 180 so one direction is clearly shorter.
      let delta = (rnd(14) + 3) * 10 * (Math.random() < 0.5 ? 1 : -1);
      const tgt = G.norm360(ac.hdg + delta);
      return {
        ac,
        prompt: cs + ' is heading ' + G.fmtHdg(ac.hdg) +
          '. Turn it onto heading ' + G.fmtHdg(tgt) + '.',
        expect: { kind: 'turn', hdg: tgt, dir: ac.shorterTurn(tgt) },
      };
    }
    const up = Math.random() < 0.5;
    const tgtFl = fl + (up ? 10 : -10) * (rnd(3) + 1);
    return {
      ac,
      prompt: cs + ' is at FL' + String(fl).padStart(3, '0') + '. ' +
        (up ? 'Climb' : 'Descend') + ' it to FL' + String(tgtFl).padStart(3, '0') + '.',
      expect: { kind: 'level', fl: tgtFl },
    };
  }

  function start() {
    // See the matching guard in main.js: Rocket Loader reprocessing this
    // script (or anything else that runs it twice) would otherwise attach
    // a second full set of mic/keyboard/button listeners on top of the
    // first's, with nothing removing either.
    if (window.__atcDrillStarted) return;
    window.__atcDrillStarted = true;

    const el = id => document.getElementById(id);
    const promptEl = el('prompt'), input = el('answer'), fb = el('feedback');
    const statEl = el('dstat');
    const modechoice = el('modechoice'), drillbody = el('drillbody');
    const modeTypeBtn = el('modeType'), modeSpeakBtn = el('modeSpeak');
    const switchBtn = el('switchMode'), soundEl = el('soundgraph');
    const modeNote = el('modeNote'), ptt = el('ptt');
    let q = null, asked = 0, right = 0, streak = 0, best = 0, t0 = 0;
    let mode = null, speechSupported = true;

    const fakeSim = { byCallsign: cs => (q && q.ac.callsign === cs ? q.ac : null) };

    function next() {
      q = makeQuestion();
      promptEl.textContent = q.prompt;
      input.value = '';
      if (mode === 'type') input.focus();
      t0 = performance.now();
    }

    function stats() {
      statEl.innerHTML = '<span>asked <b>' + asked + '</b></span>' +
        '<span>correct <b>' + right + '</b></span>' +
        '<span>streak <b>' + streak + '</b></span>' +
        '<span>best <b>' + best + '</b></span>';
    }

    function grade(text) {
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const r = S.parse(text, fakeSim);
      asked++;
      const modelTx = S.model(q.ac, q.expect);

      if (!r.ok) {
        streak = 0;
        fb.className = 'fb bad';
        fb.innerHTML = '<b>' + r.error + '</b><div class="model">Say: &ldquo;' +
          modelTx + '&rdquo;</div>';
      } else if (!r.action) {
        streak = 0;
        fb.className = 'fb bad';
        fb.innerHTML = '<b>No instruction — only the callsign.</b>' +
          '<div class="model">Say: &ldquo;' + modelTx + '&rdquo;</div>';
      } else {
        const a = r.action, e = q.expect;
        const matches = a.kind === e.kind &&
          (e.kind === 'turn' ? a.hdg === e.hdg && a.dir === e.dir : a.fl === e.fl);
        if (matches && !r.notes.length) {
          right++; streak++; best = Math.max(best, streak);
          fb.className = 'fb good';
          fb.innerHTML = '<b>Correct — ' + secs + ' s</b>';
        } else {
          streak = 0;
          fb.className = 'fb bad';
          const why = !matches
            ? (a.kind !== e.kind ? 'Wrong kind of instruction.'
               : e.kind === 'turn'
                 ? (a.hdg !== e.hdg ? 'Heading should be ' + G.fmtHdg(e.hdg) + '.'
                    : 'Turn ' + (e.dir === 'L' ? 'left' : 'right') + ' is the shorter way.')
                 : 'Flight level should be ' + String(e.fl).padStart(3, '0') + '.')
            : '';
          fb.innerHTML = '<b>' + (why || 'Phraseology') + '</b>' +
            r.notes.map(n => '<div class="note">' + n + '</div>').join('') +
            '<div class="model">Say: &ldquo;' + modelTx + '&rdquo;</div>';
        }
      }
      stats();
    }

    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (input.value.trim()) { grade(input.value); input.dataset.graded = '1'; }
      else if (input.dataset.graded) { input.dataset.graded = ''; fb.className = 'fb'; fb.innerHTML = ''; next(); }
    });
    el('skip').addEventListener('click', () => {
      fb.className = 'fb'; fb.innerHTML = ''; input.dataset.graded = ''; next();
    });

    // Voice, with the same live transcript as the simulator, plus a level
    // meter that stands in for the input box while speaking.
    const lt = new ATC.LiveTranscript(el('livert'));
    const sound = new ATC.SoundGraph(soundEl);
    const status = el('micStatus');
    let advance = null;

    const setStatus = (text, cls) => {
      if (!status) return;
      status.hidden = !text;
      status.textContent = text || '';
      status.className = 'micstatus' + (cls ? ' ' + cls : '');
    };

    const voice = ATC.makeVoice({
      onInterim: (committed, interim) => {
        setStatus('');
        lt.update(committed, interim);
        if (interim) sound.pulse();
      },
      onFinal: text => {
        lt.update(text, '');
        grade(text);
        lt.flash(fb.className.indexOf('good') >= 0 ? 'ok' : 'err');
        input.dataset.graded = '1';
        clearTimeout(advance);
        advance = setTimeout(() => {
          if (mode !== 'speak') return;
          lt.clear();
          fb.className = 'fb'; fb.innerHTML = '';
          input.dataset.graded = '';
          next();
        }, 2600);
      },
      // The sound graph is driven from here, not from the button/space
      // handler -- this is the recogniser's own report of its state, so
      // the graph can never show "listening" when it disagrees.
      //
      // Stopping does NOT clear the transcript or status: starting the
      // recogniser has real, sometimes multi-second latency, so what you
      // said can easily still be arriving after you have already tapped to
      // stop. Wiping the display the instant you stop meant that trailing
      // text/status reappeared looking like it came from nowhere -- onFinal
      // above still fires and grades it normally either way.
      onState: (on, reason) => {
        if (on) {
          lt.clear();
          setStatus('Warming up \u2014 wait, don\u2019t speak yet\u2026', 'warm');
          pttCtl.setPhase('warming');
          sound.start();
        } else {
          // Timed out on silence: say so, or the button flipping back by
          // itself looks like a glitch -- unless a mic error is already
          // showing, which is the better explanation of the silence.
          if (reason !== 'idle') setStatus('');
          else if (!(status && status.classList.contains('err'))) {
            setStatus('Stopped listening \u2014 nothing heard for 8 seconds. Tap to talk again.');
          }
          pttCtl.setPhase('idle');
          sound.stop();
        }
      },
      // The first start after a while often takes a moment (or two) to
      // actually wake the mic up -- this keeps saying so, and keeps the
      // button itself in its "don't speak yet" phase, rather than going
      // quiet while voice.js retries underneath.
      onWarmupRetry: () => {
        setStatus('Still warming up \u2014 wait for it\u2026', 'warm');
        pttCtl.setPhase('warming');
      },
      onHeard: () => {
        setStatus('Hearing you\u2026', 'ok');
        pttCtl.setPhase('heard');
        sound.pulse(0.25);   // the mic is open, not that you're speaking
      },
      onError: message => setStatus(message, 'err'),
      onUnsupported: reason => {
        speechSupported = false;
        modeSpeakBtn.disabled = true;
        modeSpeakBtn.title = reason || 'Speech recognition needs Chrome, Edge or Safari';
        switchBtn.hidden = true;
        modeNote.hidden = false;
        modeNote.textContent = reason || 'Speech recognition is not available in this ' +
          'browser — use Chrome, Edge or Safari, or type your answer instead.';
        modeNote.className = 'micstatus err';
      },
    });

    /** Show the input box for typing, or the push-to-talk button for speaking. */
    function applyMode(newMode) {
      if (newMode === 'speak' && !speechSupported) return;
      mode = newMode;
      const typing = mode === 'type';
      input.hidden = !typing;
      ptt.hidden = typing;
      switchBtn.hidden = !speechSupported;
      switchBtn.textContent = typing ? '\u{1F3A4} Speak instead' : '\u2328\uFE0F Type instead';
      if (typing) {
        pttCtl.stop();
        input.focus();
      } else {
        voice.prime();
      }
    }
    switchBtn.addEventListener('click', () => applyMode(mode === 'type' ? 'speak' : 'type'));

    // Tap to talk: tap to start listening, tap again to send, rather than an
    // open mic the whole time. Shared with the simulator page -- see
    // setupPushToTalk in voice.js for why it's a single implementation, not
    // two, and why it's a tap rather than a press-and-hold.
    const pttCtl = ATC.setupPushToTalk(ptt, () => voice, () => mode === 'speak');

    function chooseMode(newMode) {
      modechoice.hidden = true;
      drillbody.hidden = false;
      applyMode(newMode);
      stats();
      next();
    }
    modeTypeBtn.addEventListener('click', () => chooseMode('type'));
    modeSpeakBtn.addEventListener('click', () => chooseMode('speak'));
  }

  // Scripts can be executed after the document is already parsed
  // (Cloudflare Rocket Loader does exactly that), in which case
  // DOMContentLoaded has long since fired and never comes again.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window.ATC = window.ATC || {});
