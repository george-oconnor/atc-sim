/* Flight model.
 *
 * Scope matches the assessment: the controller may only turn an aircraft and
 * climb/descend it. Speed is shown on the label but is not controllable, so
 * there is no speed command here — the pilot flies the filed speed. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  const PERF = {
    J: { climb: 2000, descent: 2000, turn: 3 },   // jet, rate-one turns
    T: { climb: 1500, descent: 1500, turn: 3 },   // turboprop
  };

  const AIRLINES = {
    AAL: { spoken: 'American', name: 'American Airlines' },
    DAL: { spoken: 'Delta',    name: 'Delta Air Lines' },
    UAL: { spoken: 'United',   name: 'United Airlines' },
  };

  let nextId = 1;

  class Aircraft {
    constructor(spec, scen) {
      this.id = nextId++;
      this.callsign = spec.callsign;
      this.prefix = spec.callsign.slice(0, 3);
      this.digits = spec.callsign.slice(3);
      this.airline = AIRLINES[this.prefix] || { spoken: this.prefix };
      this.type = spec.type || 'B738';
      this.perf = PERF[spec.cat || 'J'];

      this.x = spec.x; this.y = spec.y;
      this.alt = spec.fl * 100;
      this.hdg = spec.hdg;
      this.ias = spec.speed;          // constant; the label shows it

      this.altCmd = (spec.clearedFl != null ? spec.clearedFl : spec.fl) * 100;
      this.hdgCmd = spec.hdg;
      this.turnDir = null;
      this.vs = 0;

      this.exitFL = spec.exitFl;      // the level it must leave the sector at
      this.corridor = spec.corridor || 0;
      this.dir = spec.dir || 1;       // +1 along the corridor, -1 against it

      this.entryTime = spec.t || 0;
      this.state = 'active';          // active | done
      this.outcome = null;
      this.history = [];
      this._histAcc = 0;

      this.conflict = false;          // live loss of separation
      this.alert = false;             // predicted loss inside 2 min
      this.outside = false;           // outside the corridor walls
      this.warned = false;            // already penalised for leaving
      this.selected = false;
      this.instructions = 0;
      this.scen = scen;
    }

    get tas() { return this.ias * (1 + 0.02 * (this.alt / 1000)); }
    get gs()  { return this.tas; }
    get fl()  { return Math.round(this.alt / 100); }
    get clearedFl() { return Math.round(this.altCmd / 100); }

    /** "American four five one" */
    spoken() {
      return this.airline.spoken + ' ' + ATC.speech.digits(this.digits);
    }

    // ------------------------------------------------------------ commands
    cmdHeading(h, dir) {
      this.hdgCmd = G.norm360(h);
      this.turnDir = dir || null;
      this.instructions++;
      return { kind: 'heading', hdg: this.hdgCmd, dir: dir };
    }

    cmdLevel(fl) {
      const was = this.fl;
      this.altCmd = fl * 100;
      this.instructions++;
      return { kind: fl * 100 > this.alt ? 'climb' : fl * 100 < this.alt ? 'descend'
               : 'maintain', fl: fl, from: was };
    }

    /** Shortest turn direction from the present heading to `h`. */
    shorterTurn(h) { return G.angDiff(h, this.hdg) >= 0 ? 'R' : 'L'; }

    // ------------------------------------------------------------ dynamics
    update(dt) {
      if (this.state !== 'active') return;
      const p = this.perf;

      let d = G.angDiff(this.hdgCmd, this.hdg);
      if (this.turnDir === 'L' && d > 0) d -= 360;
      if (this.turnDir === 'R' && d < 0) d += 360;
      const maxTurn = p.turn * dt;
      if (Math.abs(d) <= maxTurn) { this.hdg = this.hdgCmd; this.turnDir = null; }
      else this.hdg = G.norm360(this.hdg + Math.sign(d) * maxTurn);

      const dAlt = this.altCmd - this.alt;
      if (Math.abs(dAlt) < 20) { this.alt = this.altCmd; this.vs = 0; }
      else {
        const rate = dAlt > 0 ? p.climb : p.descent;
        this.vs = Math.sign(dAlt) * rate;
        this.alt += Math.sign(dAlt) * Math.min((rate / 60) * dt, Math.abs(dAlt));
      }

      const nm = (this.gs / 3600) * dt;
      const np = G.project(this, this.hdg, nm);
      this.x = np.x; this.y = np.y;

      this._histAcc += dt;
      if (this._histAcc >= 5) {          // one radar sweep every 5 s
        this._histAcc = 0;
        this.history.push({ x: this.x, y: this.y });
        if (this.history.length > 5) this.history.shift();
      }
    }
  }

  ATC.Aircraft = Aircraft;
  ATC.AIRLINES = AIRLINES;
})(window.ATC = window.ATC || {});
