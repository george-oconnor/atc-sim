/* Standalone microphone diagnostic. Deliberately independent of the sim's
 * voice.js: it talks to getUserMedia and SpeechRecognition directly and logs
 * every raw event, so a failure here can't be blamed on anything else in the
 * app, and the log itself is the evidence needed to diagnose it. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  const log = $('evlog');
  const t0 = performance.now();

  function ts() { return ((performance.now() - t0) / 1000).toFixed(2) + 's'; }

  function line(text, cls) {
    const row = document.createElement('div');
    row.className = 'evrow' + (cls ? ' ' + cls : '');
    const stamp = document.createElement('span');
    stamp.className = 'evt';
    stamp.textContent = ts();
    row.appendChild(stamp);
    row.appendChild(document.createTextNode(text));
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.appendChild(row);
    if (atBottom) log.scrollTop = log.scrollHeight;   // only follow if not reading back
  }

  function setPill(id, ok, text) {
    const el = $(id);
    el.textContent = text;
    el.className = 'pill ' + (ok === null ? 'warn' : ok ? 'ok' : 'bad');
  }

  // ------------------------------------------------------------ capabilities
  const secure = window.isSecureContext !== false;
  setPill('capSecure', secure, secure ? 'secure context' : 'NOT secure -- mic will be blocked');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  setPill('capSR', !!SR, SR
    ? ('available (' + (window.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition') + ')')
    : 'not available in this browser');

  const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  setPill('capGUM', hasGUM, hasGUM ? 'available' : 'not available');

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'microphone' }).then(function (status) {
      setPill('capPerm', status.state === 'granted' ? true
        : status.state === 'denied' ? false : null, status.state);
      status.onchange = function () {
        setPill('capPerm', status.state === 'granted' ? true
          : status.state === 'denied' ? false : null, status.state);
        line('permission state changed to "' + status.state + '"');
      };
    }).catch(function () {
      setPill('capPerm', null, 'unknown (browser will not report it)');
    });
  } else {
    setPill('capPerm', null, 'unknown (no Permissions API)');
  }

  $('ua').textContent = navigator.userAgent;

  // ------------------------------------------------------------- level meter
  // Independent of SpeechRecognition entirely: proves whether audio is
  // physically reaching the browser at all, regardless of whether it ever
  // gets turned into words.
  let audioCtx = null, analyser = null, meterRaf = null, stream = null;
  let peakSinceStart = 0;

  function startMeter() {
    if (!hasGUM) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s;
      line("microphone opened (getUserMedia) -- the tab's mic indicator should be on now", 'good');
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      (function tick() {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.sqrt(sum / data.length);       // 0..1 RMS
        peakSinceStart = Math.max(peakSinceStart, level);
        $('meterBar').style.width = Math.min(100, level * 300) + '%';
        $('meterPeak').style.left = Math.min(100, peakSinceStart * 300) + '%';
        meterRaf = requestAnimationFrame(tick);
      })();
    }).catch(function (err) {
      line('getUserMedia failed: ' + (err && err.name) + ' -- ' + (err && err.message), 'bad');
      setPill('capPerm', false, err && err.name === 'NotAllowedError' ? 'denied' : String(err && err.name));
    });
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    audioCtx = null; analyser = null; stream = null;
    $('meterBar').style.width = '0%';
  }

  // ------------------------------------------------------- speech recogniser
  let rec = null, running = false;
  let heardAudio = false, gotAnyResult = false;
  let noResultTimer = null;

  function startRecognition() {
    if (!SR) { line('SpeechRecognition unavailable -- skipping recognition test', 'bad'); return; }
    rec = new SR();
    rec.lang = 'en-GB';
    rec.continuous = true;
    rec.interimResults = true;
    heardAudio = false; gotAnyResult = false;

    rec.onstart = function () {
      line('onstart -- the recogniser is running', 'good');
      clearTimeout(noResultTimer);
      noResultTimer = setTimeout(function () {
        if (running && heardAudio && !gotAnyResult) {
          line('7s of audio with zero results. This is the classic sign of a ' +
            'browser that cannot reach its speech-to-text backend (Chrome and ' +
            "Edge send audio to Google's servers to transcribe it) -- try a " +
            'different network, turn off any VPN or ad blocker, or try a ' +
            'different browser.', 'bad');
        } else if (running && !heardAudio) {
          line('7s with no audio detected by the recogniser at all, even though ' +
            'the level meter above may be moving -- the recogniser and the ' +
            'microphone may not agree on which input device to use.', 'bad');
        }
      }, 7000);
    };
    rec.onaudiostart = function () { heardAudio = true; line('onaudiostart -- recogniser sees audio'); };
    rec.onsoundstart = function () { line('onsoundstart'); };
    rec.onspeechstart = function () { line('onspeechstart -- recogniser thinks this is speech', 'good'); };
    rec.onspeechend = function () { line('onspeechend'); };
    rec.onsoundend = function () { line('onsoundend'); };
    rec.onaudioend = function () { line('onaudioend'); };
    rec.onresult = function (e) {
      gotAnyResult = true;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0].transcript;
        const conf = r[0].confidence != null ? r[0].confidence.toFixed(2) : 'n/a';
        line((r.isFinal ? 'FINAL' : 'interim') + '  "' + txt + '"  (confidence ' + conf + ')',
             r.isFinal ? 'good' : '');
      }
    };
    rec.onerror = function (e) {
      line('onerror: "' + e.error + '"' + (e.message ? ' -- ' + e.message : ''), 'bad');
    };
    rec.onend = function () {
      line('onend' + (running ? ' (browser ended it; restarting)' : ''));
      if (running) { try { rec.start(); } catch (err) { line('restart failed: ' + err.message, 'bad'); } }
    };
    try {
      rec.start();
    } catch (err) {
      line('rec.start() threw: ' + err.message, 'bad');
    }
  }

  function stopRecognition() {
    clearTimeout(noResultTimer);
    if (rec) { try { rec.stop(); } catch (_) {} }
    rec = null;
  }

  // ------------------------------------------------------------------- UI
  $('startBtn').addEventListener('click', function () {
    if (running) return;
    running = true;
    log.innerHTML = '';
    peakSinceStart = 0;
    $('startBtn').disabled = true;
    $('stopBtn').disabled = false;
    line('test started');
    startMeter();
    startRecognition();
  });

  $('stopBtn').addEventListener('click', function () {
    running = false;
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    stopRecognition();
    stopMeter();
    line('test stopped');
  });
})();
