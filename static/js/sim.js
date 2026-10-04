/* Simulation engine for the corridor exercises.
 *
 * Scoring follows what the assessment says it looks at: keeping aircraft
 * inside the corridor, maintaining separation (1000 ft vertically OR 3 NM
 * laterally), delivering each aircraft at its exit flight level, and correct
 * standard phraseology. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  const SCORE = {
    exitCorrect:  100,
    exitWrongFL:  -40,
    excursion:    -60,   // outside the corridor walls, once per excursion
    lostAirspace: -80,   // never came back
    loss:        -150,   // actual loss of separation, once per pair
    phraseology:   -5,   // per fault
  };

  class Sim {
    constructor(scen) {
      this.scen = scen;
      this.corridors = scen.corridors || [];
      this.sepLat = (scen.separation && scen.separation.lateral_nm) || 3;
      this.sepVert = (scen.separation && scen.separation.vertical_ft) || 1000;

      this.t = 0;
      this.rate = 1;
      this.paused = true;
      this.finished = false;
      this.aircraft = [];
      this.pending = (scen.traffic || []).slice().sort((a, b) => a.t - b.t);
      this.pairSeen = new Set();
      this.events = [];
      this.notices = [];   // events for the UI to flash once, then drop
      this.score = 0;
      this.handled = 0;
      this.correct = 0;
      this.losses = 0;
      this.excursions = 0;
      this.instructions = 0;
      this.faults = 0;
      this.conflicts = [];
      this.startedAt = Date.now() / 1000;
      this.duration = (scen.duration_min || 12) * 60;
      this.closestCall = Infinity;
    }

    /** `transient` events (entries, exits, separation losses, airspace
     *  excursions) are flashed on the radar as they happen; every event is
     *  kept for the debrief. */
    log(kind, text, pts, transient) {
      const ev = { t: this.t, kind, text, pts: pts || 0 };
      if (transient) { ev.transient = true; this.notices.push(ev); }
      this.events.unshift(ev);
      if (pts) this.score += pts;
    }

    penaliseFaults(n) {
      if (!n) return;
      this.faults += n;
      this.score += SCORE.phraseology * n;
    }

    // ------------------------------------------------------------- traffic
    spawn() {
      while (this.pending.length && this.pending[0].t <= this.t) {
        const spec = this.pending.shift();
        const ac = new ATC.Aircraft(spec, this.scen);
        this.aircraft.push(ac);
        this.log('entry', ac.callsign + ' entering at FL' +
          String(ac.fl).padStart(3, '0') + ', exit FL' +
          String(ac.exitFL).padStart(3, '0'), 0, true);
      }
    }

    // ---------------------------------------------------------- separation
    /** Where an aircraft's altitude will be in `t` seconds: climbing or
     *  descending at its current rate, but levelling off at its cleared
     *  level rather than carrying on through it. */
    predictAlt(ac, t) {
      if (!ac.vs) return ac.alt;
      const moved = ac.alt + ac.vs * t / 60;
      return ac.vs > 0 ? Math.min(moved, ac.altCmd) : Math.max(moved, ac.altCmd);
    }

    /** Will both minima be broken at the same moment in the next `horizon`
     *  seconds? Sampled every few seconds rather than only at the closest
     *  point, because a climb or descent changes the vertical picture along
     *  the way -- the closest lateral point can be safely separated
     *  vertically while an earlier moment is not, and the reverse.
     *  Returns the closest point inside the predicted loss, or null. */
    predictLoss(a, b, horizon) {
      const rx = b.x - a.x, ry = b.y - a.y;
      const av = G.project({ x: 0, y: 0 }, a.hdg, a.gs / 3600);
      const bv = G.project({ x: 0, y: 0 }, b.hdg, b.gs / 3600);
      const vx = bv.x - av.x, vy = bv.y - av.y;
      let worst = null;
      for (let t = 0; t <= horizon; t += 2) {
        const d = Math.hypot(rx + vx * t, ry + vy * t);
        if (d >= this.sepLat) continue;
        if (Math.abs(this.predictAlt(a, t) - this.predictAlt(b, t)) >= this.sepVert) continue;
        if (!worst || d < worst.d) worst = { d, tca: t };
      }
      return worst;
    }

    checkSeparation() {
      this.conflicts = [];
      const live = this.aircraft.filter(a => a.state === 'active');
      live.forEach(a => { a.conflict = false; a.alert = false; });

      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          const dh = G.dist(a, b);
          const dv = Math.abs(a.alt - b.alt);

          if (dv < this.sepVert && dh < 30) this.closestCall = Math.min(this.closestCall, dh);

          if (dh < this.sepLat && dv < this.sepVert) {
            a.conflict = b.conflict = true;
            this.conflicts.push({ a, b, kind: 'loss', d: dh });
            const key = [a.callsign, b.callsign].sort().join('|');
            if (!this.pairSeen.has(key)) {
              this.pairSeen.add(key);
              this.losses++;
              this.log('loss', 'SEPARATION LOST  ' + a.callsign + ' / ' + b.callsign +
                ' — ' + dh.toFixed(1) + ' NM apart, ' + Math.round(dv) + ' ft',
                SCORE.loss, true);
            }
            continue;
          }

          const p = this.predictLoss(a, b, 150);
          if (p) {
            a.alert = b.alert = true;
            this.conflicts.push({ a, b, kind: 'alert', d: p.d, tca: p.tca });
          }
        }
      }
    }

    // ------------------------------------------------------------ airspace
    insideAny(ac) {
      return this.corridors.some(c => G.corridorProject(ac, c).inside);
    }

    finish(ac, outcome, kind, text, pts) {
      ac.state = 'done';
      ac.outcome = outcome;
      this.handled++;
      if (outcome === 'correct') this.correct++;
      this.log(kind, text, pts, true);
    }

    checkAirspace() {
      this.aircraft.forEach(ac => {
        if (ac.state !== 'active') return;
        const own = this.corridors[ac.corridor] || this.corridors[0];
        const pr = G.corridorProject(ac, own);
        const inside = this.insideAny(ac);

        const outFar = ac.dir > 0 ? pr.after : pr.before;
        const outBack = ac.dir > 0 ? pr.before : pr.after;

        // Reached the hand-off point at the far end of the corridor.
        if (outFar) {
          const flOk = ac.fl === ac.exitFL;
          if (flOk) {
            this.finish(ac, 'correct', 'good',
              ac.callsign + ' left the sector at FL' + String(ac.fl).padStart(3, '0') +
              ' as required', SCORE.exitCorrect);
          } else {
            this.finish(ac, 'wrongfl', 'bad',
              ac.callsign + ' left the sector at FL' + String(ac.fl).padStart(3, '0') +
              ' — exit level was FL' + String(ac.exitFL).padStart(3, '0'),
              SCORE.exitWrongFL);
          }
          return;
        }

        // Turned back and gone out the way it came.
        if (outBack && this.t > ac.entryTime + 45) {
          this.finish(ac, 'back', 'bad',
            ac.callsign + ' left the sector backwards through the entry point',
            SCORE.lostAirspace);
          return;
        }

        // Out through the side wall.
        if (!inside) {
          ac.outside = true;
          if (!ac.warned) {
            ac.warned = true;
            this.excursions++;
            this.log('bad', ac.callsign + ' is outside controlled airspace — ' +
              (pr.d - own.width_nm / 2).toFixed(1) + ' NM beyond the ' +
              (pr.side > 0 ? 'right' : 'left') + ' boundary', SCORE.excursion, true);
          }
          if (pr.d > own.width_nm / 2 + 25) {
            this.finish(ac, 'lost', 'bad',
              ac.callsign + ' lost — never recovered into controlled airspace',
              SCORE.lostAirspace);
          }
        } else if (ac.outside) {
          ac.outside = false;
          ac.warned = false;           // a later excursion counts again
          this.log('good', ac.callsign + ' back inside controlled airspace', 0, true);
        }
      });
    }

    // ---------------------------------------------------------------- tick
    step(dt) {
      if (this.paused || this.finished) return;
      const sdt = dt * this.rate;
      this.t += sdt;
      this.spawn();
      this.aircraft.forEach(a => a.update(sdt));
      this.checkAirspace();
      this.checkSeparation();
      if (this.t >= this.duration ||
          (!this.pending.length && this.aircraft.every(a => a.state !== 'active'))) {
        this.finished = true;
        this.paused = true;
      }
    }

    byCallsign(cs) {
      cs = cs.toUpperCase();
      return this.aircraft.find(a => a.state === 'active' && a.callsign === cs) || null;
    }

    summary() {
      return {
        scenario: this.scen.id,
        started_at: this.startedAt,
        score: Math.round(this.score),
        handled: this.handled,
        correct: this.correct,
        losses: this.losses,
        commands: this.instructions,
        detail: {
          variant: this.scen.variant || null,
          events: this.events.slice(0, 80),
          sim_seconds: Math.round(this.t),
          excursions: this.excursions,
          phraseology_faults: this.faults,
          closest_call_nm: isFinite(this.closestCall)
            ? Math.round(this.closestCall * 10) / 10 : null,
        },
      };
    }
  }

  ATC.Sim = Sim;
  ATC.SCORE = SCORE;
})(window.ATC = window.ATC || {});
