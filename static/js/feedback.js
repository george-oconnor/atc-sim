/* Transcription reports: when the speech recogniser keeps mishearing you,
 * send in what it heard (with every alternative it offered), what you
 * actually said, and -- optionally -- a fresh recording of you saying it.
 *
 * The recording is a re-take made here, in the dialog, after recognition
 * has stopped. The recogniser never hands over its own audio, and running
 * a second microphone stream alongside it is exactly the thing that fails
 * silently on phones (see SoundGraph in voice.js) -- so nothing at all is
 * recorded while you fly. */
(function (ATC) {
  'use strict';

  const MAX_REC_S = 15;
  // What the server accepts; the first one this browser can make wins.
  // Chrome and Firefox make webm/opus, Safari makes mp4/aac.
  const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

  function pickType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  function extFor(type) {
    return /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
  }

  function micError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') {
      return 'Microphone permission was denied -- allow it in the site settings to record.';
    }
    if (name === 'NotFoundError') return 'No microphone was found.';
    return 'Could not open the microphone' + (err && err.message ? ': ' + err.message : '.');
  }

  /**
   * opts:
   *   attempts()   recent transmissions, newest first:
   *                [{heard, result, kind, alternatives, sim_t}]
   *   context()    {scenario, aircraft} -- what was on the scope
   *   onOpen()     the dialog opened: stop listening, pause the sim
   *   onClose()    and closed again
   *   onSent(id)   a report went in
   */
  class Feedback {
    constructor(opts) {
      this.opts = opts;
      const $ = id => document.getElementById(id);
      this.el = {
        modal: $('reportModal'), anon: $('reportAnon'), anonFoot: $('reportAnonFoot'),
        anonClose: $('reportAnonClose'), form: $('reportForm'), attempts: $('reportAttempts'),
        said: $('reportSaid'), recBtn: $('recBtn'), playback: $('recPlayback'),
        discard: $('recDiscard'), recStatus: $('recStatus'), consentRow: $('recConsentRow'),
        consent: $('recConsent'), msg: $('reportMsg'), cancel: $('reportCancel'),
        send: $('reportSend'),
      };
      this.isOpen = false;
      this.list = [];
      this.recorder = null;
      this.stream = null;
      this.blob = null;
      this.blobUrl = null;
      this.recTimer = null;
      this.cancelled = false;
      const meta = document.querySelector('meta[name="csrf-token"]');
      this.csrf = meta ? meta.getAttribute('content') : '';
      if (!this.el.modal) return;

      this.el.cancel.addEventListener('click', () => this.close());
      this.el.anonClose.addEventListener('click', () => this.close());
      this.el.form.addEventListener('submit', e => { e.preventDefault(); this.send(); });
      this.el.recBtn.addEventListener('click', () => {
        if (this.recording()) this.stopRec(); else this.startRec();
      });
      this.el.discard.addEventListener('click', () => this.discard());
      this.el.consent.addEventListener('change', () => this.message(''));
      this.el.modal.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });

      const canRecord = typeof navigator !== 'undefined' && navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia && window.MediaRecorder;
      if (!canRecord) {
        this.el.recBtn.disabled = true;
        this.status('Recording isn’t available in this browser — ' +
          'the transcript on its own still helps.');
      }
    }

    open() {
      if (this.isOpen || !this.el.modal) return;
      this.isOpen = true;
      if (this.opts.onOpen) this.opts.onOpen();
      this.list = this.opts.attempts();
      this.renderAttempts();
      this.el.said.value = '';
      this.message('');
      this.el.send.disabled = false;
      this.showForm(true);
      this.el.modal.classList.add('show');
      // Asked fresh rather than trusted from page load: you may have logged
      // in in another tab since, which also changes the CSRF token.
      fetch('/api/me', { credentials: 'same-origin' })
        .then(r => r.json())
        .then(me => {
          if (!this.isOpen) return;
          if (me.csrf) this.csrf = me.csrf;
          this.showForm(!!me.user);
          if (me.user) this.el.said.focus();
        })
        .catch(() => {});   // offline: leave the form up; sending will say so
    }

    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.stopRec(true);
      this.discard();
      this.el.modal.classList.remove('show');
      if (this.opts.onClose) this.opts.onClose();
    }

    showForm(loggedIn) {
      this.el.form.hidden = !loggedIn;
      this.el.anon.hidden = loggedIn;
      this.el.anonFoot.hidden = loggedIn;
    }

    /** Each recent transmission with a tick box. The ones that weren't
     *  understood start ticked; if none failed, the latest one does. */
    renderAttempts() {
      const box = this.el.attempts;
      box.innerHTML = '';
      if (!this.list.length) {
        const p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'Nothing heard yet this run.';
        box.appendChild(p);
        return;
      }
      const anyErr = this.list.some(a => a.kind === 'err');
      this.list.forEach((a, i) => {
        const row = document.createElement('label');
        row.className = 'attempt ' + (a.kind || '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = anyErr ? a.kind === 'err' : i === 0;
        cb.setAttribute('data-i', String(i));
        const heard = document.createElement('span');
        heard.className = 'heard';
        heard.textContent = '“' + a.heard + '”';
        const res = document.createElement('small');
        res.textContent = a.result;
        row.appendChild(cb);
        row.appendChild(heard);
        row.appendChild(res);
        box.appendChild(row);
      });
    }

    // ------------------------------------------------------------ recording
    recording() {
      return !!(this.recorder && this.recorder.state === 'recording');
    }

    startRec() {
      this.discard();
      this.status('Opening the microphone…');
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (!this.isOpen) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        const type = pickType();
        let rec;
        try {
          rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
        } catch (err) {
          this.releaseMic();
          this.status('Could not start recording: ' + (err && err.message), 'err');
          return;
        }
        const chunks = [];
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          clearInterval(this.recTimer);
          this.recTimer = null;
          this.releaseMic();
          this.el.recBtn.classList.remove('rec');
          this.el.recBtn.textContent = '● Record again';
          if (this.cancelled) { this.cancelled = false; return; }
          const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
          if (!blob.size) { this.status('Nothing was recorded — try again.', 'err'); return; }
          this.blob = blob;
          this.blobUrl = URL.createObjectURL(blob);
          this.el.playback.src = this.blobUrl;
          this.el.playback.hidden = false;
          this.el.discard.hidden = false;
          this.el.consentRow.hidden = false;
          this.status('Recorded. Play it back to check, then tick the box below to send it.');
        };
        rec.start();
        this.recorder = rec;
        this.el.recBtn.classList.add('rec');
        this.el.recBtn.textContent = '■ Stop';
        const t0 = Date.now();
        const tick = () => {
          const s = (Date.now() - t0) / 1000;
          if (s >= MAX_REC_S) { this.stopRec(); return; }
          this.status('Recording ' + Math.floor(s) + 's — say it now, then press Stop.', 'ok');
        };
        tick();
        this.recTimer = setInterval(tick, 250);
      }).catch(err => this.status(micError(err), 'err'));
    }

    /** Stop recording; `cancel` throws the recording away and frees the mic. */
    stopRec(cancel) {
      if (this.recording()) {
        this.cancelled = !!cancel;
        this.recorder.stop();
      } else if (cancel) {
        if (this.recTimer) clearInterval(this.recTimer);
        this.recTimer = null;
        this.releaseMic();
      }
    }

    /** Give the microphone back -- recognition needs it once we're done. */
    releaseMic() {
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.recorder = null;
    }

    discard() {
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blob = null;
      this.blobUrl = null;
      if (!this.el.playback) return;
      this.el.playback.removeAttribute('src');
      this.el.playback.hidden = true;
      this.el.discard.hidden = true;
      this.el.consentRow.hidden = true;
      this.el.consent.checked = false;
      if (!this.recording()) {
        this.el.recBtn.textContent = '● Record';
        if (!this.el.recBtn.disabled) this.status('');
      }
    }

    status(text, cls) {
      const el = this.el.recStatus;
      if (!el) return;
      el.hidden = !text;
      el.textContent = text || '';
      el.className = 'micstatus' + (cls ? ' ' + cls : '');
    }

    message(text, cls) {
      const el = this.el.msg;
      el.hidden = !text;
      el.textContent = text || '';
      el.className = 'micstatus' + (cls ? ' ' + cls : '');
    }

    // --------------------------------------------------------------- send
    send() {
      const ticks = Array.prototype.map.call(
        this.el.attempts.querySelectorAll('input[type=checkbox]'), cb => cb.checked);
      const said = this.el.said.value.trim();
      if (this.recording()) return this.message('Stop the recording first.', 'err');
      if (!said && !ticks.some(Boolean)) {
        return this.message('Tick a transmission, or say what you actually said.', 'err');
      }
      if (this.blob && !this.el.consent.checked) {
        return this.message('Tick the box to agree to the recording being kept — ' +
          'or discard it.', 'err');
      }
      const ctx = this.opts.context ? this.opts.context() : {};
      const payload = {
        said,
        attempts: this.list.map((a, i) => Object.assign({}, a, { flagged: !!ticks[i] })),
        consent: !!(this.blob && this.el.consent.checked),
        page: location.pathname + location.search,
        scenario: ctx.scenario,
        aircraft: ctx.aircraft,
      };
      const fd = new FormData();
      fd.append('payload', JSON.stringify(payload));
      if (this.blob) fd.append('audio', this.blob, 'recording.' + extFor(this.blob.type));

      this.el.send.disabled = true;
      this.message('Sending…');
      fetch('/api/report', {
        method: 'POST', body: fd, credentials: 'same-origin',
        headers: { 'X-CSRF-Token': this.csrf },
      })
        .then(r => r.json().catch(() => ({})).then(j => ({ status: r.status, ok: r.ok, j })))
        .then(({ status, ok, j }) => {
          this.el.send.disabled = false;
          if (ok) {
            this.close();
            if (this.opts.onSent) this.opts.onSent(j.id);
          } else if (status === 401) {
            this.showForm(false);
          } else if (status === 413) {
            this.message('That recording is too big to send — record a shorter one.', 'err');
          } else {
            this.message(j.error || 'Could not send the report (' + status + ').', 'err');
          }
        })
        .catch(() => {
          this.el.send.disabled = false;
          this.message('Could not send — check your connection and try again.', 'err');
        });
    }
  }

  ATC.Feedback = Feedback;
})(window.ATC = window.ATC || {});
