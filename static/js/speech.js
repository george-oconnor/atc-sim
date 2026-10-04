/* Standard phraseology: reading numbers out, and parsing/grading what the
 * controller says back. The assessment marks phraseology explicitly, so the
 * parser is deliberately strict about structure and reports what was wrong
 * rather than silently accepting a sloppy instruction. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  const WORD = ['zero', 'one', 'two', 'three', 'four', 'five',
                'six', 'seven', 'eight', 'nine'];

  const NUM = {
    zero: 0, oh: 0, nought: 0,
    one: 1, two: 2, three: 3, tree: 3,
    four: 4, fower: 4, five: 5, fife: 5,
    six: 6, seven: 7, eight: 8, ait: 8, nine: 9, niner: 9,
  };

  // Grouped number words. Saying these is itself the fault the preparation
  // material calls out -- "never twenty-three, always two three" -- so we
  // understand them in order to be able to mark them.
  const TENS = {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const SKIP = { to: 1, and: 1, at: 1, a: 1 };

  const AIRLINE_WORD = { american: 'AAL', delta: 'DAL', united: 'UAL' };

  // Words the recogniser reliably substitutes for a real one in this closed
  // vocabulary -- none of these mean anything else here, so any occurrence
  // is safe to read as a mishearing rather than a fault.
  const MISHEARD = {
    // "Climb to"/"descend to" said quickly come back as the past tense, or
    // clipped down to just a sound-alike, far more often than not.
    climbed: ['climb', 'to'], descended: ['descend', 'to'],
    percent: ['descend'],   // "descend" clips to something that sounds like "per cent"
    send: ['descend'],      // "de-" drops off the front, leaving "...send to"
    '%': ['descend'],       // same mishearing again, but as the bare symbol -- see tokenize()
    unit: ['united'],       // the "-ed" drops off the callsign's airline name too
  };

  /** "451" -> "four five one" */
  function digits(s) {
    return String(s).split('').map(c => WORD[+c] || c).join(' ');
  }
  function heading(h) { return digits(String(Math.round(h) % 360 || 360).padStart(3, '0')); }
  function flSpoken(fl) { return 'flight level ' + digits(String(fl).padStart(3, '0')); }

  function tokenize(text) {
    const words = text.toLowerCase()
      .replace(/[.,!?;:]/g, ' ')
      .replace(/\bper\s+cent\b/g, 'percent')   // dictation sometimes splits it in two
      .replace(/%\s*of\b/g, ' descend ')       // ...and sometimes writes the symbol instead,
                                                // with "to" autocorrected to the more fluent "of"
                                                // (spaced: "98% of" must not fuse into "98descend")
      // Any "%" still left over is the same mishearing with nothing after
      // it -- and it often arrives glued straight onto the callsign's
      // digits ("130%"), which would otherwise fail the pure-digit check
      // in readDigits() and get read as no flight number at all. Force it
      // apart into its own token first, then MISHEARD below turns it into
      // "descend" same as everything else in this family.
      .replace(/%/g, ' % ')
      // Dictation sometimes hyphenates a spoken digit run ("zero six zero"
      // -> "0-60"), which would otherwise be one token that isn't a number.
      .replace(/[-‐‑–—]/g, ' ')
      .replace(/\bfl\s*(\d)/g, 'fl$1')
      .trim().split(/\s+/).filter(Boolean);
    const out = [];
    words.forEach(w => { if (w in MISHEARD) out.push.apply(out, MISHEARD[w]); else out.push(w); });
    return out;
  }

  /**
   * Read a run of number tokens.
   * Returns the digit string if they were spoken digit by digit, or a value
   * plus `grouped` if they were run together ("two eighty", "seventy").
   */
  function readDigits(tok, i) {
    let sawTo = false;
    while (i < tok.length && tok[i] in SKIP) { if (tok[i] === 'to') sawTo = true; i++; }
    const run = [];
    while (i < tok.length) {
      const t = tok[i];
      if (t in NUM || t in TENS || t === 'hundred' || /^\d+$/.test(t)) { run.push(t); i++; }
      else if (/^fl\d+$/.test(t)) { run.push(t.slice(2)); i++; }
      else if (t in SKIP && run.length) { i++; }
      else break;
    }
    if (!run.length) return { digits: '', value: null, grouped: false, i };

    const grouped = run.some(t => t in TENS || t === 'hundred');
    if (!grouped) {
      let str = run.map(t => (t in NUM ? NUM[t] : t)).join('');
      // "two" and "to" are homophones, and the recogniser separately tends
      // to collapse a spoken digit pair into a bare numeral ("seven zero"
      // -> "70") -- together, "two seven zero" comes back as "to 70",
      // which swallows the leading digit as filler instead of reading it.
      // A single two-digit numeral straight after a skipped "to" is that
      // exact signature, not someone genuinely giving only two digits.
      if (sawTo && run.length === 1 && /^\d\d$/.test(run[0])) str = '2' + str;
      return { digits: str, value: null, grouped: false, i };
    }
    // "three sixty" / "two eighty" -- a leading single digit means hundreds.
    let total = 0, cur = 0;
    run.forEach((t, k) => {
      if (t === 'hundred') { cur = (cur || 1) * 100; return; }
      const v = t in NUM ? NUM[t] : t in TENS ? TENS[t] : parseInt(t, 10);
      if (k === 0 && v >= 1 && v <= 9 && run.length > 1 &&
          (run[1] in TENS || run[1] === 'hundred')) {
        cur = run[1] === 'hundred' ? v : v * 100;
        if (run[1] === 'hundred') return;
        return;
      }
      cur += v;
    });
    total += cur;
    return { digits: '', value: total, grouped: true, i };
  }

  /** Resolve a number run into a value, adding a fault note if it was grouped. */
  function resolve(r, notes, what, fmt) {
    if (r.grouped) {
      notes.push('Say every digit separately — "' + fmt(r.value) + '", not "' +
        what + ' ' + r.value + '" run together.');
      return r.value;
    }
    return parseInt(r.digits, 10);
  }

  /**
   * Parse a controller transmission.
   * Returns { ok, correction, callsign, action, notes[], error }
   * `notes` are phraseology faults — the instruction may still be actioned.
   */
  function parse(text, sim) {
    const notes = [];
    let tok = tokenize(text);
    if (!tok.length) return { ok: false, error: 'empty' };

    let correction = false;
    if (tok[0] === 'correction') { correction = true; tok = tok.slice(1); }

    // Two transmissions spoken back-to-back can arrive as a single result --
    // the recogniser doesn't always break cleanly on the pause between them.
    // Guessing which words belong to which aircraft or instruction is how
    // you get the right words actioned against the wrong aircraft, so
    // disregard the whole thing rather than parse it as one.
    const callsignMentions = tok.filter(t => t in AIRLINE_WORD).length +
      tok.filter(t => /^(aal|dal|ual)\d{1,3}$/.test(t)).length;
    const instructionStarts = tok.filter(t => t === 'turn').length +
      tok.filter(t => t === 'climb' || t === 'descend' || t === 'descent' || t === 'maintain').length;
    if (callsignMentions > 1 || instructionStarts > 1) {
      return { ok: false, error: 'more than one aircraft or instruction in that ' +
        'transmission — say them one at a time' };
    }

    // ---- callsign -------------------------------------------------------
    let callsign = null, i = 0, spokenAirline = false;
    const m3 = tok[0] && tok[0].match(/^(aal|dal|ual)(\d{1,3})$/);
    if (tok[0] in AIRLINE_WORD) {
      const prefix = AIRLINE_WORD[tok[0]];
      const r = readDigits(tok, 1);
      if (!r.digits) return { ok: false, error: 'no flight number after "' + tok[0] + '"' };
      callsign = prefix + r.digits;
      i = r.i;
      spokenAirline = true;
    } else if (m3) {
      callsign = m3[1].toUpperCase() + m3[2];
      i = 1;
      notes.push('Say the airline name, not the code — "' +
        Object.keys(AIRLINE_WORD).find(k => AIRLINE_WORD[k] === m3[1].toUpperCase()) +
        '", then each digit.');
    } else {
      return { ok: false, error: 'no callsign — start with American, Delta or United' };
    }

    const ac = sim.byCallsign(callsign);
    if (!ac) return { ok: false, error: 'no aircraft "' + callsign + '" on frequency',
                      callsign: callsign };

    // ---- instruction ----------------------------------------------------
    const rest = tok.slice(i);
    if (!rest.length) return { ok: true, callsign, ac, action: null, notes, correction };

    const has = w => rest.indexOf(w) >= 0;
    const at = w => rest.indexOf(w);

    // Turn
    if (has('turn') || has('heading')) {
      let dir = has('left') ? 'L' : has('right') ? 'R' : null;
      let hi = at('heading');
      if (hi < 0) {
        // "turn right zero seven zero" — understood, but say "heading".
        hi = Math.max(at('left'), at('right'), at('turn'));
        notes.push('Say "heading" before the numbers.');
      }
      const r = readDigits(rest, hi + 1);
      if (!r.digits && r.value == null) return { ok: false, error: 'no heading given', ac };
      const raw = resolve(r, notes, 'heading', heading);
      if (!r.grouped && r.digits.length !== 3) {
        notes.push('Headings are three digits — say "' + heading(raw) + '".');
      }
      if (raw > 360) return { ok: false, error: 'heading ' + raw + ' is not valid', ac };
      const hdg = raw % 360;
      if (!has('turn')) notes.push('Say "turn left" or "turn right heading ...".');
      const shorter = ac.shorterTurn(hdg);
      if (!dir) {
        notes.push('State the turn direction — the shorter way here is ' +
          (shorter === 'L' ? 'left' : 'right') + '.');
        dir = shorter;
      } else if (dir !== shorter &&
                 Math.abs(G.angDiff(hdg, ac.hdg)) > 5 &&
                 Math.abs(G.angDiff(hdg, ac.hdg)) < 175) {
        notes.push('Turn ' + (shorter === 'L' ? 'left' : 'right') +
          ' is the shorter way from heading ' + G.fmtHdg(ac.hdg) + '.');
      }
      return { ok: true, callsign, ac, correction, notes,
               action: { kind: 'turn', hdg, dir } };
    }

    // Level
    const climb = has('climb'), descend = has('descend') || has('descent');
    const maintain = has('maintain');
    if (climb || descend || maintain || has('level')) {
      let start = at('level');
      if (start >= 0) {
        if (rest[start - 1] !== 'flight') notes.push('Say "flight level", not just "level".');
      } else {
        // "climb to two eight zero" — actioned, but the words are missing.
        start = Math.max(at('climb'), at('descend'), at('descent'), at('maintain'));
        if (start < 0) return { ok: false, error: 'no flight level given', ac };
        notes.push('Say "flight level" before the numbers.');
      }
      const r = readDigits(rest, start + 1);
      if (!r.digits && r.value == null) {
        return { ok: false, error: 'no flight level given', ac };
      }
      const fl = resolve(r, notes, 'flight level', flSpoken);
      if (!r.grouped && r.digits.length !== 3) {
        notes.push('Flight levels are three digits — say "' + flSpoken(fl) + '".');
      }
      if (fl < 10 || fl > 450) return { ok: false, error: 'FL' + fl + ' is not valid', ac };
      if (!climb && !descend && !maintain) {
        notes.push('Start with "climb to", "descend to" or "maintain".');
      } else if (climb && fl * 100 < ac.alt) {
        notes.push(ac.callsign + ' is at FL' + String(ac.fl).padStart(3, '0') +
          ' — that is a descent, not a climb.');
      } else if (descend && fl * 100 > ac.alt) {
        notes.push(ac.callsign + ' is at FL' + String(ac.fl).padStart(3, '0') +
          ' — that is a climb, not a descent.');
      }
      return { ok: true, callsign, ac, correction, notes, action: { kind: 'level', fl } };
    }

    return { ok: false, error: 'instruction not understood', ac };
  }

  /** The instruction itself, without the callsign. */
  function instruction(ac, action) {
    if (action.kind === 'turn') {
      return 'turn ' + (action.dir === 'L' ? 'left' : 'right') +
        ' heading ' + heading(action.hdg);
    }
    const verb = action.fl * 100 > ac.alt ? 'climb to'
      : action.fl * 100 < ac.alt ? 'descend to' : 'maintain';
    return verb + ' ' + flSpoken(action.fl);
  }

  /** The model transmission for an instruction — shown as feedback. */
  function model(ac, action) {
    return instruction(ac, action) + ', ' + ac.spoken();
  }

  /** The instruction as the controller sent it, callsign first: what the
   *  parser understood, rather than the words as recognised. */
  function sent(ac, action) {
    return ac.spoken() + (action ? ', ' + instruction(ac, action) : '');
  }

  /** A transmission as it should read in a caption: spoken digits run
   *  together ("one three zero" -> "130"), airline names capitalised.
   *  Display only -- grading always works on the words as said. */
  const CAP_DIGIT = { zero: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, five: 5,
    fife: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };
  function tidy(text) {
    const out = [];
    let run = '';
    String(text).split(/\s+/).filter(Boolean).forEach(w => {
      const m = w.match(/^([a-z]+)([,.]?)$/i);
      const d = m ? CAP_DIGIT[m[1].toLowerCase()] : undefined;
      if (d !== undefined) {
        run += d;
        if (m[2]) { out.push(run + m[2]); run = ''; }
        return;
      }
      if (run) { out.push(run); run = ''; }
      out.push(/^(american|delta|united),?$/i.test(w)
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
    });
    if (run) out.push(run);
    const s = out.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** What the pilot transmits back when the instruction wasn't understood. */
  function sayAgain(ac) {
    return 'say again, ' + ac.spoken();
  }

  /** Is this token part of a number, however it was said? */
  function isNumberWord(t) {
    return t in NUM || t in TENS || t === 'hundred' || /^\d+$/.test(t);
  }

  /** Words that belong to standard phraseology. Anything else is filler. */
  const KEYWORD = {
    turn: 1, left: 1, right: 1, heading: 1, climb: 1, descend: 1, descent: 1,
    maintain: 1, flight: 1, level: 1, correction: 1, to: 1, and: 1,
  };

  /**
   * What part of a transmission is this word? Drives the live highlighting.
   * A word straight out of MISHEARD is coloured as whatever it actually
   * means, not filler -- recursing through the correction rather than
   * hand-listing every mishearing here too is what keeps this in step with
   * MISHEARD without anyone having to remember to update both.
   */
  function role(word) {
    const t = String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!t) return 'x';
    if (t in MISHEARD) return role(MISHEARD[t][0]);
    if (t in AIRLINE_WORD) return 'cs';
    if (isNumberWord(t)) return 'num';
    if (t in KEYWORD) return 'kw';
    return 'x';
  }

  ATC.speech = { digits, heading, flSpoken, parse, model, sent, sayAgain, tidy, tokenize, role,
                 isNumberWord, WORD, AIRLINE_WORD, KEYWORD };
})(window.ATC = window.ATC || {});
