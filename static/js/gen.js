/* Scenario generator.
 *
 * Every exercise is built from a seed. The corridor is laid out at a random
 * orientation (and, for the bend and the crossing, a random angle), traffic
 * is placed around a handful of designed conflicts and level-change traps,
 * and background aircraft are added that do not conflict at their own
 * levels. The result is then checked for anything silly -- aircraft
 * appearing on top of each other, conflicts with no time to react, nobody
 * on the scope for minutes -- and flown by an automatic controller that
 * knows only what the player can see. Only a scenario that controller flies
 * clean (no losses, everyone out at the exit level, nobody outside the
 * walls) is ever handed to the player.
 *
 * The same code builds the vetted pool offline (tools/build_pool.py) and
 * the unlimited random mode live in the browser. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  const FL_MIN = 200, FL_MAX = 330;        // entry and exit levels
  const SOLVE_MIN = 190, SOLVE_MAX = 350;  // what the auto-controller may use on the way
  const WIDTH = 22;
  const TYPES = ['B738', 'B738', 'A320', 'A321', 'B739', 'A319', 'B752', 'B763',
                 'E175', 'B38M', 'A20N', 'A21N'];
  const AIRLINES = ['AAL', 'DAL', 'UAL'];

  // ------------------------------------------------------------ randomness
  /** mulberry32: small, quick, and the same sequence in every engine. */
  function Rng(seed) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (a, b) => a + next() * (b - a),
      int: (a, b) => a + Math.floor(next() * (b - a + 1)),
      pick: arr => arr[Math.floor(next() * arr.length)],
      chance: p => next() < p,
      shuffle: arr => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
      },
    };
  }

  /** Seed for the k-th attempt from one user-facing seed. */
  function mix(seed, k) {
    let h = (seed >>> 0) ^ Math.imul(k + 1, 0x9E3779B1);
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // -------------------------------------------------------------- geometry
  const P = (x, y) => ({ x, y });
  const r2 = v => Math.round(v * 100) / 100;
  const toPts = path => path.map(q => P(q[0], q[1]));
  const toArr = pts => pts.map(p => [r2(p.x), r2(p.y)]);
  const tas = (ias, alt) => ias * (1 + 0.02 * (alt / 1000));

  /** A corridor's centreline shifted `off` NM to the right of its own
   *  direction, mitred at a bend so the offset holds round the corner. */
  function offsetTrack(path, off) {
    const p = toPts(path), out = [];
    for (let i = 0; i < p.length; i++) {
      let b, scale = 1;
      if (i === 0) b = G.bearing(p[0], p[1]);
      else if (i === p.length - 1) b = G.bearing(p[i - 1], p[i]);
      else {
        const b1 = G.bearing(p[i - 1], p[i]), b2 = G.bearing(p[i], p[i + 1]);
        const turn = G.angDiff(b2, b1);
        b = G.norm360(b1 + turn / 2);
        scale = 1 / Math.cos((turn / 2) * G.D2R);
      }
      out.push(G.project(p[i], b + 90, off * scale));
    }
    return out;
  }

  /** The line an aircraft is meant to fly, in its direction of travel.
   *  `off` is measured in the corridor's frame (right of its path order),
   *  so two aircraft at the same `off` are on the same line whichever way
   *  they are going. */
  function trackOf(spec, scen) {
    const t = offsetTrack(scen.corridors[spec.corridor || 0].path, spec.off || 0);
    return (spec.dir || 1) < 0 ? t.reverse() : t;
  }

  function lengthOf(track) {
    let s = 0;
    for (let i = 0; i < track.length - 1; i++) s += G.dist(track[i], track[i + 1]);
    return s;
  }

  /** Point `s` NM along a track, with the bearing of the leg it is on. */
  function along(track, s) {
    for (let i = 0; i < track.length - 1; i++) {
      const len = G.dist(track[i], track[i + 1]);
      const brg = G.bearing(track[i], track[i + 1]);
      if (s <= len || i === track.length - 2) {
        const p = G.project(track[i], brg, s);
        return { x: p.x, y: p.y, brg, seg: i };
      }
      s -= len;
    }
    return null;
  }

  /** Where two straight lines meet, or null if they are parallel. */
  function intersect(a1, a2, b1, b2) {
    const dax = a2.x - a1.x, day = a2.y - a1.y, dbx = b2.x - b1.x, dby = b2.y - b1.y;
    const den = dax * dby - day * dbx;
    if (Math.abs(den) < 1e-9) return null;
    const u = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den;
    return P(a1.x + dax * u, a1.y + day * u);
  }

  const COMPASS = ['NORTH', 'NORTHEAST', 'EAST', 'SOUTHEAST', 'SOUTH', 'SOUTHWEST',
                   'WEST', 'NORTHWEST'];
  const compass = b => COMPASS[Math.round(G.norm360(b) / 45) % 8];
  const prose = w => w.toLowerCase().replace(/^(north|south)(east|west)$/, '$1-$2');

  // --------------------------------------------------------------- layouts
  function layStraight(R) {
    const brg = R.int(0, 71) * 5, L = R.int(60, 68);
    return [{ name: 'ALPHA', path: [G.project(P(0, 0), brg + 180, L / 2),
                                    G.project(P(0, 0), brg, L / 2)] }];
  }

  function layBend(R) {
    const brg = R.int(0, 71) * 5;
    const turn = R.int(6, 13) * 5 * (R.chance(0.5) ? 1 : -1);    // 30-65 degrees
    const p0 = P(0, 0), p1 = G.project(p0, brg, R.int(30, 38));
    return [{ name: 'BRAVO', turn, path: [p0, p1, G.project(p1, brg + turn, R.int(30, 38))] }];
  }

  function layCross(R) {
    const brgA = R.int(0, 71) * 5;
    const angle = R.int(12, 24) * 5;                               // 60-120 degrees
    const brgB = G.norm360(brgA + (R.chance(0.5) ? angle : -angle));
    const J = P(0, 0);
    const leg = (brg, L, f) => [G.project(J, brg + 180, f * L), G.project(J, brg, (1 - f) * L)];
    return [
      { name: 'ALPHA', path: leg(brgA, R.int(56, 64), R.range(0.38, 0.62)) },
      { name: 'BRAVO', path: leg(brgB, R.int(56, 64), R.range(0.38, 0.62)), angle },
    ];
  }

  /** Centre the picture on the airspace and size the view to fit it. */
  function frame(corridors) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    corridors.forEach(c => {
      c.width_nm = WIDTH;
      c.path = toArr(c.path);
      G.corridorOutline(c).forEach(p => {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      });
    });
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    corridors.forEach(c => {
      c.path = c.path.map(q => [r2(q[0] - cx), r2(q[1] - cy)]);
      const n = c.path.length;
      c.entry = compass(G.bearing(P(c.path[1][0], c.path[1][1]), P(c.path[0][0], c.path[0][1])));
      c.exit = compass(G.bearing(P(c.path[n - 2][0], c.path[n - 2][1]),
                                 P(c.path[n - 1][0], c.path[n - 1][1])));
    });
    return { x: 0, y: 0, range_nm: Math.ceil(Math.max(x1 - x0, y1 - y0) / 2 + 3) };
  }

  // ------------------------------------------------------------ flying it
  /** One aircraft flown down its own track with its level left alone --
   *  the lateral flying a competent controller provides. Returns where it
   *  is each second from its spawn until it leaves through the far end. */
  function fly(spec, scen, limit) {
    const cor = scen.corridors[spec.corridor || 0];
    const track = trackOf(spec, scen);
    const s0 = spec.s0 != null ? spec.s0 : 2;
    const start = along(track, s0);
    let acc = 0;
    const wps = [];
    for (let i = 1; i < track.length; i++) {
      acc += G.dist(track[i - 1], track[i]);
      if (acc > s0 + 0.01) wps.push(track[i]);
    }
    let x = start.x, y = start.y, hdg = spec.hdg != null ? spec.hdg : start.brg;
    const v = tas(spec.speed, spec.fl * 100) / 3600;
    const xs = [x], ys = [y];
    limit = limit || 3000;
    for (let i = 1; i <= limit; i++) {
      while (wps.length && Math.hypot(wps[0].x - x, wps[0].y - y) < 2) wps.shift();
      if (wps.length) {
        const d = G.angDiff(G.bearing(P(x, y), wps[0]), hdg);
        hdg = G.norm360(hdg + (Math.abs(d) <= 3 ? d : Math.sign(d) * 3));
      }
      x += Math.sin(hdg * G.D2R) * v;
      y += Math.cos(hdg * G.D2R) * v;
      xs.push(x); ys.push(y);
      const pr = G.corridorProject(P(x, y), cor);
      if ((spec.dir || 1) > 0 ? pr.after : pr.before) {
        return { t0: spec.t, xs, ys, exit: spec.t + i, track };
      }
    }
    return { t0: spec.t, xs, ys, exit: null, track };
  }

  function posAt(f, t) {
    const i = t - f.t0;
    if (i < 0 || i >= f.xs.length) return null;
    return P(f.xs[i], f.ys[i]);
  }

  /** Altitude at time t if cleared straight to the exit level on entry. */
  function eagerAlt(spec, t) {
    const a = spec.fl * 100, b = spec.exitFl * 100;
    const moved = ((t - spec.t) / 60) * 2000;
    return a < b ? Math.min(b, a + moved) : Math.max(b, a - moved);
  }

  /** Closest approach while vertically inside the minimum. */
  function encounter(fa, fb, altA, altB) {
    const t1 = Math.max(fa.t0, fb.t0);
    const t2 = Math.min(fa.t0 + fa.xs.length - 1, fb.t0 + fb.xs.length - 1);
    let best = null, first = null, last = null;
    for (let t = t1; t <= t2; t++) {
      if (Math.abs(altA(t) - altB(t)) >= 1000) continue;
      const a = posAt(fa, t), b = posAt(fb, t);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (!best || d < best.d) best = { d, t };
      if (d < 3) { if (first == null) first = t; last = t; }
    }
    return best && { d: best.d, t: best.t, loss: first, until: last };
  }

  // ------------------------------------------------------------- designing
  function levelOf(R) { return R.int(FL_MIN / 10 + 1, FL_MAX / 10 - 1) * 10; }   // 210-320
  function speedOf(R) { return R.int(52, 64) * 5; }                              // 260-320

  /** Set an aircraft's spawn so it is over M at time T -- already part way
   *  down the corridor at the start if it would have to have entered before
   *  the exercise began. */
  function schedule(spec, scen, M, T) {
    const f = fly(Object.assign({}, spec, { t: 0, s0: 2 }), scen);
    let best = Infinity, bi = 0;
    for (let i = 0; i < f.xs.length; i++) {
      const d = Math.hypot(f.xs[i] - M.x, f.ys[i] - M.y);
      if (d < best) { best = d; bi = i; }
    }
    if (best > 6) return false;
    const spawn = T - bi;
    if (spawn >= 0) { spec.t = spawn; spec.s0 = 2; return true; }
    const s0 = 2 + (-spawn) * tas(spec.speed, spec.fl * 100) / 3600;
    if (s0 > 0.5 * lengthOf(f.track)) return false;
    if (f.track.length > 2) {
      const bend = G.dist(f.track[0], f.track[1]);
      if (s0 > bend - 12 && s0 < bend + 3) return false;    // not on the bend at the start
    }
    spec.t = 0; spec.s0 = s0;
    return true;
  }

  function centreline(scen, c) { return toPts(scen.corridors[c].path); }

  let lastFail = '';
  const fail = why => { lastFail = why; return null; };

  /** Two aircraft that meet at time T if nobody does anything. A conflict
   *  pair is at one level. A trap pair is 1,000-2,000 ft apart and one of
   *  them has to finish on the other's level: easy once they have passed,
   *  a loss if it is done the moment it appears. */
  function pair(R, scen, kind, T, trap) {
    const fl = levelOf(R);
    const flB = trap ? fl + R.pick([10, 10, 20]) * (R.chance(0.5) ? 1 : -1) : fl;
    if (flB < FL_MIN + 10 || flB > FL_MAX - 10) return null;
    let A, B, M;
    if (kind === 'cross') {
      A = { corridor: 0, dir: R.chance(0.5) ? 1 : -1, off: R.range(-4, 4), fl, speed: speedOf(R) };
      B = { corridor: 1, dir: R.chance(0.5) ? 1 : -1, off: R.range(-4, 4), fl: flB, speed: speedOf(R) };
      const ta = trackOf(A, scen), tb = trackOf(B, scen);
      M = intersect(ta[0], ta[1], tb[0], tb[1]);
      if (!M) return null;
    } else {
      const c = R.int(0, scen.corridors.length - 1);
      const line = centreline(scen, c), L = lengthOf(line);
      const oA = R.range(-7, 7);
      const oB = Math.max(-8, Math.min(8, oA + R.range(-1.5, 1.5)));
      if (kind === 'headon') {
        A = { corridor: c, dir: 1, off: oA, fl, speed: speedOf(R) };
        B = { corridor: c, dir: -1, off: oB, fl: flB, speed: speedOf(R) };
        M = along(line, R.range(0.3, 0.7) * L);
      } else {                                         // overtake
        const dir = R.chance(0.5) ? 1 : -1, slow = R.int(50, 55) * 5;
        A = { corridor: c, dir, off: oA, fl, speed: slow };
        B = { corridor: c, dir, off: oB, fl: flB, speed: Math.min(330, slow + R.int(8, 12) * 5) };
        const s = R.range(0.62, 0.85) * L;
        M = along(line, dir > 0 ? s : L - s);
      }
    }
    // A few seconds apart, so they never arrive on exactly the same spot.
    if (!schedule(A, scen, M, T) || !schedule(B, scen, M, T + R.int(-5, 5))) return null;
    A.exitFl = A.fl; B.exitFl = B.fl;
    if (trap) {
      if (R.chance(0.5)) A.exitFl = B.fl; else B.exitFl = A.fl;
    }
    return [A, B];
  }

  /** Would a new aircraft get in the way of one already planned: closer
   *  than 5 NM at the same level at any point, or appearing within 5 NM of
   *  it (at any level -- two blips and labels on top of each other)? */
  function crowds(s, f, o, g) {
    const e = encounter(f, g, () => s.fl * 100, () => o.fl * 100);
    if (e && e.d < 5) return true;
    const near = (t, ff, gg) => {
      const p = posAt(ff, t), q = posAt(gg, t);
      return p && q && Math.hypot(p.x - q.x, p.y - q.y) < 5;
    };
    return near(s.t, f, g) || near(o.t, f, g);
  }

  function build(meta, R) {
    const dur = meta.duration_min * 60;
    const corridors = { straight: layStraight, bend: layBend, cross: layCross }[meta.layout](R);
    const scen = {
      id: meta.id, order: meta.order, exercise: meta.exercise, name: meta.name,
      difficulty: meta.difficulty, duration_min: meta.duration_min, summary: meta.summary,
      separation: { lateral_nm: 3, vertical_ft: 1000 },
      corridors,
      traffic: [],
    };
    scen.view = frame(corridors);

    const n = R.int(meta.aircraft[0], meta.aircraft[1]), half = Math.floor(n / 2);
    const K = Math.min(half, R.int(meta.conflicts[0], meta.conflicts[1]));
    const nTraps = Math.max(0, Math.min(half - K, R.int(meta.traps[0], meta.traps[1])));

    const kinds = meta.layout === 'cross'
      ? ['cross', 'cross', 'cross', 'headon', 'overtake']
      : ['headon', 'headon', 'overtake'];
    const events = [];
    for (let i = 0; i < K; i++) events.push({ trap: false });
    for (let i = 0; i < nTraps; i++) events.push({ trap: true });
    R.shuffle(events);

    // The designed pairs, one at a time, each checked against what is
    // already planned and spaced out from the other events.
    const specs = [], flights = [], marks = [];
    const fits = (s, f) => specs.every((o, k) => !crowds(s, f, o, flights[k]));
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      let done = false;
      for (let tries = 0; tries < 30 && !done; tries++) {
        const kind = R.pick(kinds);
        const pr = pair(R, scen, kind, Math.round(R.range(meta.react_s + 40, dur - 300)), ev.trap);
        if (!pr) continue;
        const [A, B] = pr;
        const fA = fly(A, scen), fB = fly(B, scen);
        if (!fA.exit || !fB.exit || fA.exit > dur - 60 || fB.exit > dur - 60) continue;
        const e = encounter(fA, fB, t => eagerAlt(A, t), t => eagerAlt(B, t));
        if (!e || e.loss == null || e.d > 2) continue;
        if (e.loss - Math.max(A.t, B.t) < meta.react_s + 15) continue;
        // Over well before either leaves: an overtake still going on at the
        // exit leaves no room to put them both on their exit levels.
        if (e.until > Math.min(fA.exit, fB.exit) - 150) continue;
        if (marks.some(m => Math.abs(m - e.loss) < meta.conflict_gap_s)) continue;
        if (!fits(A, fA) || !fits(B, fB)) continue;
        if (posAt(fA, B.t) && crowds(B, fB, A, fA) && !ev.trap && kind !== 'overtake') continue;
        A.role = B.role = (ev.trap ? 'trap:' : 'conflict:') + kind;
        A.event = B.event = i;
        specs.push(A, B); flights.push(fA, fB); marks.push(e.loss);
        done = true;
      }
      if (!done) return fail(ev.trap ? 'trap' : 'conflict');
    }

    // Background traffic that does not conflict at its own level.
    const starters = R.int(meta.starters[0], meta.starters[1]);
    while (specs.length < n) {
      let placed = false;
      const wantStarter = specs.filter(s => s.t === 0).length < starters;
      for (let tries = 0; tries < 60 && !placed; tries++) {
        const c = R.int(0, scen.corridors.length - 1);
        const L = lengthOf(centreline(scen, c));
        const s = { corridor: c, dir: R.chance(0.5) ? 1 : -1, off: R.range(-8, 8),
                    fl: levelOf(R), speed: speedOf(R), role: 'background', t: 0, s0: 2 };
        s.exitFl = s.fl;
        if (wantStarter) {
          s.s0 = R.range(6, 0.55 * L);
          // Not sitting on the bend at the start, needing a turn before
          // anyone has had a chance to look at it.
          const tr = trackOf(s, scen);
          if (tr.length > 2) {
            const bend = G.dist(tr[0], tr[1]);
            if (s.s0 > bend - 12 && s.s0 < bend + 3) continue;
          }
        }
        else {
          const transit = fly(s, scen).exit;
          if (!transit || dur - 75 - transit < 20) continue;
          s.t = R.int(20, dur - 75 - transit);
        }
        const f = fly(s, scen);
        if (!f.exit || f.exit > dur - 60 || !fits(s, f)) continue;
        specs.push(s); flights.push(f); placed = true;
      }
      if (!placed) return fail('background');
    }

    // Exit levels: the traps already need changes. Give some other
    // aircraft one too -- sometimes it fixes a conflict, sometimes it
    // walks into one -- until the exercise has its share.
    const want = R.int(meta.level_changes[0], meta.level_changes[1]);
    const order = R.shuffle(specs.filter(s => s.exitFl === s.fl && !s.role.startsWith('trap')));
    for (const s of order) {
      if (specs.filter(x => x.exitFl !== x.fl).length >= want) break;
      const e = s.fl + R.pick([10, 10, 20, 20, 30, 40]) * (R.chance(0.5) ? 1 : -1);
      if (e < FL_MIN || e > FL_MAX) continue;
      s.exitFl = e;
    }

    // Callsigns and types last, so they don't steer anything above.
    const cs = callsigns(R, specs.length);
    specs.forEach((s, i) => {
      s.callsign = cs[i];
      s.type = R.pick(TYPES);
      const f = flights[i];
      const p = along(f.track, s.s0);
      s.x = r2(p.x); s.y = r2(p.y); s.hdg = Math.round(p.brg * 10) / 10;
      s.off = r2(s.off); s.s0 = r2(s.s0); s.t = Math.round(s.t);
    });
    specs.sort((a, b) => a.t - b.t);
    scen.traffic = specs.map(s => ({
      callsign: s.callsign, type: s.type, fl: s.fl, exitFl: s.exitFl, speed: s.speed,
      corridor: s.corridor, dir: s.dir, t: s.t, x: s.x, y: s.y, hdg: s.hdg,
      off: s.off, s0: s.s0, role: s.role, event: s.event,
    }));
    scen.briefing = briefing(meta, scen);
    return scen;
  }

  /** Distinct, unambiguous callsigns: no flight number used twice, and no
   *  airline with one number a prefix of another (AAL45 / AAL451), which is
   *  one dropped word away from the wrong aircraft. */
  function callsigns(R, n) {
    const out = [], nums = new Set();
    let guard = 0;
    while (out.length < n && guard++ < 5000) {
      const al = R.pick(AIRLINES);
      const len = R.pick([1, 2, 2, 3, 3, 3]);
      let d = String(R.int(1, 9));
      for (let i = 1; i < len; i++) d += R.int(0, 9);
      if (nums.has(d)) continue;
      if (out.some(c => c.slice(0, 3) === al &&
          (c.slice(3).startsWith(d) || d.startsWith(c.slice(3))))) continue;
      nums.add(d);
      out.push(al + d);
    }
    return out;
  }

  function briefing(meta, scen) {
    const n = scen.traffic.length;
    const c0 = scen.corridors[0];
    const both = new Set(scen.traffic.map(t => t.dir)).size > 1;
    const ends = c => prose(c.entry) + ' to the ' + prose(c.exit);
    const rules = 'Keep everything inside the walls, keep 1,000 ft or 3 NM between ' +
      'any two aircraft, and hand each one off at the exit flight level shown on its label.';
    if (meta.layout === 'straight') {
      return 'A straight corridor from the ' + ends(c0) + ', ' + n + ' aircraft' +
        (both ? ' in both directions. ' : ', all the same way. ') + rules + ' Press “Ask the assessor” whenever you want a ' +
        'prompt — that is what Exercise 1 is for.';
    }
    if (meta.layout === 'bend') {
      return 'The corridor comes in from the ' + prose(c0.entry) + ' and bends ' +
        (c0.turn > 0 ? 'right' : 'left') + ' by about ' + Math.abs(c0.turn) + '° towards the ' +
        prose(c0.exit) + '. Aircraft fly the heading you give them and nothing else — if ' +
        'you do not turn them at the bend they will leave controlled airspace. ' + n +
        ' aircraft' + (both ? ', both directions,' : '') + ' and several need a level change to reach their exit level.';
    }
    const c1 = scen.corridors[1];
    const ang = c1.angle;
    return 'Two corridors cross ' + (Math.abs(ang - 90) <= 5 ? 'at right angles'
      : 'at about ' + (ang > 90 ? 180 - ang : ang) + '°') + ': ALPHA runs from the ' +
      ends(c0) + ', BRAVO from the ' + ends(c1) + '. ' + n + ' aircraft. Work out early ' +
      'which pairs will be over the crossing together at the same level and fix them ' +
      'while they are still far apart — there is no time to fix them late.';
  }

  // -------------------------------------------------------------- checking
  /** Everything that would make a scenario silly or unfair, checked with
   *  each aircraft flown down its track at its entry level. */
  function assess(scen, meta) {
    const problems = [];
    const dur = scen.duration_min * 60;
    const T = scen.traffic;
    const flights = T.map(s => fly(s, scen));
    const half = WIDTH / 2;

    // Callsigns.
    const re = /^(AAL|DAL|UAL)[1-9]\d{0,2}$/;
    T.forEach(s => { if (!re.test(s.callsign)) problems.push('bad callsign ' + s.callsign); });
    if (new Set(T.map(s => s.callsign.slice(3))).size !== T.length) {
      problems.push('flight number used twice');
    }

    // Placement, levels and getting out on time.
    T.forEach((s, i) => {
      const f = flights[i];
      if (Math.abs(s.off) > half - 3) problems.push(s.callsign + ' too near the wall');
      if (s.fl % 10 || s.exitFl % 10 || s.fl < FL_MIN || s.fl > FL_MAX ||
          s.exitFl < FL_MIN || s.exitFl > FL_MAX) problems.push(s.callsign + ' odd level');
      const cor = scen.corridors[s.corridor];
      if (!G.corridorProject(s, cor).inside) problems.push(s.callsign + ' spawns outside');
      if (!f.exit) { problems.push(s.callsign + ' never leaves'); return; }
      if (f.exit > dur - 60) problems.push(s.callsign + ' still in the sector at the end');
      const need = Math.abs(s.exitFl - s.fl) * 100 / 2000 * 60;
      if (f.exit - s.t < need + 120) problems.push(s.callsign + ' no time for its level change');
    });
    if (problems.length) return { ok: false, problems };

    // Nobody appears on top of anybody else.
    T.forEach((s, i) => {
      const p = posAt(flights[i], s.t);
      T.forEach((o, j) => {
        if (j === i || o.t > s.t) return;
        const q = posAt(flights[j], s.t);
        if (q && Math.hypot(p.x - q.x, p.y - q.y) < 5) {
          problems.push(s.callsign + ' appears within 5 NM of ' + o.callsign);
        }
      });
    });

    // The conflicts that are left if nobody touches a level.
    const conflicts = [], traps = [];
    for (let i = 0; i < T.length; i++) {
      for (let j = i + 1; j < T.length; j++) {
        const a = T[i], b = T[j];
        const e = encounter(flights[i], flights[j], () => a.fl * 100, () => b.fl * 100);
        if (e && e.loss != null) {
          const react = e.loss - Math.max(a.t, b.t);
          conflicts.push({ a: a.callsign, b: b.callsign, d: r2(e.d), t: e.t, loss: e.loss, react });
          if (react < meta.react_s) {
            problems.push(a.callsign + '/' + b.callsign + ' conflict only ' + react +
                          ' s after they appear');
          }
        }
        // ...and the ones that appear if both go straight to their exit level.
        if (a.exitFl !== a.fl || b.exitFl !== b.fl) {
          const x = encounter(flights[i], flights[j], t => eagerAlt(a, t), t => eagerAlt(b, t));
          if (x && x.loss != null && !(e && e.loss != null)) {
            traps.push({ a: a.callsign, b: b.callsign, t: x.loss });
          }
        }
      }
    }
    if (conflicts.length < meta.conflicts[0] || conflicts.length > meta.conflicts[1] + 1) {
      problems.push(conflicts.length + ' conflicts, wanted ' + meta.conflicts.join('-'));
    }
    const losses = conflicts.map(c => c.loss).sort((a, b) => a - b);
    for (let i = 2; i < losses.length; i++) {
      if (losses[i] - losses[i - 2] < 60) problems.push('three conflicts inside a minute');
    }
    const changes = T.filter(s => s.exitFl !== s.fl).length;
    if (changes < meta.level_changes[0] || changes > meta.level_changes[1] + 1) {
      problems.push(changes + ' level changes, wanted ' + meta.level_changes.join('-'));
    }

    // Something to do throughout: no long stretch with an empty scope.
    const lastExit = Math.max.apply(null, flights.map(f => f.exit));
    let empty = 0, worstEmpty = 0, peak = 0;
    for (let t = 0; t <= lastExit; t++) {
      const live = flights.filter(f => f.t0 <= t && f.exit > t).length;
      peak = Math.max(peak, live);
      empty = live ? 0 : empty + 1;
      worstEmpty = Math.max(worstEmpty, empty);
    }
    if (worstEmpty > 60) problems.push('scope empty for ' + worstEmpty + ' s');

    return {
      ok: !problems.length, problems, conflicts, traps, changes, peak,
      lastExit, aircraft: T.length,
    };
  }

  // ------------------------------------------------------- auto-controller
  /**
   * Fly the scenario through the real simulator the way a careful human
   * would: only aircraft on the scope are known about, nothing is touched
   * for its first 15 seconds, and there is at most one transmission every
   * six seconds, each one parsed by the real phraseology checker. Laterally
   * it holds each aircraft on its line and turns it at a bend; vertically it
   * clears aircraft to their exit level when that is safe for the next four
   * minutes, and moves one of a pair 1,000 ft or so when a conflict is three
   * minutes away. Returns the transmissions, which replay to the same result.
   */
  function solve(scen, opts) {
    opts = opts || {};
    const S = ATC.speech;
    const GAP = opts.gap || 6, LAG = opts.lag || 15, H = 240, DT = 3, THR = 4.5;
    const sim = new ATC.Sim(scen);
    sim.paused = false;
    const tracks = {}, cum = {};
    scen.traffic.forEach(s => {
      const tr = trackOf(s, scen);
      tracks[s.callsign] = tr;
      const c = [0];
      for (let i = 1; i < tr.length; i++) c.push(c[i - 1] + G.dist(tr[i - 1], tr[i]));
      cum[s.callsign] = c;
    });
    const trackCor = {};
    Object.keys(tracks).forEach(k => {
      trackCor[k] = { path: tracks[k].map(p => [p.x, p.y]), width_nm: 999 };
    });
    const script = [], problems = [], correcting = {};
    let lastTx = -1e9;

    function tx(ac, text) {
      const r = S.parse(text, sim);
      if (!r.ok || !r.action || r.ac !== ac || r.notes.length) {
        problems.push('phraseology: "' + text + '" ' + (r.error || r.notes.join('; ')));
        return false;
      }
      if (r.action.kind === 'turn') ac.cmdHeading(r.action.hdg, r.action.dir);
      else ac.cmdLevel(r.action.fl);
      script.push([Math.round(sim.t), text]);
      lastTx = sim.t;
      return true;
    }
    const turnText = (ac, h) => ac.spoken() + ', turn ' +
      (ac.shorterTurn(h) === 'L' ? 'left' : 'right') + ' heading ' + S.heading(h);
    const levelText = (ac, fl) => ac.spoken() + ', ' +
      (fl * 100 > ac.alt ? 'climb' : 'descend') + ' to ' + S.flSpoken(fl);

    /** The heading this aircraft should be on now, or null if it is fine. */
    function lateral(ac) {
      const cs = ac.callsign, tr = tracks[cs];
      const pr = G.corridorProject(ac, trackCor[cs]);
      let want = pr.brg;
      if (pr.seg < tr.length - 2) {
        const next = G.bearing(tr[pr.seg + 1], tr[pr.seg + 2]);
        const turn = Math.abs(G.angDiff(next, pr.brg));
        const radius = (ac.tas / 3600) * 120 / (2 * Math.PI);
        const lead = radius * Math.tan((turn / 2) * G.D2R) + 0.6;
        if (cum[cs][pr.seg + 1] - pr.s < lead) want = next;
      }
      if (Math.abs(pr.offset) > 1.5 || (correcting[cs] && Math.abs(pr.offset) > 0.4)) {
        correcting[cs] = true;
        want -= Math.sign(pr.offset) * 15;
      } else correcting[cs] = false;
      const h = (Math.round(G.norm360(want) / 5) * 5) % 360 || 360;
      return Math.abs(G.angDiff(h, ac.hdgCmd)) >= 4 ? h : null;
    }

    function snapshot() {
      return sim.aircraft.filter(a => a.state === 'active').map(ac => {
        const cs = ac.callsign, pr = G.corridorProject(ac, trackCor[cs]);
        return { cs, x: ac.x, y: ac.y, hdg: ac.hdg, alt: ac.alt, altCmd: ac.altCmd,
                 ias: ac.ias, wps: tracks[cs].slice(pr.seg + 1),
                 left: cum[cs][cum[cs].length - 1] - pr.s + 1 };
      });
    }

    /** Conflicts in the next H seconds if everyone is kept on their line,
     *  with one optional change of cleared level. */
    function predict(snap, change) {
      const cl = snap.map(o => ({
        cs: o.cs, x: o.x, y: o.y, hdg: o.hdg, alt: o.alt, ias: o.ias, left: o.left,
        altCmd: change && change.cs === o.cs ? change.fl * 100 : o.altCmd,
        wps: o.wps.slice(), done: false,
      }));
      const out = [], seen = new Set();
      for (let t = DT; t <= H; t += DT) {
        cl.forEach(c => {
          if (c.done) return;
          while (c.wps.length > 1 && Math.hypot(c.wps[0].x - c.x, c.wps[0].y - c.y) < 2) {
            c.wps.shift();
          }
          const d = G.angDiff(G.bearing(c, c.wps[0]), c.hdg);
          const m = 3 * DT;
          c.hdg = G.norm360(c.hdg + (Math.abs(d) <= m ? d : Math.sign(d) * m));
          const da = c.altCmd - c.alt, m2 = 2000 / 60 * DT;
          c.alt += Math.abs(da) <= m2 ? da : Math.sign(da) * m2;
          const nm = tas(c.ias, c.alt) / 3600 * DT;
          c.x += Math.sin(c.hdg * G.D2R) * nm;
          c.y += Math.cos(c.hdg * G.D2R) * nm;
          c.left -= nm;
          if (c.left < 0) c.done = true;
        });
        for (let i = 0; i < cl.length; i++) {
          if (cl[i].done) continue;
          for (let j = i + 1; j < cl.length; j++) {
            const a = cl[i], b = cl[j];
            if (b.done || Math.abs(a.alt - b.alt) >= 1000) continue;
            if (Math.hypot(a.x - b.x, a.y - b.y) >= THR) continue;
            const key = a.cs + '|' + b.cs;
            if (!seen.has(key)) { seen.add(key); out.push({ a: a.cs, b: b.cs, t }); }
          }
        }
      }
      return out;
    }
    const involves = (k, cs) => k.a === cs || k.b === cs;

    function resolve(k, snap, ready) {
      const opts2 = [];
      [k.a, k.b].forEach(cs => {
        const ac = ready.find(a => a.callsign === cs);
        if (!ac) return;
        const now = ac.clearedFl;
        const lv = [ac.exitFL, now + 10, now - 10, now + 20, now - 20, now + 30, now - 30];
        lv.forEach(fl => {
          if (fl === now || fl < SOLVE_MIN || fl > SOLVE_MAX) return;
          if (Math.abs(fl * 100 - ac.alt) < 100) return;
          let cost = Math.abs(fl - now) / 10;
          if (fl === ac.exitFL) cost -= 1.5;
          else if (Math.abs(fl - ac.exitFL) > Math.abs(now - ac.exitFL)) cost += 0.5;
          opts2.push({ ac, fl, cost });
        });
      });
      opts2.sort((a, b) => a.cost - b.cost);
      for (const o of opts2) {
        const p = predict(snap, { cs: o.ac.callsign, fl: o.fl });
        if (!p.some(x => involves(x, o.ac.callsign))) return o;
      }
      return null;
    }

    function decide() {
      const ready = sim.aircraft.filter(a => a.state === 'active' && sim.t - a.entryTime >= LAG);
      for (const ac of ready) {
        const h = lateral(ac);
        if (h != null) { tx(ac, turnText(ac, h)); return; }
      }
      const snap = snapshot();
      const base = predict(snap);
      const urgent = base.filter(k => k.t <= 180).sort((a, b) => a.t - b.t);
      for (const k of urgent) {
        const o = resolve(k, snap, ready);
        if (o) { tx(o.ac, levelText(o.ac, o.fl)); return; }
      }
      const pending = ready.filter(a => a.clearedFl !== a.exitFL);
      for (const ac of pending) {
        if (Math.abs(ac.exitFL * 100 - ac.alt) < 100 && ac.clearedFl === ac.exitFL) continue;
        const p = predict(snap, { cs: ac.callsign, fl: ac.exitFL });
        if (!p.some(x => involves(x, ac.callsign))) { tx(ac, levelText(ac, ac.exitFL)); return; }
      }
    }

    const dur = scen.duration_min * 60;
    while (!sim.finished && sim.t < dur) {
      if (sim.t - lastTx >= GAP) decide();
      sim.step(1);
    }
    const n = scen.traffic.length;
    const result = {
      losses: sim.losses, handled: sim.handled, correct: sim.correct,
      excursions: sim.excursions, faults: sim.faults, score: Math.round(sim.score),
      closest: isFinite(sim.closestCall) ? r2(sim.closestCall) : null,
      t: Math.round(sim.t),
    };
    if (result.losses) problems.push(result.losses + ' losses');
    if (result.handled !== n) problems.push((n - result.handled) + ' never left');
    if (result.correct !== n) problems.push((result.handled - result.correct) + ' wrong exits');
    if (result.excursions) problems.push(result.excursions + ' excursions');
    return { ok: !problems.length, problems, script, result };
  }

  // --------------------------------------------------------------- the lot
  /** A finished, vetted scenario for this exercise from this seed: tries
   *  candidates until one passes every check and flies clean. */
  function make(meta, seed, opts) {
    opts = opts || {};
    const tries = opts.tries || 80;
    const why = {};
    for (let k = 0; k < tries; k++) {
      const R = Rng(mix(seed, k));
      const scen = build(meta, R);
      if (!scen) { why['build ' + lastFail] = (why['build ' + lastFail] || 0) + 1; continue; }
      const a = assess(scen, meta);
      if (!a.ok) { a.problems.forEach(p => { const w = p.replace(/[A-Z]{3}\d+/g, 'X').replace(/\d+/g, 'n'); why[w] = (why[w] || 0) + 1; }); continue; }
      const s = solve(scen);
      if (!s.ok) { why['solver: ' + s.problems[0].replace(/\d+/g, 'n')] = (why['solver: ' + s.problems[0].replace(/\d+/g, 'n')] || 0) + 1; continue; }
      scen.seed = seed;
      return { scen, assess: a, solve: s, attempts: k + 1, why };
    }
    return { scen: null, attempts: tries, why };
  }

  ATC.gen = { Rng, mix, build, assess, solve, make, fly, trackOf, offsetTrack, along };
})(window.ATC = window.ATC || {});
