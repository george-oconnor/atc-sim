/* Controller position: transmission entry, flight strips, R/T log, HUD. */
(function (ATC) {
  'use strict';
  const G = ATC.geo, S = ATC.speech;
  // Spread across the bar, a row whose items would sit further apart than
  // this (px) is centred as a group instead -- see layoutBar().
  const SPARSE_GAP = 48;

  class UI {
    constructor(sim, radar) {
      this.sim = sim;
      this.radar = radar;
      this.selected = null;
      this.msgs = [];
      this.strict = true;          // phraseology graded
      this.mode = null;            // 'type' or 'speak', chosen at the start
      this.heardLog = [];          // recent spoken transmissions, for reports
      this.errStreak = 0;          // spoken transmissions not understood in a row
      this.speechSupported = true;
      this.radio = new ATC.Radio({
        onIssue: msg => this.say('⚠', msg, 'note'),
        onSpeak: (ac, text) => this.say(ac.callsign, S.tidy(text), 'pilot'),
        onBusyChange: busy => { if (this.pttCtl) this.pttCtl.setBlocked(busy); },
      });
      this.el = {};
      ['clock', 'score', 'stat', 'strips', 'cmd', 'cmdhint', 'rate',
       'pause', 'modal', 'helpTitle', 'helpBody', 'hint', 'mode', 'livert',
       'micStatus', 'cmdbody', 'switchMode', 'soundgraph', 'ptt',
       'startModal', 'modeType', 'modeSpeak', 'modeNote', 'startBtn', 'toast', 'notices', 'captions',
       'pausedOverlay']
        .forEach(k => { this.el[k] = document.getElementById(k); });
      this.setupSections();
      this.bind();
      // The first help modal on load leads into the speak-or-type prompt;
      // reopening help later (the "?" button, mid-run) is just help again.
      this.pendingStart = true;
      this.showHelp();
      radar.onPick = ac => this.select(ac);
    }

    /** The cog in the bar: a dropdown of display toggles. Closes on a tap
     *  outside it or Escape; flipping a toggle leaves it open. */
    setupSettings() {
      const btn = document.getElementById('settingsBtn');
      const menu = document.getElementById('settingsMenu');
      if (!btn || !menu) return;
      const open = show => {
        menu.hidden = !show;
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
        btn.classList.toggle('open', show);
      };
      btn.addEventListener('click', e => { e.stopPropagation(); open(menu.hidden); });
      menu.addEventListener('click', e => e.stopPropagation());
      document.addEventListener('click', () => { if (!menu.hidden) open(false); });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); }
      });
    }

    /** When the bar wraps, each row is spread edge to edge -- except a row
     *  with so few items that spreading leaves big gaps (two stats alone on
     *  the last line, say). Those are centred as a group instead, by giving
     *  the row's first and last item auto margins, which take the free
     *  space before the bar's space-between can. Nothing else changes which
     *  row an item lands on, so this never feeds back on itself. */
    layoutBar() {
      const bar = document.querySelector('.bar');
      if (!bar || !bar.children || !window.getComputedStyle) return;
      const items = [];
      Array.prototype.forEach.call(bar.children, el => {
        if (el.classList.contains('stat')) Array.prototype.push.apply(items, el.children);
        else if (!el.classList.contains('spacer')) items.push(el);
      });
      items.forEach(el => el.classList.remove('rowstart', 'rowend'));
      const cs = getComputedStyle(bar);
      if (cs.flexWrap !== 'wrap') return;
      const width = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

      const rows = [];
      items.forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;                       // hidden
        const mid = r.top + r.height / 2;
        let row = rows.find(x => Math.abs(x.mid - mid) < 8);
        if (!row) rows.push(row = { mid, els: [], used: 0 });
        row.els.push(el);
        row.used += r.width;
      });
      rows.forEach(row => {
        const n = row.els.length;
        const spread = n > 1 ? (width - row.used) / (n - 1) : Infinity;
        if (spread > SPARSE_GAP) {
          row.els[0].classList.add('rowstart');
          row.els[n - 1].classList.add('rowend');
        }
      });
    }

    /** Time acceleration: 1x/2x/4x/8x buttons when the bar has room for
     *  them, otherwise the compact <select>. Both stay in sync. */
    setupRate() {
      const box = document.getElementById('rateBox');
      const sel = this.el.rate;
      const btns = box.querySelectorAll('[data-rate]');
      const set = v => {
        this.sim.rate = parseFloat(v);
        sel.value = v;
        btns.forEach(b => b.classList.toggle('on', b.dataset.rate === v));
      };
      sel.addEventListener('change', () => set(sel.value));
      btns.forEach(b => b.addEventListener('click', () => set(b.dataset.rate)));

      // Buttons only if they fit without overflowing the bar (desktop, one
      // line) or pushing it onto an extra line (narrow screens, wrapping).
      const bar = box.closest('.bar');
      const fit = () => {
        box.classList.add('compact');
        const h = bar.offsetHeight;
        box.classList.remove('compact');
        const tight = bar.scrollWidth > bar.clientWidth || bar.offsetHeight > h;
        box.classList.toggle('compact', tight);
        this.layoutBar();
      };
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(fit);
        ro.observe(bar);
        ro.observe(this.el.stat);   // the stats grow as the run goes on
      } else {
        window.addEventListener('resize', fit);
      }
      this.fitRate = fit;
      fit();
    }

    bind() {
      const cmd = this.el.cmd;
      cmd.addEventListener('keydown', e => {
        if (e.key === 'Enter') { this.transmit(cmd.value); cmd.value = ''; this.hint(''); }
        else if (e.key === 'Escape') { cmd.value = ''; this.select(null); }
      });
      cmd.addEventListener('input', () => this.suggest(cmd.value));

      this.el.pause.addEventListener('click', () => this.togglePause());
      this.el.pausedOverlay.addEventListener('click', () => this.togglePause());
      this.setupRate();
      this.el.mode.addEventListener('change', () => {
        this.strict = this.el.mode.value === 'strict';
      });
      this.el.hint.addEventListener('click', () => this.assessorHint());
      document.getElementById('toggleVectors').addEventListener('change', e => {
        this.radar.showVectors = e.target.checked;
      });
      document.getElementById('toggleRings').addEventListener('change', e => {
        this.radar.showRings = e.target.checked;
      });
      const voicesChk = document.getElementById('toggleVoices');
      if (voicesChk) {
        voicesChk.checked = !this.radio.muted;
        voicesChk.addEventListener('change', e => this.radio.setMuted(!e.target.checked));
      }
      this.setupSettings();
      document.getElementById('helpBtn').addEventListener('click', () => this.showHelp());
      document.querySelectorAll('[data-close]').forEach(b =>
        b.addEventListener('click', () => this.closeHelp()));

      // Space bar pauses/resumes -- except in speak mode, where it is push
      // to talk instead (wired below, shared with the button). Capture
      // phase, not bubble: see setupPushToTalk in voice.js for why.
      document.addEventListener('keydown', e => {
        if (e.target === cmd || this.reporting()) return;
        if (e.key === ' ' || e.code === 'Space') {
          if (this.mode !== 'speak') { e.preventDefault(); this.togglePause(); }
        }
        if (e.key === '/' && this.mode === 'type') { e.preventDefault(); cmd.focus(); }
      }, true);

      this.setupStartModal();
      this.el.switchMode.addEventListener('click', () =>
        this.applyMode(this.mode === 'type' ? 'speak' : 'type'));

      try {
        this.setupVoice();
      } catch (err) {
        // Speech is a nicety; losing it must not cost us the whole position.
        this.speechSupported = false;
        this.el.modeSpeak.disabled = true;
        this.el.modeSpeak.title = 'Speech input unavailable: ' + (err && err.message);
      }
      this.setupReport();
    }

    // ------------------------------------------------------------- reports
    /** "Report mis-hearing": shown once something has been heard in speak
     *  mode. The run pauses while the dialog is up, and comes back as it was. */
    setupReport() {
      const btn = document.getElementById('reportBtn');
      if (!btn || !ATC.Feedback) return;
      this.reportBtn = btn;
      let wasPaused = true;
      this.feedback = new ATC.Feedback({
        attempts: () => this.heardLog.slice().reverse(),
        context: () => ({
          scenario: [this.sim.scen.id, this.sim.scen.variant].filter(Boolean).join(' '),
          aircraft: this.sim.aircraft.filter(a => a.state === 'active').map(a => a.callsign),
        }),
        onOpen: () => {
          if (this.pttCtl) this.pttCtl.stop();
          wasPaused = this.sim.paused;
          if (!this.sim.paused) this.togglePause();
        },
        onClose: () => { if (!wasPaused && this.sim.paused) this.togglePause(); },
        onSent: () => {
          this.errStreak = 0;
          btn.classList.remove('nudge');
          this.toast('\u2691 Report sent \u2014 thank you.');
        },
      });
      btn.addEventListener('click', () => this.feedback.open());
    }

    reporting() { return !!(this.feedback && this.feedback.isOpen); }

    /** Keep a spoken transmission, as heard and as understood, for a report. */
    logHeard(text, kind, alternatives) {
      const r = this.lastParse;
      const result = !r ? 'not parsed'
        : !r.ok ? 'not understood: ' + r.error
        : !r.action ? 'callsign only: ' + r.callsign
        : 'sent: ' + S.sent(r.ac, r.action) +
          (r.notes && r.notes.length ? ' \u2014 faults: ' + r.notes.join(' ') : '');
      this.heardLog.push({ heard: text, result, kind, alternatives: alternatives || [],
                           sim_t: Math.round(this.sim.t) });
      if (this.heardLog.length > 6) this.heardLog.shift();
      if (!this.reportBtn) return;
      this.reportBtn.hidden = this.mode !== 'speak';
      // Once could be a mumble; the same thing failing twice running is the
      // pattern worth sending in, so that is when it is pointed out.
      this.errStreak = kind === 'err' ? this.errStreak + 1 : 0;
      if (this.errStreak === 2) {
        this.reportBtn.classList.add('nudge');
        this.toast('Keeps mishearing you? \u2691 Report mis-hearing sends it in.');
      } else if (!this.errStreak) {
        this.reportBtn.classList.remove('nudge');
      }
    }

    /** Closing the help modal on load leads straight into "how will you answer?". */
    closeHelp() {
      // Closing the debrief ends the session: back to the exercise list.
      if (this.debrief) {
        const home = document.querySelector('.bar .home');
        location.href = home ? home.getAttribute('href') : '/';
        return;
      }
      this.el.modal.classList.remove('show');
      if (this.pendingStart) {
        this.pendingStart = false;
        this.el.startModal.classList.add('show');
      }
    }

    /** The "speak or type, then press start" modal shown once, up front. */
    setupStartModal() {
      let chosen = null;
      const choose = m => {
        if (m === 'speak' && !this.speechSupported) return;
        chosen = m;
        this.el.modeType.classList.toggle('on', m === 'type');
        this.el.modeSpeak.classList.toggle('on', m === 'speak');
        this.el.startBtn.disabled = false;
      };
      this.el.modeType.addEventListener('click', () => choose('type'));
      this.el.modeSpeak.addEventListener('click', () => choose('speak'));
      this.el.startBtn.addEventListener('click', () => {
        if (!chosen) return;
        this.el.startModal.classList.remove('show');
        this.applyMode(chosen);
        if (this.sim.paused) this.togglePause();
        // Must happen synchronously inside this genuine tap -- see
        // Radio.unlock() for why.
        this.radio.unlock();
        this.unlockPing();
      });
    }

    /** Show the input box for typing, or the push-to-talk button for speaking. */
    applyMode(mode) {
      if (mode === 'speak' && !this.speechSupported) return;
      this.mode = mode;
      this.el.cmdbody.hidden = false;
      const typing = mode === 'type';
      this.el.cmd.hidden = !typing;
      this.el.ptt.hidden = typing;
      this.el.switchMode.hidden = !this.speechSupported;
      this.el.switchMode.textContent = typing ? '\u{1F3A4} Speak instead' : '\u2328\uFE0F Type instead';
      if (this.reportBtn) this.reportBtn.hidden = typing || !this.heardLog.length;
      // Quick keys is a typed shorthand ("DAL66 C280") -- speech can never
      // produce that exact string, so a spoken transmission always grades
      // as phraseology, and the selector is hidden rather than left
      // sitting on an option that silently can't do anything.
      document.getElementById('modeRow').hidden = !typing;
      this.strict = typing ? this.el.mode.value === 'strict' : true;
      if (this.fitRate) this.fitRate();   // the bar just gained or lost room
      if (typing) {
        if (this.pttCtl) this.pttCtl.stop();
        if (!this.sim.paused) this.el.cmd.focus();
      } else if (this.voice) {
        this.voice.prime();
      }
    }

    // --------------------------------------------------------------- voice
    setupVoice() {
      const lt = new ATC.LiveTranscript(this.el.livert);
      this.lt = lt;
      this.sound = new ATC.SoundGraph(this.el.soundgraph);
      let clearTimer = null;
      const status = this.el.micStatus || document.getElementById('micStatus');

      const setStatus = (text, cls) => {
        if (!status) return;
        status.hidden = !text;
        status.textContent = text || '';
        status.className = 'micstatus' + (cls ? ' ' + cls : '');
      };

      this.voice = ATC.makeVoice({
        onInterim: (committed, interim) => {
          setStatus('');
          lt.update(committed, interim);
          if (interim) this.sound.pulse();
        },
        onFinal: (text, alternatives) => {
          const kind = this.transmit(text);
          this.logHeard(text, kind, alternatives);
          lt.update(text, '');
          lt.flash(kind);
          clearTimeout(clearTimer);
          clearTimer = setTimeout(() => { clearTimer = null; lt.clear(); }, 1600);
        },
        // The sound graph is driven from here, not from the button/space
        // handler -- this is the recogniser's own report of its state, so
        // the graph can never show "listening" when it disagrees.
        //
        // Stopping cancels whatever was still being said: voice.js drops
        // any results that arrive after the stop, so the half-heard words
        // are cleared straight away rather than left looking pending. A
        // transmission that was already sent keeps its graded flash until
        // onFinal's own timer fades it.
        onState: (on, reason) => {
          if (on) {
            lt.clear();
            setStatus('Warming up \u2014 wait, don\u2019t speak yet\u2026', 'warm');
            this.pttCtl.setPhase('warming');
            this.sound.start();
          } else {
            // Timed out on silence: say so, or the button flipping back by
            // itself looks like a glitch -- unless a mic error is already
            // showing, which is the better explanation of the silence.
            if (reason !== 'idle') setStatus('');
            else if (!(status && status.classList.contains('err'))) {
              setStatus('Stopped listening \u2014 nothing heard for 8 seconds. Tap to talk again.');
            }
            if (!clearTimer) lt.clear();
            this.pttCtl.setPhase('idle');
            this.sound.stop();
          }
        },
        // The first start after a while often takes a moment (or two) to
        // actually wake the mic up -- this keeps saying so, and keeps the
        // button itself in its "don't speak yet" phase, rather than going
        // quiet while voice.js retries underneath.
        onWarmupRetry: () => {
          setStatus('Still warming up \u2014 wait for it\u2026', 'warm');
          this.pttCtl.setPhase('warming');
        },
        onHeard: () => {
          setStatus('Hearing you\u2026', 'ok');
          this.pttCtl.setPhase('heard');
          this.sound.pulse(0.25);   // the mic is open, not that you're speaking
        },
        onError: message => setStatus(message, 'err'),
        isBusy: () => this.radio.onAir,
        onUnsupported: reason => {
          this.speechSupported = false;
          this.el.modeSpeak.disabled = true;
          this.el.modeSpeak.title = reason || 'Speech recognition needs Chrome, Edge or Safari';
          this.el.switchMode.hidden = true;
          this.el.modeNote.hidden = false;
          this.el.modeNote.textContent = reason || 'Speech recognition is not available ' +
            'in this browser — use Chrome, Edge or Safari, or type the transmission instead.';
          this.el.modeNote.className = 'micstatus err';
        },
      });

      this.pttCtl = ATC.setupPushToTalk(this.el.ptt, () => this.voice,
        () => this.mode === 'speak' && !this.reporting());
    }

    // ------------------------------------------------------------ sections
    /** Each panel collapses, and remembers whether it was collapsed. */
    setupSections() {
      const key = sec => 'atc.sec.' + sec.dataset.sec;

      const setCollapsed = (sec, collapsed) => {
        sec.classList.toggle('collapsed', collapsed);
        const head = sec.querySelector('.sechead');
        if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        try { localStorage.setItem(key(sec), collapsed ? '1' : '0'); } catch (_) {}
      };

      document.querySelectorAll('.sec').forEach(sec => {
        let collapsed = false;
        try { collapsed = localStorage.getItem(key(sec)) === '1'; } catch (_) {}
        sec.classList.toggle('collapsed', collapsed);
        const head = sec.querySelector('.sechead');
        if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });

      // Delegated from the container: one listener, and it keeps working even
      // if a panel's contents are replaced -- or the panel moves (below).
      const grid = document.querySelector('.simgrid');
      if (!grid) return;
      grid.addEventListener('click', e => {
        const head = e.target.closest ? e.target.closest('.sechead') : null;
        if (!head || head.disabled) return;
        const sec = head.closest('.sec');
        if (!sec) return;
        e.preventDefault();
        setCollapsed(sec, !sec.classList.contains('collapsed'));
        this.radar.resize();     // the radar just gained or lost space
      });
      this.setupTrafficOverlay();
    }

    /** On a narrow (stacked) layout the traffic list sits over the radar as
     *  a see-through dropdown, rather than taking half the screen below it.
     *  Same breakpoint as the stacked layout in style.css. */
    setupTrafficOverlay() {
      const sec = document.querySelector('.stripsbox');
      const side = document.querySelector('.side');
      const wrap = document.querySelector('.radarwrap');
      if (!sec || !side || !wrap) return;
      const mq = window.matchMedia ? window.matchMedia('(max-width: 900px)')
        : { matches: false };     // no media queries: treat as a wide screen
      const head = sec.querySelector('.sechead');
      const place = () => {
        if (mq.matches) wrap.appendChild(sec);
        else side.insertBefore(sec, side.firstChild);
        wrap.classList.toggle('has-traffic', mq.matches);
        // In the sidebar it is the only section, so it is not collapsible
        // there -- always open, whatever was remembered from the overlay.
        if (head) {
          head.disabled = !mq.matches;
          if (mq.matches) head.setAttribute('aria-expanded',
            sec.classList.contains('collapsed') ? 'false' : 'true');
          else head.removeAttribute('aria-expanded');
        }
        this.radar.resize();
      };
      if (mq.addEventListener) mq.addEventListener('change', place);
      else if (mq.addListener) mq.addListener(place);
      place();
    }

    togglePause() {
      if (this.sim.finished) return;
      this.sim.paused = !this.sim.paused;
      this.el.pause.textContent = this.sim.paused ? '▶ Start' : '‖ Pause';
      this.el.pause.classList.toggle('running', !this.sim.paused);
      // Only ever shown from here, so never before the run starts (paused,
      // but the speak-or-type prompt is what is on screen then).
      this.el.pausedOverlay.hidden = !this.sim.paused;
      if (!this.sim.paused && this.mode === 'type') this.el.cmd.focus();
    }

    select(ac) {
      this.sim.aircraft.forEach(a => { a.selected = false; });
      this.selected = ac;
      if (ac) { ac.selected = true; if (this.mode === 'type') this.el.cmd.focus(); }
    }

    /** Everything said on frequency (and by the assessor) appears as a
     *  game-style caption over the radar, held long enough to read and then
     *  faded out, rather than piling up in a log. */
    say(who, text, cls) {
      this.msgs.unshift({ who, text, cls: cls || '' });
      if (this.msgs.length > 40) this.msgs.pop();

      const box = this.el.captions;
      if (!box) return;
      const el = document.createElement('div');
      el.className = 'caption ' + (cls || '');
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = who + ':';
      const t = document.createElement('span');
      t.textContent = ' ' + text;
      el.appendChild(w);
      el.appendChild(t);
      const secs = Math.min(20, Math.max(8, 3 + String(text).split(/\s+/).length * 0.6));
      el.style.animationDuration = secs + 's';
      el.addEventListener('animationend', () => el.remove());
      box.appendChild(el);
      while (box.children.length > 6) box.removeChild(box.firstChild);
    }

    /** Brief flash-and-fade banner at the bottom of the screen, kept out of the R/T log. */
    toast(text) {
      const el = this.el.toast;
      el.textContent = text;
      el.classList.remove('show');
      void el.offsetWidth; // restart the animation if a toast is already showing
      el.classList.add('show');
    }

    /** Entry/exit notification: slides in over the radar, fades after a few
     *  seconds and removes itself. Several can stack. */
    notify(e) {
      const el = document.createElement('div');
      el.className = 'notice ' + e.kind;
      el.textContent = e.text + (e.pts ? '  ' + (e.pts > 0 ? '+' : '') + e.pts : '');
      this.el.notices.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
      this.ping(e.kind === 'entry' ? 'entry'
        : e.kind === 'bad' || e.kind === 'loss' ? 'bad' : 'exit');
    }

    /** Create the AudioContext inside the Start tap, or mobile browsers keep
     *  it suspended for good. */
    unlockPing() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!this.actx && AC) this.actx = new AC();
        if (this.actx && this.actx.state === 'suspended') this.actx.resume();
      } catch (_) {}
    }

    /** Short two-note chime: rising for an entry, falling for an exit,
     *  lower for an exit at the wrong level. */
    ping(kind) {
      const ctx = this.actx;
      if (!ctx || ctx.state !== 'running') return;
      const notes = { entry: [880, 1320], exit: [1320, 880], bad: [520, 390] }[kind];
      const t0 = ctx.currentTime;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        const t = t0 + i * 0.09;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.25);
      });
    }

    hint(t) { this.el.cmdhint.innerHTML = t; }

    suggest(v) {
      const w = v.trim().toLowerCase();
      if (!w) return this.hint('');
      const last = w.split(/\s+/).pop();
      const m = this.sim.aircraft.filter(a => a.state === 'active' &&
        (a.callsign.toLowerCase().startsWith(last) ||
         a.airline.spoken.toLowerCase().startsWith(last)));
      this.hint(m.length && m.length < 5
        ? m.map(a => '<b>' + a.callsign + '</b> ' + a.spoken()).join(' &nbsp; ') : '');
    }

    // ---------------------------------------------------------- transmit
    /** Returns 'ok', 'fault' or 'err' -- the live transcript colours itself by it. */
    transmit(text) {
      this.lastParse = null;
      text = text.trim();
      if (!text) return 'err';
      if (/^(\?|help)$/i.test(text)) { this.showHelp(); return 'ok'; }

      const r = this.strict ? S.parse(text, this.sim) : this.parseQuick(text);
      this.lastParse = r;
      // Caption what was actually sent -- the parsed instruction -- not the
      // raw recognition ("unit one three zero climbed ..."). If nothing
      // could be parsed, nothing was sent, so show the words as heard.
      this.say('You', r.ok ? S.tidy(S.sent(r.ac, r.action))
        : this.strict ? S.tidy(text) : text, 'you');

      if (!r.ok) {
        this.say('✗', r.error, 'err');
        if (r.ac) this.radio.say(r.ac, S.sayAgain(r.ac));
        if (this.strict) this.sim.penaliseFaults(1);
        return 'err';
      }
      const ac = r.ac;
      this.select(ac);
      if (r.correction) this.toast('↻ Correction accepted.');
      if (!r.action) return 'ok';

      if (r.action.kind === 'turn') ac.cmdHeading(r.action.hdg, r.action.dir);
      else ac.cmdLevel(r.action.fl);
      this.sim.instructions++;
      // The pilot's readback is captioned by the radio as it is spoken.
      this.radio.say(ac, S.model(ac, r.action));

      if (r.notes && r.notes.length) {
        this.sim.penaliseFaults(r.notes.length);
        this.toast('⚠ ' + r.notes.join(' '));
        // Not a checkmark: this is the corrected phrasing to learn for next
        // time, shown *because* of the fault above it, not in spite of it --
        // a "✓" here reads as "you got it right", which is the opposite of
        // what just happened.
        this.say('Model', '"' + S.tidy(S.model(ac, r.action)) + '"', 'model');
        return 'fault';
      }
      return 'ok';
    }

    /** Shorthand for drilling speed rather than phraseology. */
    parseQuick(text) {
      const tok = text.toUpperCase().split(/\s+/);
      let ac = null;
      const first = this.sim.byCallsign(tok[0]);
      if (first) { ac = first; tok.shift(); }
      else if (/^[A-Z]{3}\d/.test(tok[0])) {
        const m = this.sim.aircraft.filter(a =>
          a.state === 'active' && a.callsign.startsWith(tok[0]));
        if (m.length === 1) { ac = m[0]; tok.shift(); }
        else return { ok: false, error: 'no aircraft "' + tok[0] + '"' };
      } else ac = this.selected;
      if (!ac) return { ok: false, error: 'select an aircraft first' };
      if (!tok.length) return { ok: true, ac, action: null, notes: [] };

      const t = tok[0];
      let m;
      if ((m = t.match(/^([HLR])(\d{1,3})$/))) {
        const hdg = parseInt(m[2], 10) % 360;
        const dir = m[1] === 'H' ? ac.shorterTurn(hdg) : m[1];
        return { ok: true, ac, notes: [], action: { kind: 'turn', hdg, dir } };
      }
      if ((m = t.match(/^(?:C|D|A|FL)(\d{2,3})$/))) {
        return { ok: true, ac, notes: [], action: { kind: 'level', fl: parseInt(m[1], 10) } };
      }
      return { ok: false, error: 'not understood: "' + t + '"' };
    }

    // ------------------------------------------------------- assessor hint
    assessorHint() {
      const s = this.sim;
      const live = s.aircraft.filter(a => a.state === 'active');
      const worst = s.conflicts.slice().sort((a, b) =>
        (a.kind === 'loss' ? -1 : 0) - (b.kind === 'loss' ? -1 : 0) || a.d - b.d)[0];

      if (worst) {
        const { a, b } = worst;
        const dv = Math.abs(a.alt - b.alt);
        const lower = a.alt <= b.alt ? a : b, upper = lower === a ? b : a;
        const txt = worst.kind === 'loss'
          ? 'Separation is lost between ' + a.callsign + ' and ' + b.callsign + '. '
          : 'In about ' + Math.round(worst.tca) + ' seconds ' + a.callsign + ' and ' +
            b.callsign + ' will be ' + worst.d.toFixed(1) + ' NM apart with only ' +
            Math.round(dv) + ' ft between them. ';
        this.say('Assessor', txt +
          'Either give one of them 1000 ft — descend ' + lower.callsign +
          ' to FL' + String(lower.fl - 10).padStart(3, '0') + ' or climb ' +
          upper.callsign + ' to FL' + String(upper.fl + 10).padStart(3, '0') +
          ' — or turn one about 30° to open the tracks out to 3 NM.', 'note');
        return;
      }

      const out = live.find(a => a.outside);
      if (out) {
        const cor = s.corridors[out.corridor] || s.corridors[0];
        const pr = G.corridorProject(out, cor);
        this.say('Assessor', out.callsign + ' is outside the corridor. Turn it ' +
          (pr.side > 0 ? 'left' : 'right') + ' towards heading ' +
          G.fmtHdg(pr.brg + (pr.side > 0 ? -35 : 35)) + ' to get back inside.', 'note');
        return;
      }

      const wrong = live.filter(a => a.clearedFl !== a.exitFL);
      if (wrong.length) {
        const a = wrong[0];
        this.say('Assessor', a.callsign + ' still has to get to its exit level, FL' +
          String(a.exitFL).padStart(3, '0') + '. Plan when to ' +
          (a.exitFL > a.fl ? 'climb' : 'descend') +
          ' it, and check nothing is in the way at that level.', 'note');
        return;
      }
      this.say('Assessor', 'Nothing pressing. Keep scanning — look ahead a couple ' +
        'of minutes for tracks that will cross at the same level.', 'note');
    }

    // ------------------------------------------------------------- render
    render() {
      const s = this.sim;
      const mm = n => String(Math.floor(n)).padStart(2, '0');
      const rm = Math.max(0, s.duration - s.t);
      this.el.clock.textContent = mm(s.t / 60) + ':' + mm(s.t % 60) +
        '  ·  ' + mm(rm / 60) + ':' + mm(rm % 60) + ' left';
      const score = String(Math.round(s.score));
      this.el.score.textContent = score;
      this.el.score.className = s.score < 0 ? 'neg' : '';

      const live = s.aircraft.filter(a => a.state === 'active').length;
      const stat =
        '<span>traffic <b>' + live + '</b></span>' +
        '<span>exits <b>' + s.correct + '/' + s.handled + '</b></span>' +
        '<span class="' + (s.losses ? 'neg' : '') + '">losses <b>' + s.losses + '</b></span>' +
        '<span class="' + (s.faults ? 'warn' : '') + '">R/T <b>' + s.faults + '</b></span>';
      // Only when something changed: this runs every frame, and the bar's
      // row layout (layoutBar) marks these spans, so rewriting them each
      // time would wipe that out.
      if (stat !== this._stat || score !== this._score) {
        if (stat !== this._stat) this.el.stat.innerHTML = stat;
        this._stat = stat; this._score = score;
        this.layoutBar();
      }

      this.renderStrips();
      this.drainNotices();
    }

    renderStrips() {
      const pad = n => String(n).padStart(3, '0');
      const rows = this.sim.aircraft
        .filter(a => a.state === 'active')
        .sort((a, b) => a.entryTime - b.entryTime)
        .map(a => {
          const cls = ['strip'];
          if (a.selected) cls.push('sel');
          if (a.conflict) cls.push('loss');
          else if (a.alert) cls.push('alert');
          else if (a.outside) cls.push('out');
          const arrow = a.vs > 50 ? '↑' : a.vs < -50 ? '↓' : '·';
          const done = a.fl === a.exitFL && a.clearedFl === a.exitFL;
          return '<div class="' + cls.join(' ') + '" data-cs="' + a.callsign + '">' +
            '<div class="r1"><b>' + a.callsign + '</b>' +
              '<i>' + a.spoken() + '</i></div>' +
            '<div class="r2">' +
              '<span title="current / cleared">' + pad(a.fl) + arrow +
                pad(a.clearedFl) + '</span>' +
              '<span title="heading">H' + G.fmtHdg(a.hdg) + '</span>' +
              '<span title="speed">' + Math.round(a.ias) + '</span>' +
              '<span class="exit ' + (done ? 'ok' : '') + '" title="exit flight level">' +
                'exit ' + pad(a.exitFL) + '</span>' +
            '</div></div>';
        }).join('');
      if (rows !== this._strips) {
        this.el.strips.innerHTML = rows || '<div class="empty">No traffic</div>';
        this._strips = rows;
        this.el.strips.querySelectorAll('.strip').forEach(el =>
          el.addEventListener('click', () =>
            this.select(this.sim.byCallsign(el.dataset.cs))));
      }
    }

    drainNotices() {
      while (this.sim.notices.length) this.notify(this.sim.notices.shift());
    }

    // --------------------------------------------------------------- help
    showHelp() {
      this.debrief = false;      // help replaces the debrief: closing it just closes
      this.el.helpTitle.textContent = 'Standard phraseology';
      this.el.modal.classList.add('help');   // wide two-column sheet on big screens
      this.el.helpBody.innerHTML = `
        <section><p class="lead">You have exactly three instructions. Say the callsign first,
        then the instruction. Every number is spoken digit by digit.</p>
        <div class="hrow"><code>Turn</code><span>"American four five one,
          <b>turn right heading zero seven zero</b>"</span></div>
        <div class="hrow"><code>Climb</code><span>"Delta six six,
          <b>climb to flight level two eight zero</b>"</span></div>
        <div class="hrow"><code>Descend</code><span>"United eight seven,
          <b>descend to flight level two seven zero</b>"</span></div>
        <div class="hrow"><code>Correction</code><span>"United seven eight&hellip;
          <b>correction</b>, United eight seven, descend to flight level two six
          zero"</span></div>
        </section>
        <section><h4>Callsigns</h4>
        <div class="hrow"><code>AAL</code><span>American &mdash; AAL451 is
          "American four five one"</span></div>
        <div class="hrow"><code>DAL</code><span>Delta &mdash; DAL77 is
          "Delta seven seven"</span></div>
        <div class="hrow"><code>UAL</code><span>United &mdash; UAL130 is
          "United one three zero"</span></div>
        </section>
        <section><h4>The rules you are marked on</h4>
        <div class="hrow"><code>Separation</code><span>1,000 ft vertically
          <b>or</b> 3 NM laterally &mdash; never neither</span></div>
        <div class="hrow"><code>Airspace</code><span>keep every aircraft inside the
          corridor walls</span></div>
        <div class="hrow"><code>Exit level</code><span>deliver each aircraft at the
          exit flight level on its label (third row, left)</span></div>
        </section>
        <section><h4>Keys</h4>
        <div class="hrow"><code>/</code><span>jump to the transmission box</span></div>
        <div class="hrow"><code>space</code><span>pause / resume &mdash; or start/stop
          talking, if you chose to speak</span></div>
        <div class="hrow"><code>click</code><span>select an aircraft; scroll to zoom,
          drag to pan</span></div></section>`;
      this.el.modal.classList.add('show');
    }

    // --------------------------------------------------------- end of run
    finishRun() {
      const s = this.sim.summary();
      const d = s.detail;
      const good = this.sim.events.filter(e => e.kind === 'good' && e.pts > 0);
      const bad = this.sim.events.filter(e => e.kind === 'bad' || e.kind === 'loss');
      this.debrief = true;
      this.el.pausedOverlay.hidden = true;
      this.el.modal.classList.remove('help');
      this.el.helpTitle.textContent = 'Debrief';
      this.el.helpBody.innerHTML =
        '<div class="final"><div class="big">' + s.score + '</div>' +
        '<div class="grid4">' +
          '<span><b>' + s.correct + '/' + s.handled + '</b>at exit level</span>' +
          '<span class="' + (s.losses ? 'neg' : '') + '"><b>' + s.losses +
            '</b>separation losses</span>' +
          '<span class="' + (d.excursions ? 'neg' : '') + '"><b>' + d.excursions +
            '</b>airspace excursions</span>' +
          '<span class="' + (d.phraseology_faults ? 'warn' : '') + '"><b>' +
            d.phraseology_faults + '</b>R/T faults</span>' +
        '</div>' +
        (d.closest_call_nm != null
          ? '<p class="closest">Closest you came at the same level: <b>' +
            d.closest_call_nm + ' NM</b>.</p>' : '') +
        '</div>' +
        '<h4>Went well</h4>' +
        (good.length ? good.map(e => '<div class="ev good">' + e.text + '</div>').join('')
                     : '<div class="ev">Nothing scored yet.</div>') +
        '<h4>Work on</h4>' +
        (bad.length ? bad.map(e => '<div class="ev bad">' + e.text + '</div>').join('')
                    : '<div class="ev good">Clean run — everything stayed inside ' +
                      'the corridor, separated, and left at its exit level.</div>');
      this.el.modal.classList.add('show');
      if (this.voice) this.voice.stop();
      this.radio.clear();
      fetch('/api/run', {
        // keepalive: Close may navigate away while this is still in flight.
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify(s),
      }).catch(() => {});
    }
  }

  ATC.UI = UI;
})(window.ATC = window.ATC || {});
