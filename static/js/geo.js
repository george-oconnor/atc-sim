/* Flat-earth navigation maths.
 * The sector is small (<150 NM) so we work on a plane in nautical miles:
 * x = east, y = north. Bearings are degrees true, 0 = north, clockwise. */
(function (ATC) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function bearing(from, to) {
    return (Math.atan2(to.x - from.x, to.y - from.y) * R2D + 360) % 360;
  }

  /** Shortest signed turn from `cur` to `tgt`, in (-180, 180]. */
  function angDiff(tgt, cur) {
    return ((tgt - cur + 540) % 360) - 180;
  }

  function norm360(a) { return ((a % 360) + 360) % 360; }

  /** Move `nm` along `brg` from a point. */
  function project(p, brg, nm) {
    return { x: p.x + Math.sin(brg * D2R) * nm, y: p.y + Math.cos(brg * D2R) * nm };
  }



  function fmtHdg(h) { return String(Math.round(norm360(h)) || 360).padStart(3, '0'); }

  ATC.geo = { D2R, R2D, dist, bearing, angDiff, norm360, project, fmtHdg };
})(window.ATC = window.ATC || {});

/* Corridor geometry: controlled airspace is a "tube" — a centreline polyline
 * with a fixed width and unlimited vertical extent. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  /** Closest point on segment ab to p, plus the along-track distance. */
  function projectOnSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    const tc = Math.max(0, Math.min(1, t));
    const cx = a.x + vx * tc, cy = a.y + vy * tc;
    return { t, tc, x: cx, y: cy, d: Math.hypot(p.x - cx, p.y - cy),
             len: Math.sqrt(len2) };
  }

  /** Where is p relative to a corridor? Returns along-track distance `s`
   *  (negative = before the start, > length = past the end), signed lateral
   *  offset from the centreline, and the local centreline bearing. */
  function corridorProject(p, cor) {
    const pts = cor.path.map(q => ({ x: q[0], y: q[1] }));
    let best = null, acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const pr = projectOnSeg(p, pts[i], pts[i + 1]);
      const cand = {
        d: pr.d, s: acc + pr.tc * pr.len, raw: acc + pr.t * pr.len,
        seg: i, brg: G.bearing(pts[i], pts[i + 1]),
        a: pts[i], b: pts[i + 1], t: pr.t,
      };
      if (!best || pr.d < best.d) best = cand;
      acc += pr.len;
    }
    best.total = acc;
    // Signed offset: positive = right of the direction of travel.
    const brgToP = G.bearing(best.a, p);
    best.side = Math.sign(G.angDiff(brgToP, best.brg)) || 1;
    best.offset = best.d * best.side;
    // Past either end?
    best.before = best.seg === 0 && best.t < 0;
    best.after = best.seg === pts.length - 2 && best.t > 1;
    best.inside = !best.before && !best.after && best.d <= cor.width_nm / 2;
    return best;
  }

  /** Outline polygon of a corridor, for drawing. */
  function corridorOutline(cor) {
    const pts = cor.path.map(q => ({ x: q[0], y: q[1] }));
    const h = cor.width_nm / 2;
    const left = [], right = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[i - 1], next = pts[i + 1];
      let brg;
      if (!prev) brg = G.bearing(pts[i], next);
      else if (!next) brg = G.bearing(prev, pts[i]);
      else {
        // Bisect the two segment bearings so the walls meet cleanly at a bend.
        const b1 = G.bearing(prev, pts[i]), b2 = G.bearing(pts[i], next);
        brg = G.norm360(b1 + G.angDiff(b2, b1) / 2);
      }
      // Widen the wall at a bend so the corridor keeps its nominal width.
      let scale = 1;
      if (prev && next) {
        const turn = Math.abs(G.angDiff(G.bearing(pts[i], next), G.bearing(prev, pts[i])));
        scale = 1 / Math.max(0.35, Math.cos((turn / 2) * G.D2R));
      }
      left.push(G.project(pts[i], brg - 90, h * scale));
      right.push(G.project(pts[i], brg + 90, h * scale));
    }
    return left.concat(right.reverse());
  }

  G.projectOnSeg = projectOnSeg;
  G.corridorProject = corridorProject;
  G.corridorOutline = corridorOutline;
})(window.ATC = window.ATC || {});
