/* Pilot voice readback.
 *
 * Tries the server's OpenAI voice proxy first (the Realtime model, told to
 * recite; natural-sounding, needs OPENAI_API_KEY set server-side), and falls back to the browser's own
 * speech synthesiser if that isn't configured, is unreachable, the
 * request fails, or the browser won't play it -- so a bad key or a dropped
 * connection degrades to a robotic voice rather than silence. Every
 * fallback is reported (ATC.report), since otherwise it is invisible.
 *
 * Either way, a real frequency only ever has one aircraft transmitting at
 * a time, so readbacks are queued and played one after another, never
 * overlapping. */
(function (ATC) {
  'use strict';

  // Must be voices the server's Realtime model actually accepts -- see
  // TTS_VOICES in app.py. The two lists don't need to line up index for
  // index, only each name individually needs to be valid.
  const TTS_VOICES = ['cedar', 'marin', 'ash', 'coral', 'verse', 'sage', 'ballad'];
  // How long a readback may sit unplayed (fetching, decoding) before it
  // stops holding the talk button disabled.
  const STUCK_MS = 10000;

  // A single silent sample, played in the Start tap so iOS Safari will also
  // allow the <audio> fallback path later (see unlock()).
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEA' +
    'QB8AAEAfAAABAAgAZGF0YQAAAAA=';

  const synth = window.speechSynthesis;

  const describe = e => e ? ((e.name ? e.name + ': ' : '') + (e.message || String(e))) : 'unknown';
  const report = (why, detail) => {
    if (ATC.report) ATC.report('pilot voice fallback', why, detail, 'warning');
  };
  let voices = [];
  function loadVoices() { voices = synth.getVoices(); }
  if (synth) {
    loadVoices();
    synth.onvoiceschanged = loadVoices;
  }

  class Radio {
    /** opts.onIssue(text) -- reported once, so a silent failure (no voices
     *  installed, both the server and the local engine unavailable) shows
     *  up on screen instead of only in a devtools console nobody on a
     *  phone can open. */
    constructor(opts) {
      this.queue = [];
      this.speaking = false;       // a readback is in progress, fetch included
      this.playing = false;        // ...and its audio is actually coming out now
      this.airEndedAt = 0;
      this.current = null;         // {stop()} for the server readback playing now
      this.gen = 0;                // bumped by clear(), so a late fetch knows it's stale
      this.actx = null;            // AudioContext unlocked by the Start tap
      this.assigned = new Map();   // aircraft id -> local {voice, pitch, rate}
      this.muted = false;
      this.serverDown = false;     // set once /api/tts says it's not configured
      this.unlocked = false;
      this.onIssue = (opts && opts.onIssue) || function () {};
      // Called as each readback actually goes out (or at once when muted),
      // so its caption appears with the voice rather than ahead of it.
      this.onSpeak = (opts && opts.onSpeak) || function () {};
      // Called whenever `busy` flips, so the talk button can be disabled
      // while a pilot is about to read back or is reading back.
      this.onBusyChange = (opts && opts.onBusyChange) || function () {};
      this.wasBusy = false;
      this.busyTimer = null;
      this.speakingSince = 0;
      this.issueReported = false;
      try { this.muted = localStorage.getItem('atc.rt.muted') === '1'; } catch (_) {}
    }

    /** A pilot's voice is coming out of the speakers right now, or only
     *  just stopped -- the recogniser delivers words a little after it
     *  hears them, so the tail of a readback can still arrive late. Not
     *  `speaking`, which also covers the wait for /api/tts: you are free to
     *  talk over that. */
    get onAir() {
      return this.playing || Date.now() - this.airEndedAt < 800;
    }

    /** A readback is queued, being fetched, or on air (tail included):
     *  the controller should not start a transmission. A fetch that has
     *  not started playing within STUCK_MS stops counting, so a request
     *  that hangs can never lock the talk button for good. */
    get busy() {
      if (this.onAir || this.queue.length) return true;
      return this.speaking && Date.now() - this.speakingSince < STUCK_MS;
    }

    /** Re-check `busy` and report a change. Also re-checks itself when the
     *  on-air tail or the stuck-fetch allowance runs out, since nothing
     *  else happens at those moments to prompt it. */
    notifyBusy() {
      const busy = this.busy;
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
      if (busy && !this.playing) {
        const now = Date.now();
        const tailLeft = this.airEndedAt + 800 - now;
        const stuckLeft = this.speaking ? this.speakingSince + STUCK_MS - now : 0;
        const wait = Math.max(tailLeft, stuckLeft);
        if (wait > 0) this.busyTimer = setTimeout(() => this.notifyBusy(), wait + 20);
      }
      if (busy !== this.wasBusy) {
        this.wasBusy = busy;
        this.onBusyChange(busy);
      }
    }

    airOn() { this.playing = true; this.notifyBusy(); }
    airOff() {
      if (this.playing) this.airEndedAt = Date.now();
      this.playing = false;
      this.notifyBusy();
    }

    reportIssue(text) {
      if (this.issueReported) return;
      this.issueReported = true;
      this.onIssue(text);
    }

    setMuted(m) {
      this.muted = m;
      try { localStorage.setItem('atc.rt.muted', m ? '1' : '0'); } catch (_) {}
      if (m) this.clear();
    }

    /** iOS/iPadOS Safari only ever allows audio (speech synthesis or an
     *  <audio> element) to start if the very first play happens
     *  synchronously inside a genuine user gesture -- every later one,
     *  even from a timer or a fetch response, then works for the rest of
     *  the page's life. Readbacks always go through a queue (see pump())
     *  that breaks that direct link, so call this once from an actual
     *  tap -- the Start button -- before any instruction can be sent.
     *  Harmless, and a no-op, on browsers that never needed it. */
    unlock() {
      if (this.unlocked) return;
      this.unlocked = true;
      // Server readbacks play through Web Audio: a context resumed inside
      // this tap stays allowed to play for the rest of the page, in every
      // browser. A fresh <audio> element per readback doesn't -- desktop
      // Safari wants a gesture for each new element, and a readback lands
      // about two seconds after the key press, so it was refused.
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          this.actx = new AC();
          const src = this.actx.createBufferSource();
          src.buffer = this.actx.createBuffer(1, 1, 22050);
          src.connect(this.actx.destination);
          src.start(0);
          if (this.actx.state !== 'running') this.actx.resume().catch(() => {});
        }
      } catch (_) {}
      try {
        if (synth) {
          const u = new SpeechSynthesisUtterance(' ');
          u.volume = 0.01;
          u.rate = 10;
          synth.speak(u);
        }
      } catch (_) {}
      try {
        const a = new Audio(SILENT_WAV);
        a.volume = 0.01;
        a.play().catch(() => {});
      } catch (_) {}
    }

    /** Every installed local voice, best-sounding first. The default a
     *  desktop browser picks (espeak on Linux, an old SAPI voice on
     *  Windows) is the worst one available -- Chrome's network
     *  "Google ..." voices and Safari's on-device "Enhanced"/"Premium"
     *  ones are both much less robotic, so prefer any voice whose name
     *  says so over trusting getVoices()'s own ordering. Only used for
     *  the local fallback -- the server path always sounds better. */
    rankedLocalVoices() {
      const english = voices.filter(v => /^en/i.test(v.lang));
      const pool = english.length ? english : voices;
      const good = v => /google|natural|enhanced|premium|neural|online/i.test(v.name);
      return pool.slice().sort((a, b) => (good(b) ? 1 : 0) - (good(a) ? 1 : 0));
    }

    /** A stable local voice per aircraft, picked once and kept for the
     *  run -- the same pilot should sound the same every time they
     *  answer, whichever path ends up playing them. */
    localVoiceFor(ac) {
      if (this.assigned.has(ac.id)) return this.assigned.get(ac.id);
      const pool = this.rankedLocalVoices();
      // Distinguishing pilots by ear matters less than each of them
      // sounding like a real voice rather than a synthesiser -- a wide
      // pitch/rate spread is exactly what turns an already slightly
      // robotic voice properly ugly, so this stays subtle.
      const pick = {
        voice: pool.length ? pool[ac.id % pool.length] : null,
        pitch: 0.97 + ((ac.id * 37) % 6) / 100,
        rate: 0.98 + ((ac.id * 53) % 6) / 100,
      };
      this.assigned.set(ac.id, pick);
      return pick;
    }

    /** Queue a readback. */
    say(ac, text) {
      if (!text) return;
      if (this.muted) { this.onSpeak(ac, text); return; }
      this.queue.push({ ac, text });
      this.pump();
    }

    pump() {
      if (this.speaking || !this.queue.length) return;
      this.speaking = true;
      this.speakingSince = Date.now();
      const { ac, text } = this.queue.shift();
      this.notifyBusy();
      this.onSpeak(ac, text);
      if (this.serverDown) this.playLocal(ac, text);
      else this.playServer(ac, text);
    }

    /** The end of a playback attempt, whichever path took it -- always
     *  hands off to whatever is queued next. */
    finishedPlaying() {
      this.speaking = false;
      this.pump();
      this.notifyBusy();
    }

    playServer(ac, text) {
      const voice = TTS_VOICES[ac.id % TTS_VOICES.length];
      const gen = this.gen;
      const stale = () => gen !== this.gen;   // clear() ran while we waited
      const fallback = (why, detail) => {
        if (stale()) return;
        report(why, detail);
        this.playLocal(ac, text);
      };
      fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      }).then(res => {
        if (res.status === 503) {
          // Not configured server-side -- stop trying for the rest of
          // this run rather than paying a failed round trip every time.
          this.serverDown = true;
          return fallback('server voice not configured', { status: 503 });
        }
        if (!res.ok) return fallback('server voice request failed', { status: res.status });
        return res.arrayBuffer().then(buf => {
          if (stale()) return;
          return this.playViaContext(buf).catch(ctxErr => {
            if (stale()) return;
            return this.playViaElement(buf).catch(elErr =>
              fallback('server voice blocked from playing', {
                context: describe(ctxErr), element: describe(elErr),
                contextState: this.actx ? this.actx.state : 'none',
              }));
          });
        });
      }).catch(err => fallback('server voice request failed', { error: describe(err) }));
    }

    /** Resolves once the readback has started; rejects if it can't. */
    playViaContext(buf) {
      const ctx = this.actx;
      if (!ctx) return Promise.reject(new Error('no AudioContext'));
      // resume() outside a gesture can sit pending forever rather than
      // reject, so don't wait on it for long.
      const ready = ctx.state === 'running' ? Promise.resolve()
        : Promise.race([ctx.resume(), new Promise(ok => setTimeout(ok, 300))]);
      return ready.then(() => {
        if (ctx.state !== 'running') throw new Error('AudioContext is ' + ctx.state);
        // The callback form, for older Safari; slice() because decoding
        // detaches the buffer and the <audio> path may still need it.
        return new Promise((ok, bad) => ctx.decodeAudioData(buf.slice(0), ok,
          e => bad(e || new Error('could not decode audio'))));
      }).then(decoded => {
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(ctx.destination);
        const handle = { stop: () => { try { src.stop(); } catch (_) {} } };
        this.current = handle;
        src.onended = () => {
          if (this.current !== handle) return;   // clear() already moved on
          this.current = null;
          this.airOff();
          this.finishedPlaying();
        };
        src.start();
        this.airOn();
      });
    }

    /** The old path, kept as a second try: an <audio> element. */
    playViaElement(buf) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      const audio = new Audio(url);
      const handle = { stop: () => { try { audio.pause(); } catch (_) {} URL.revokeObjectURL(url); } };
      this.current = handle;
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.current !== handle) return;
        this.current = null;
        this.airOff();
        this.finishedPlaying();
      };
      audio.onplaying = () => this.airOn();
      audio.onended = done;
      audio.onerror = done;
      return audio.play().catch(err => {
        URL.revokeObjectURL(url);
        if (this.current === handle) this.current = null;
        throw err;
      });
    }

    /** Runs after a short, varying reaction delay so it never answers
     *  before the controller's own line has finished appearing in the
     *  log -- the server path already has real network latency doing
     *  that job, so this is only needed here. */
    playLocal(ac, text) {
      if (!synth) {
        report('no local voice either', {});
        this.reportIssue('No speech voice is available -- pilot readbacks are ' +
          'text-only. Use Chrome, Edge or Safari, or set OPENAI_API_KEY on the ' +
          'server for cloud voices.');
        this.finishedPlaying();
        return;
      }
      setTimeout(() => {
        if (this.muted) { this.finishedPlaying(); return; }
        const { voice, pitch, rate } = this.localVoiceFor(ac);
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.pitch = pitch;
        u.rate = rate;
        u.onstart = () => this.airOn();
        u.onend = () => { this.airOff(); this.finishedPlaying(); };
        u.onerror = ev => {
          this.airOff();
          report('local voice failed', { error: (ev && ev.error) || 'unknown' });
          this.reportIssue('Pilot voice failed to play (' +
            ((ev && ev.error) || 'unknown error') + ').');
          this.finishedPlaying();
        };
        synth.speak(u);
      }, 300 + Math.random() * 500);
    }

    /** Drop anything queued or playing -- the run has ended or the mic is
     *  about to be muted. */
    clear() {
      this.queue = [];
      this.speaking = false;
      this.gen++;
      this.airOff();
      // Server readbacks play through Web Audio or an <audio> element,
      // which synth.cancel() never touches -- they used to carry on to the end.
      if (this.current) {
        const handle = this.current;
        this.current = null;
        handle.stop();
      }
      if (synth) synth.cancel();
      this.notifyBusy();
    }
  }

  ATC.Radio = Radio;
})(window.ATC = window.ATC || {});
