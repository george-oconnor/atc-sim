/* Live speech input.
 *
 * Shows what you are saying as you say it: interim words appear dim, then
 * light up and take their phraseology colour once the recogniser commits
 * them. The strip scrolls so the newest word stays in view. */
(function (ATC) {
  'use strict';
  const S = ATC.speech;

  /** The scrolling strip of words. */
  class LiveTranscript {
    constructor(el) {
      this.el = el;
      this.reset();
    }

    reset() {
      if (!this.el) return;
      this.el.className = 'livert';
      // Built as nodes rather than parsed from an HTML string: no reliance on
      // innerHTML round-tripping, and the references cannot come back null.
      LiveTranscript.empty(this.el);
      this.fin = document.createElement('span');
      this.fin.className = 'final';
      this.int = document.createElement('span');
      this.int.className = 'interim';
      this.el.appendChild(this.fin);
      this.el.appendChild(this.int);
      this.committed = 0;      // words already locked in
    }

    static empty(el) {
      while (el.lastChild) el.removeChild(el.lastChild);
    }

    static words(text) {
      return String(text).trim().split(/\s+/).filter(Boolean);
    }

    /**
     * finalText: everything the recogniser has committed this utterance.
     * interimText: its current guess at what is still being said.
     */
    update(finalText, interimText) {
      if (!this.el) return;
      this.el.hidden = false;

      // Append only the newly committed words, so only they animate.
      const fw = LiveTranscript.words(finalText);
      for (let i = this.committed; i < fw.length; i++) {
        const sp = document.createElement('span');
        sp.className = 'w f ' + S.role(fw[i]);
        sp.textContent = fw[i];
        this.fin.appendChild(sp);
      }
      this.committed = fw.length;

      // The interim guess gets rewritten wholesale -- it changes constantly.
      const iw = LiveTranscript.words(interimText);
      LiveTranscript.empty(this.int);
      iw.forEach(w => {
        const sp = document.createElement('span');
        sp.className = 'w i';
        sp.textContent = w;
        this.int.appendChild(sp);
      });

      this.el.scrollLeft = this.el.scrollWidth;   // keep the newest word visible
    }

    /** Colour the strip by how the transmission was received. */
    flash(kind) {
      if (!this.el) return;
      this.el.classList.add('flash-' + kind);
    }

    clear() {
      if (!this.el) return;
      this.el.hidden = true;
      this.reset();
    }
  }

  /**
   * A small bar graph that stands in for the input box while you are
   * speaking. It does NOT open its own microphone stream -- a second
   * getUserMedia alongside SpeechRecognition's own capture is exactly the
   * kind of thing that fails silently on phones (the mic is already taken),
   * which left this showing a blank box that looked just like an empty
   * input. Instead it animates from the recogniser's own activity: call
   * pulse() whenever voice.js reports audio, and the bars jump up and decay
   * back down on their own.
   *
   * Deliberately NOT a requestAnimationFrame loop running the whole time
   * you are listening: on the sim page that is a second permanent 60fps
   * loop stacked on top of the radar's own, and the competition for the
   * main thread was enough to start starving SpeechRecognition's audio
   * pipeline -- it began stopping and restarting itself in a tight loop
   * (the mic icon flashing) instead of just running quietly. A short
   * setTimeout chain that dies out a couple of seconds after each pulse,
   * and does nothing at all between words, costs far less.
   */
  class SoundGraph {
    constructor(canvas) {
      this.canvas = canvas;
      this.timer = null;
      this.level = 0;
      this.bars = null;
    }

    start() {
      if (!this.canvas) return;
      this.canvas.hidden = false;
      this.level = 0;
      this.bars = new Array(24).fill(0.15);
      this.draw();
    }

    draw() {
      if (!this.canvas || !this.bars) return;
      const canvas = this.canvas, ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height, n = this.bars.length, barW = w / n;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#4dffb0';
      for (let i = 0; i < n; i++) {
        this.bars[i] += (Math.random() - 0.5) * 0.5;
        this.bars[i] = Math.max(0.15, Math.min(1, this.bars[i]));
        const barH = Math.max(2, this.bars[i] * this.level * h);
        ctx.fillRect(i * barW + 1, h - barH, barW - 2, barH);
      }
    }

    /** Speech is actually happening right now -- jump the level up and
     *  let it visibly decay back down over the next couple of seconds.
     *  `strength` below 1 is for events that only mean "the mic is open"
     *  (onHeard): drawn at full height, that looked like a burst of loud
     *  speech every time the mic switched on, before a word was said. */
    pulse(strength) {
      if (!this.canvas || !this.bars) return;
      this.level = Math.max(this.level, strength === undefined ? 1 : strength);
      clearTimeout(this.timer);
      const tick = () => {
        this.draw();
        this.level *= 0.85;
        if (this.level > 0.02) this.timer = setTimeout(tick, 90);
        else { this.level = 0; this.draw(); this.timer = null; }
      };
      tick();
    }

    stop() {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.canvas) {
        this.canvas.hidden = true;
        this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  /**
   * The recogniser's top guess is picked for sounding like ordinary English,
   * not for sounding like phraseology -- "tell her for 69 kind flight level"
   * outranks "Delta four six nine, climb to flight level" even when both were
   * offered. Score each alternative by how much of it is recognisable
   * phraseology (callsign, keyword or digit, via the same `role()` the live
   * transcript colours words with) and take the best-covered one instead of
   * always trusting alternative zero.
   */
  function phraseologyScore(text) {
    const tok = S.tokenize(text);
    if (!tok.length) return -1;
    let hits = 0;
    tok.forEach(t => { if (S.role(t) !== 'x') hits++; });
    return hits / tok.length;
  }

  function bestAlternative(result) {
    let best = result[0].transcript;
    let bestScore = phraseologyScore(best);
    for (let k = 1; k < result.length; k++) {
      const score = phraseologyScore(result[k].transcript);
      if (score > bestScore) { bestScore = score; best = result[k].transcript; }
    }
    return best;
  }

  // Chrome, Firefox, Edge and Opera on iPhone/iPad are WebKit underneath,
  // and refuse speech recognition with a "not-allowed" that reads like a
  // permission problem -- but no permission setting fixes it. Only Safari
  // has it working, so say that instead of sending people to their settings.
  const IOS_NOT_SAFARI = typeof navigator !== 'undefined' &&
    /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent || '');
  const IOS_NOT_SAFARI_START = 'On iPhone and iPad, speech recognition only works ' +
    'in Safari. Open this page in Safari to speak, or type instead.';
  const IOS_NOT_SAFARI_TEXT = 'Speech recognition does not work in this browser on ' +
    'iPhone or iPad, whatever the microphone permission says. Open this page in ' +
    'Safari to speak, or type instead.';

  /** Turn a SpeechRecognition error code into something worth reading. */
  const ERROR_TEXT = {
    'not-allowed': 'Microphone permission was denied. Check the padlock or ' +
      'site settings and allow the microphone, then try again.',
    'service-not-allowed': 'The browser blocked speech recognition. Some ' +
      'in-app browsers (Instagram, Facebook, etc.) do not allow it -- open ' +
      'this page in Chrome or Safari directly.',
    'audio-capture': 'No microphone was found.',
    'no-speech': "Didn't catch anything -- try again, a little closer to the mic.",
    'network': 'Speech recognition needs a network connection to work.',
    'aborted': null,          // you stopped it yourself -- not an error
    'language-not-supported': 'This browser cannot recognise that language.',
  };

  /**
   * Wrap SpeechRecognition, with nothing left to fail silently.
   *
   * opts:
   *   onInterim(finalSoFar, interim)  called continuously while speaking
   *   onFinal(text, alternatives)     one complete transmission, and per
 *                                   phrase every alternative offered for it
   *   onState(listening, reason)      mic turned on or off; reason is 'idle'
   *                                   when it stopped itself after IDLE_MS of
   *                                   silence, 'sent' after a transmission
   *   isBusy()                        true while a pilot is on air -- anything
   *                                   heard then is their readback coming out
   *                                   of the speakers, not you, and is dropped
   *   onHeard()                       audio is actually reaching the recogniser
   *   onWarmupRetry()                 silently restarting a cold mic that hasn't
   *                                   heard anything yet -- still no cause for alarm
   *   onError(message)                something worth telling the user
   *   onUnsupported(reason)           no speech recognition in this browser;
   *                                   `reason` is set when there is something
   *                                   more specific to say than that
   */
  // Tap to talk has no release to end it, so a forgotten tap would leave the
  // mic open (and the next pilot readback getting transcribed as you) for
  // ever. Eight seconds without a word recognised closes it.
  const IDLE_MS = 8000;

  function makeVoice(opts) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Not just a missing API: on iPhone/iPad, every browser except Safari
    // has the API but refuses to run it (see IOS_NOT_SAFARI), and that only
    // shows up as an error once you are already in the exercise. Say so up
    // front instead, so speaking is never offered.
    if (!SR || IOS_NOT_SAFARI) {
      if (opts.onUnsupported) opts.onUnsupported(SR ? IOS_NOT_SAFARI_START : null);
      return { supported: false, toggle: function () {}, stop: function () {} };
    }

    const rec = new SR();
    rec.lang = 'en-GB';
    // Continuous mode is where this kept dying instantly and restarting in a
    // loop (the mic indicator flashing) with no audio ever heard. We already
    // restart on every onend ourselves below, so a single long-running
    // continuous session was never load-bearing -- false plays to the
    // ordinary single-utterance case every implementation supports, and our
    // own restart loop reassembles that into something continuous-feeling.
    rec.continuous = false;
    rec.interimResults = true;      // this is what makes it live
    rec.maxAlternatives = 8;        // dictation guesses ordinary English over
                                     // phraseology -- the right words are often
                                     // in here, just not ranked first

    let listening = false;
    let committed = '';
    // Every alternative the recogniser offered for each phrase in
    // `committed`, not just the one picked -- handed to onFinal so a
    // transcription report can show what else it nearly heard.
    let committedAlts = [];
    let heardAnything = false;
    let watchdog = null;
    let restartTimer = null;
    let idleTimer = null;
    let ignoring = false;      // this session overlapped a pilot readback -- drop it
    let noAudioRestarts = 0;   // consecutive onend->restart cycles with no audio ever heard
    let warmupRetried = false; // one silent cold-start retry per session, not a loop
    let primed = false;        // has prime() already run once this page load?
    let suppressNextEnd = 0;   // an onend we already know is coming and have already handled

    // Temporary diagnostic trail: this class of bug (the button/status
    // disagreeing with what the recogniser is actually doing) has taken
    // several rounds of guesswork to even partially pin down, because a
    // screenshot can only show one instant, not the sequence and timing
    // that actually produced it. Open the browser console (desktop: F12 or
    // Cmd+Opt+I; iOS Safari: connect to a Mac and use Develop > your
    // device) and every real event is logged here with a timestamp.
    function trace(label) {
      try { console.log('[voice %dms] %s (listening=%s)', Date.now() % 1000000, label, listening); }
      catch (_) { /* no console -- nothing to do about it */ }
    }

    function report(err) {
      if (!opts.onError) return;
      const blocked = err === 'not-allowed' || err === 'service-not-allowed';
      const text = blocked && IOS_NOT_SAFARI ? IOS_NOT_SAFARI_TEXT
        : ERROR_TEXT.hasOwnProperty(err) ? ERROR_TEXT[err]
        : 'Speech recognition error: ' + err;
      if (text) opts.onError(text);
    }

    // The very first start after a while often never actually wakes the
    // microphone up at all -- no audio, no error, nothing -- while simply
    // stopping and starting fresh again reliably does. Rather than making
    // everyone discover and do that dance by hand, do it ourselves once,
    // silently, before ever bothering anyone with an error: if nothing has
    // been heard within 1.5s, stop (which triggers the ordinary restart
    // path below) and give it one clean second run. Only if THAT also
    // hears nothing do we call it a real problem.
    function armWatchdog() {
      clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (!listening || heardAnything) return;
        if (!warmupRetried) {
          warmupRetried = true;
          noAudioRestarts = 0;      // an expected retry, not a sign of trouble
          trace('watchdog: cold after 1.5s, retrying silently');
          if (opts.onWarmupRetry) opts.onWarmupRetry();
          try { rec.stop(); } catch (_) {}
          return;
        }
        trace('watchdog: cold again after the retry -- reporting the error');
        if (opts.onError) {
          opts.onError('The microphone is on, but nothing is being heard. ' +
            'Check the browser has picked the right microphone, and that it ' +
            'is not muted.');
        }
      }, 1500);
    }

    rec.onstart = function () { trace('rec.onstart'); armWatchdog(); };

    // Counted from the tap, then restarted once the mic is actually live
    // (so a slow warm-up doesn't eat into your eight seconds) and again on
    // every word recognised. Deliberately NOT restarted by the recogniser's
    // own stop/start cycling between utterances -- that happens after every
    // pause, and would otherwise keep a silent mic open indefinitely.
    function armIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (!listening) return;
        trace('idle: nothing heard for ' + IDLE_MS + 'ms -- stopping');
        stopListening('idle');
      }, IDLE_MS);
    }

    // Fired as soon as the recogniser detects any audio at all -- long
    // before it has understood a word. Enough to prove the mic is live.
    rec.onaudiostart = function () {
      trace('rec.onaudiostart/onspeechstart');
      if (!heardAnything && listening) armIdle();   // mic just went live
      heardAnything = true;
      clearTimeout(watchdog);
      noAudioRestarts = 0;   // a session that actually got audio was a healthy one
      // Starting the recogniser has real, sometimes multi-second latency
      // (permission checks, the mic actually warming up) -- long enough
      // that this can fire well after stop() was already called. It's only
      // a "still listening" nicety, so once we are not listening any more
      // it should not resurrect the status line saying we are.
      if (opts.onHeard && listening) opts.onHeard();
      else if (opts.onHeard) trace('  (suppressed: not listening any more)');
    };
    rec.onspeechstart = rec.onaudiostart;

    rec.onresult = e => {
      trace('rec.onresult');
      heardAnything = true;
      clearTimeout(watchdog);
      // The whole rest of the session, not just this one result: the
      // utterance that started during the readback still has its words in
      // every later result until the recogniser ends it. Doesn't count
      // towards the idle countdown either -- it wasn't you.
      if (opts.isBusy && opts.isBusy()) ignoring = true;
      if (ignoring) {
        trace('  (ignored: a pilot is on air)');
        committed = ''; committedAlts = [];
        return;
      }
      if (listening) armIdle();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const txt = result.isFinal ? bestAlternative(result) : result[0].transcript;
        if (result.isFinal) {
          committed += (committed ? ' ' : '') + txt.trim();
          const alts = [];
          for (let k = 0; k < result.length; k++) {
            alts.push({ transcript: result[k].transcript, confidence: result[k].confidence });
          }
          committedAlts.push(alts);
        } else interim += txt;
      }
      // Same reasoning as onHeard above: once you have tapped to stop,
      // anything still trickling in from the recogniser is discarded --
      // neither shown nor sent. Stopping means "cancel what I was saying".
      if (!listening) {
        committed = ''; committedAlts = [];
        trace('  (discarded: not listening any more)');
        return;
      }
      if (opts.onInterim) opts.onInterim(committed, interim.trim());

      // A pause ends the transmission: send it and start a fresh one.
      const ended = Array.prototype.some.call(e.results, r => r.isFinal) && !interim.trim();
      if (ended && committed) {
        const text = committed, alts = committedAlts;
        committed = ''; committedAlts = [];
        if (opts.onFinal) opts.onFinal(text, alts);
        // One tap, one transmission, as on a real radio -- and the mic is
        // already closed by the time the pilot's readback comes out of the
        // speakers, so it can't be transcribed as your next instruction.
        stopListening('sent');
      }
    };

    rec.onerror = ev => {
      trace('rec.onerror: ' + ev.error);
      const terminal = ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ||
        ev.error === 'audio-capture' || ev.error === 'language-not-supported';
      if (terminal) {
        // Nothing will fix itself by retrying these -- stop rather than spin.
        // onState(false) first: it clears the status line on the way out, so
        // report()'s message below is the one left showing, not wiped by it.
        listening = false;
        clearTimeout(watchdog);
        try { rec.stop(); } catch (_) {}
        if (opts.onState) opts.onState(false);
      }
      report(ev.error);
      // 'no-speech' and 'network' are left to onend, which restarts below.
    };

    rec.onend = () => {
      trace('rec.onend');
      clearTimeout(watchdog);
      ignoring = false;
      if (suppressNextEnd > 0) {
        suppressNextEnd--;
        trace('  (suppressed -- already handled by the start() that caused it)');
        return;
      }
      if (!listening) { trace('  (not listening -- no restart)'); return; }

      // On some browsers/devices the underlying session ends the instant it
      // starts -- no audio, no error, nothing -- and restarting just repeats
      // that forever: the mic permission indicator flickers on and off
      // instead of settling down. Counted by consecutive restarts rather
      // than a time window, because on a slow device each dead cycle can
      // itself take a couple of seconds -- a window would never fill up
      // even though it is clearly stuck. Four in a row with no audio ever
      // heard is stuck; give up and say so rather than spinning forever.
      noAudioRestarts++;
      if (noAudioRestarts > 4) {
        listening = false;
        noAudioRestarts = 0;
        // onState first: it clears the status line on the way out, so the
        // message below is the one left showing, not wiped by it.
        if (opts.onState) opts.onState(false);
        if (opts.onError) {
          opts.onError('Speech recognition keeps stopping and restarting without ' +
            'connecting to the microphone. Try again, or type the transmission instead.');
        }
        return;
      }

      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!listening) { trace('  restart timer fired, but no longer listening'); return; }
        trace('  restarting after onend (#' + noAudioRestarts + ')');
        try { rec.start(); armWatchdog(); }
        catch (err) {
          // Restarting immediately after certain errors (most often
          // 'not-allowed' on some browsers) throws straight back out, which
          // would otherwise spin silently -- surface it once and give up.
          listening = false;
          if (opts.onState) opts.onState(false);
          if (opts.onError) {
            opts.onError('Speech recognition stopped and could not restart' +
              (err && err.message ? ' (' + err.message + ')' : '') + '.');
          }
        }
      }, 250);
    };

    // Idempotent: a held-down key or button fires its "down" event more than
    // once (key repeat, a stray second pointerdown) and must not re-trigger
    // a start every time -- only the transition off-to-on actually does
    // anything.
    function startListening() {
      if (listening) return;
      trace('startListening()');
      listening = true;
      committed = ''; committedAlts = [];
      heardAnything = false;
      noAudioRestarts = 0;
      warmupRetried = false;
      ignoring = false;
      armIdle();
      try {
        rec.start();
        armWatchdog();
      } catch (err) {
        // Most often InvalidStateError: start() called while it thinks it
        // is already running -- which priming or an in-flight warm-up
        // retry can genuinely cause. Stop and retry once, synchronously,
        // rather than silently doing nothing. That stop() still fires
        // onend asynchronously later, and by then `listening` is already
        // true here -- without suppressNextEnd, onend would see that and
        // schedule ANOTHER restart on top of the one just done below,
        // fighting over the same recogniser.
        trace('  start() threw (' + (err && err.message) + ') -- stopping and retrying once');
        suppressNextEnd++;
        try { rec.stop(); } catch (_) {}
        try { rec.start(); armWatchdog(); }
        catch (err2) {
          listening = false;
          if (opts.onError) {
            opts.onError('Could not start the microphone' +
              (err2 && err2.message ? ' (' + err2.message + ')' : '') + '.');
          }
        }
      }
      if (opts.onState) opts.onState(listening);
    }

    function stopListening(reason) {
      if (!listening) return;
      trace('stopListening(' + (reason || '') + ')');
      listening = false;
      committed = ''; committedAlts = [];   // an unfinished transmission is dropped, never sent
      clearTimeout(watchdog);
      clearTimeout(restartTimer);
      clearTimeout(idleTimer);
      try { rec.stop(); } catch (_) {}
      if (opts.onState) opts.onState(false, reason);
    }

    // Every visible callback above is gated on `listening`, which this
    // deliberately never sets true -- so this never shows "Warming up" or
    // "Hearing you" or anything else. It exists purely because the mic's
    // very first ever start on a page is consistently the slow/unreliable
    // one (this is the exact stop-then-start-again dance that reliably
    // fixed it by hand), so doing that once here, invisibly, as soon as
    // speak mode is chosen, means your first real tap is already the
    // "second, working" attempt instead of the first one.
    function prime() {
      if (listening || primed) return;
      primed = true;
      try {
        rec.start();
        setTimeout(() => {
          if (listening) return;   // a real session has since taken over -- leave it be
          try { rec.stop(); } catch (_) {}
        }, 300);
      } catch (_) {}
    }

    return {
      supported: true,
      get listening() { return listening; },
      start: startListening,
      stop: function () { stopListening(); },
      prime: prime,
      toggle: function () { if (listening) stopListening(); else startListening(); },
    };
  }

  /**
   * The talk button and space bar, wired once and shared by every page that
   * offers them. `getVoice` and `isActive` are functions, not values,
   * because the voice object and the current mode are both created/changed
   * after this runs.
   *
   * This is a TAP to start, TAP again to stop -- not a press-and-hold.
   * Hold-to-talk was tried first (it is the more obvious real-radio
   * analogy) and never worked reliably: a mouse "click" or a screen tap is
   * a press and release only milliseconds apart, so the mic was open for a
   * fraction of a second while whatever the recogniser then delivered kept
   * arriving well after the button/key had already told everything to stop
   * -- graph and transcript ended up telling two different stories about
   * whether it was listening. Tapping to start and tapping again to stop
   * has no press-duration to get right, so there is nothing left to race.
   *
   * The button and the space bar only ever start or stop the recogniser.
   * They deliberately do not touch the sound graph -- see setupVoice() in
   * ui.js/drill.js, which drives the graph from the recogniser's own
   * onState callback instead, so the graph can never show "listening" when
   * the recogniser itself does not agree that it is.
   */
  // What the button itself says and looks like at each stage -- not just
  // the small status line, because the button is the biggest, hardest to
  // miss thing on the screen, and "don't speak yet" needs to actually be
  // seen before it is ignored.
  // Touch-only devices (phones, tablets without a trackpad) have no space
  // bar to mention.
  const TOUCH_ONLY = !!(window.matchMedia &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  const STOP_HINT = TOUCH_ONLY ? 'tap again to stop' : 'tap again to stop, or press space';
  const PTT_PHASE = {
    idle: {
      cls: '', label: '\u{1F3A4} Tap to talk',
      hint: STOP_HINT,
    },
    warming: {
      cls: 'on warming', label: '⏳ Warming up…',
      hint: 'Wait for it — don’t speak yet',
    },
    heard: {
      cls: 'on', label: '\u{1F534} Listening — speak now',
      hint: STOP_HINT,
    },
    // Not a recogniser state: a pilot is about to read back, or is.
    blocked: {
      cls: 'blocked', label: '\u{1F4FB} Pilot on frequency',
      hint: 'wait for the readback',
    },
  };

  function setupPushToTalk(button, getVoice, isActive) {
    const label = button.querySelector('.pttlabel');
    const hint = button.querySelector('.ptthint');

    /** Called from voice.js's own onState/onWarmupRetry/onHeard callbacks
     *  (see setupVoice() in ui.js/drill.js) -- the button's phase always
     *  matches what the recogniser itself just reported, not a guess. */
    let phase = 'idle';
    let blocked = false;
    function show() {
      // Only blocks starting: if the mic is already open it can still be
      // tapped off.
      const shut = blocked && phase === 'idle';
      const p = shut ? PTT_PHASE.blocked : (PTT_PHASE[phase] || PTT_PHASE.idle);
      button.className = 'pttbtn' + (p.cls ? ' ' + p.cls : '');
      if (label) label.textContent = p.label;
      if (hint) hint.textContent = p.hint;
      button.disabled = shut;
    }
    function setPhase(p) { phase = p; show(); }
    /** A pilot is about to read back, or is reading back: no starting a
     *  transmission until they are done. Stopping one is always allowed. */
    function setBlocked(on) { blocked = !!on; show(); }
    show();      // replaces the page's static hint (which mentions space)

    function setListening(on) {
      const voice = getVoice();
      if (!voice) return;
      if (on) voice.start(); else voice.stop();
    }
    let lastToggleAt = 0;
    function toggle() {
      const voice = getVoice();
      if (!isActive() || !voice) return;
      if (blocked && !voice.listening) return;
      // A hard debounce, not just the `!e.repeat` check below -- holding a
      // key a little too long reliably reproduced a second keydown that
      // was NOT flagged as a repeat in at least one real environment, and
      // that turned "tap to stop" into "off, then immediately back on"
      // before anyone could see the off state settle. Anything within
      // 350ms of the last toggle is almost certainly the same physical
      // press restating itself, not a second deliberate one.
      const now = Date.now();
      if (now - lastToggleAt < 350) {
        try { console.log('[ptt] toggle ignored -- ' + (now - lastToggleAt) + 'ms since the last one'); } catch (_) {}
        return;
      }
      lastToggleAt = now;
      try { console.log('[ptt] toggle -- currently listening=' + voice.listening); } catch (_) {}
      setListening(!voice.listening);
    }

    // Pointer events cover mouse, touch and pen in one place. preventDefault
    // on both pointerdown and mousedown (browsers derive click-focus from
    // either) keeps the button from ever taking keyboard focus, which
    // matters for the listener below.
    button.addEventListener('pointerdown', e => { e.preventDefault(); toggle(); });
    button.addEventListener('mousedown', e => e.preventDefault());
    // Belt and braces for mobile Safari: its Pointer Events support for a
    // touch tap, and what counts as a "trusted" gesture for microphone
    // access, have both had real gaps across iOS versions. `click` is the
    // one event every browser reliably fires for a tap regardless, so it
    // is a fallback here rather than the only path -- if pointerdown
    // already handled this same tap, the debounce above absorbs the
    // duplicate; if pointerdown never fired at all, this is what saves it.
    button.addEventListener('click', e => { e.preventDefault(); toggle(); });

    // Space bar: the keyboard equivalent. Capture phase, not bubble: if
    // focus is sitting on some other native control (a <select>, another
    // button) when Space is pressed, that control's own default handling
    // runs during the bubble phase and can otherwise win the race --
    // capture on document fires first, before the event ever reaches that
    // element. `e.repeat` matters here in a way it never did for hold: a
    // held key fires keydown over and over, and without this guard every
    // one of those repeats would toggle listening on then off then on.
    const isSpace = e => e.key === ' ' || e.code === 'Space';
    document.addEventListener('keydown', e => {
      if (isSpace(e) && isActive() && !e.repeat) { e.preventDefault(); toggle(); }
      else if (isSpace(e) && isActive()) { e.preventDefault(); }
    }, true);

    return { toggle, stop: () => setListening(false), setPhase, setBlocked };
  }

  ATC.LiveTranscript = LiveTranscript;
  ATC.SoundGraph = SoundGraph;
  ATC.makeVoice = makeVoice;
  ATC.setupPushToTalk = setupPushToTalk;
})(window.ATC = window.ATC || {});
