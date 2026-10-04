/* Radar display: corridor of controlled airspace, RPIs, leader lines,
 * history dots and labels. Reads sim state, never mutates it. */
(function (ATC) {
  'use strict';
  const G = ATC.geo;

  const COL = {
    bg: '#04120c', grid: '#0f2418', wall: '#39805c', fill: 'rgba(45,120,85,0.10)',
    gate: '#6fbf96',
    ac: '#4dffb0', acSel: '#ffffff', acAlert: '#ffc233', acLoss: '#ff4d4d',
    acOut: '#ff8a3d', label: '#9dffd4', dim: '#5f8a76', hist: '#2a8a60',
  };

  class Radar {
    constructor(canvas, sim) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.sim = sim;
      const v = sim.scen.view || {};
      this.centre = { x: v.x || 0, y: v.y || 0 };
      this.range = v.range_nm || 90;
      this.showVectors = true;
      this.showRings = false;
      this.resize();
      const onResize = () => this.resize();
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      // Mobile browsers slide their toolbars in and out, which changes the
      // visible viewport without always firing window resize.
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
      }
      this.bindPointer();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.cv.getBoundingClientRect();
      this.cv.width = Math.max(1, Math.round(r.width * dpr));
      this.cv.height = Math.max(1, Math.round(r.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = r.width; this.h = r.height;
    }

    get scale() { return Math.min(this.w, this.h) / (this.range * 2); }

    toScreen(p) {
      const s = this.scale;
      return { x: this.w / 2 + (p.x - this.centre.x) * s,
               y: this.h / 2 - (p.y - this.centre.y) * s };
    }

    /**
     * Pointer Events, not separate mouse/touch handling: one finger (or the
     * mouse) drags to pan and taps to select, same as before, and a second
     * finger down turns it into a pinch that zooms instead -- there is no
     * mouse equivalent of a second finger, so this was simply never
     * reachable on a touchscreen before.
     */
    bindPointer() {
      const pointers = new Map();   // pointerId -> last known {x, y}, canvas-local
      let drag = null;              // one pointer down: {x, y, moved, c}
      let pinch = null;             // two pointers down: {dist, range}

      const localXY = e => {
        const r = this.cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      const pinchDist = () => {
        const pts = Array.from(pointers.values());
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      };

      this.cv.addEventListener('pointerdown', e => {
        if (this.cv.setPointerCapture) {
          try { this.cv.setPointerCapture(e.pointerId); } catch (_) {}
        }
        pointers.set(e.pointerId, localXY(e));
        if (pointers.size === 1) {
          const p = localXY(e);
          drag = { x: p.x, y: p.y, moved: false, c: Object.assign({}, this.centre) };
          pinch = null;
        } else if (pointers.size === 2) {
          drag = null;   // a second finger landing means this is a pinch, not a pan
          pinch = { dist: pinchDist(), range: this.range };
        }
      });

      this.cv.addEventListener('pointermove', e => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, localXY(e));

        if (pointers.size >= 2 && pinch) {
          const d = pinchDist();
          // Fingers spreading apart shrinks the visible range -- zooming in,
          // same sense as scrolling up does for the wheel below.
          if (d > 0) this.range = Math.max(10, Math.min(300, pinch.range * (pinch.dist / d)));
          return;
        }
        if (pointers.size === 1 && drag) {
          const p = pointers.get(e.pointerId);
          const dx = p.x - drag.x, dy = p.y - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
          this.centre.x = drag.c.x - dx / this.scale;
          this.centre.y = drag.c.y + dy / this.scale;
          return;
        }
        // Nothing down: a mouse hovering (touch has no such thing) --
        // just update the cursor.
        const p = localXY(e);
        if (p.x >= 0 && p.y >= 0 && p.x <= this.w && p.y <= this.h) {
          this.cv.style.cursor = this.pick(p.x, p.y) ? 'pointer' : 'crosshair';
        }
      });

      const release = e => {
        if (pointers.size === 1 && drag && !drag.moved) {
          const p = localXY(e);
          const hit = this.pick(p.x, p.y);
          if (this.onPick) this.onPick(hit);
        }
        pointers.delete(e.pointerId);
        if (pointers.size === 1) {
          // One finger lifted out of a pinch -- start panning fresh from
          // here instead of jumping using the two-finger baseline.
          const [remaining] = pointers.values();
          drag = { x: remaining.x, y: remaining.y, moved: false, c: Object.assign({}, this.centre) };
          pinch = null;
        } else if (pointers.size === 0) {
          drag = null;
          pinch = null;
        }
      };
      this.cv.addEventListener('pointerup', release);
      this.cv.addEventListener('pointercancel', release);

      this.cv.addEventListener('wheel', e => {
        e.preventDefault();
        this.range = Math.max(10, Math.min(300, this.range * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
      }, { passive: false });
    }

    pick(px, py) {
      let best = null, bestD = 20;
      this.sim.aircraft.forEach(a => {
        if (a.state !== 'active') return;
        const s = this.toScreen(a);
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < bestD) { bestD = d; best = a; }
      });
      return best;
    }

    // ------------------------------------------------------------ drawing
    draw() {
      const c = this.ctx;
      c.fillStyle = COL.bg;
      c.fillRect(0, 0, this.w, this.h);
      if (this.showRings) this.drawRings();
      this.sim.corridors.forEach(cor => this.drawCorridor(cor));
      this.drawScaleBar();
      this.drawConflictLines();
      this.sim.aircraft.forEach(a => { if (a.state === 'active') this.drawAircraft(a); });
    }

    drawRings() {
      const c = this.ctx, o = this.toScreen({ x: 0, y: 0 });
      c.strokeStyle = COL.grid; c.lineWidth = 1;
      for (let r = 10; r <= 200; r += 10) {
        const pr = r * this.scale;
        if (pr < 15 || pr > Math.hypot(this.w, this.h)) continue;
        c.beginPath(); c.arc(o.x, o.y, pr, 0, Math.PI * 2); c.stroke();
      }
    }

    drawCorridor(cor) {
      const c = this.ctx;
      const poly = G.corridorOutline(cor).map(p => this.toScreen(p));
      c.beginPath();
      poly.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.fillStyle = COL.fill; c.fill();
      c.strokeStyle = COL.wall; c.lineWidth = 1.6; c.stroke();

      // Centreline.
      c.strokeStyle = COL.grid; c.lineWidth = 1; c.setLineDash([6, 8]);
      c.beginPath();
      cor.path.forEach((p, i) => {
        const s = this.toScreen({ x: p[0], y: p[1] });
        i ? c.lineTo(s.x, s.y) : c.moveTo(s.x, s.y);
      });
      c.stroke(); c.setLineDash([]);

      // Entry / exit gates.
      c.font = '11px ui-monospace, Menlo, Consolas, monospace';
      const ends = [
        { p: cor.path[0], label: cor.entry || 'ENTRY',
          brg: G.bearing({ x: cor.path[0][0], y: cor.path[0][1] },
                         { x: cor.path[1][0], y: cor.path[1][1] }) },
        { p: cor.path[cor.path.length - 1], label: cor.exit || 'EXIT',
          brg: G.bearing({ x: cor.path[cor.path.length - 2][0],
                           y: cor.path[cor.path.length - 2][1] },
                         { x: cor.path[cor.path.length - 1][0],
                           y: cor.path[cor.path.length - 1][1] }) },
      ];
      ends.forEach(e => {
        const p = { x: e.p[0], y: e.p[1] };
        const a = this.toScreen(G.project(p, e.brg - 90, cor.width_nm / 2));
        const b = this.toScreen(G.project(p, e.brg + 90, cor.width_nm / 2));
        c.strokeStyle = COL.gate; c.lineWidth = 2;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        const s = this.toScreen(p);

        // An aircraft's own label sits just up and right of its dot, and
        // lands right on top of this exact text when it's near the gate --
        // most obviously right as it is about to leave through it, which
        // on a small screen is often exactly when this would otherwise
        // print two labels stacked illegibly on each other. Keep the gate
        // line (still useful) but skip the word once that happens.
        const crowded = this.sim.aircraft.some(ac => ac.state === 'active' &&
          Math.hypot(this.toScreen(ac).x - s.x, this.toScreen(ac).y - s.y) < 45);
        if (crowded) return;

        c.fillStyle = COL.gate;
        c.fillText(e.label, s.x - c.measureText(e.label).width / 2, s.y - 8);
      });
    }

    drawScaleBar() {
      const c = this.ctx;
      const nm = this.sim.sepLat;              // draw the separation minimum
      const px = nm * this.scale;
      const x = 16, y = this.h - 20;
      c.strokeStyle = COL.dim; c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y - 4); c.lineTo(x, y + 4);
      c.moveTo(x, y); c.lineTo(x + px, y);
      c.moveTo(x + px, y - 4); c.lineTo(x + px, y + 4);
      c.stroke();
      c.fillStyle = COL.dim;
      c.font = '11px ui-monospace, monospace';
      c.fillText(nm + ' NM', x + px + 8, y + 4);
    }

    drawConflictLines() {
      const c = this.ctx;
      this.sim.conflicts.forEach(k => {
        const a = this.toScreen(k.a), b = this.toScreen(k.b);
        c.strokeStyle = k.kind === 'loss' ? COL.acLoss : COL.acAlert;
        c.lineWidth = 1; c.setLineDash(k.kind === 'loss' ? [] : [3, 4]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        c.setLineDash([]);
        c.fillStyle = k.kind === 'loss' ? COL.acLoss : COL.acAlert;
        c.font = '10px ui-monospace, monospace';
        c.fillText(k.d.toFixed(1), (a.x + b.x) / 2 + 4, (a.y + b.y) / 2 - 4);
      });
    }

    drawAircraft(a) {
      const c = this.ctx, s = this.toScreen(a);
      const col = a.conflict ? COL.acLoss : a.selected ? COL.acSel
        : a.alert ? COL.acAlert : a.outside ? COL.acOut : COL.ac;

      // History dots — where it has come from.
      a.history.forEach((h, i) => {
        const hs = this.toScreen(h);
        c.globalAlpha = 0.2 + i * 0.12;
        c.fillStyle = COL.hist;
        c.fillRect(hs.x - 1.5, hs.y - 1.5, 3, 3);
      });
      c.globalAlpha = 1;

      // Leader line: where it will be in one minute. Length tracks speed.
      if (this.showVectors) {
        const ahead = G.project(a, a.hdg, a.gs / 60);
        const sa = this.toScreen(ahead);
        c.strokeStyle = col; c.lineWidth = 1;
        c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(sa.x, sa.y); c.stroke();
      }

      // RPI.
      c.strokeStyle = col; c.lineWidth = 1.8;
      c.beginPath(); c.arc(s.x, s.y, 3.5, 0, Math.PI * 2); c.stroke();

      if (a.selected) {
        const r = this.sim.sepLat * this.scale;
        c.strokeStyle = 'rgba(255,255,255,0.25)';
        c.setLineDash([2, 4]); c.lineWidth = 1;
        c.beginPath(); c.arc(s.x, s.y, r, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }

      this.drawLabel(a, s, col);
    }

    /* Label, per the assessment's description:
     *   AAL451
     *   080 > 200        current FL, cleared FL
     *   220   251        exit FL, speed                                     */
    drawLabel(a, s, col) {
      const c = this.ctx;
      const pad = n => String(n).padStart(3, '0');
      const arrow = a.vs > 50 ? '↑' : a.vs < -50 ? '↓' : '·';
      const x = s.x + 12, y = s.y - 16;

      c.font = '11px ui-monospace, Menlo, Consolas, monospace';
      c.textBaseline = 'middle';
      c.strokeStyle = col; c.globalAlpha = 0.45; c.lineWidth = 1;
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(x - 2, y + 14); c.stroke();
      c.globalAlpha = 1;

      if (a.selected) {
        c.fillStyle = 'rgba(255,255,255,0.10)';
        c.fillRect(x - 4, y - 8, 88, 42);
      }

      c.fillStyle = a.conflict ? COL.acLoss : a.alert ? COL.acAlert
        : a.outside ? COL.acOut : COL.label;
      c.fillText(a.callsign, x, y);

      // Row 2: current level, then cleared level.
      c.fillStyle = COL.label;
      c.fillText(pad(a.fl), x, y + 13);
      c.fillStyle = a.clearedFl !== a.fl ? COL.acAlert : COL.dim;
      c.fillText(arrow + ' ' + pad(a.clearedFl), x + 26, y + 13);

      // Row 3: exit level (the target) and speed.
      c.fillStyle = a.fl === a.exitFL ? COL.ac : COL.acAlert;
      c.fillText(pad(a.exitFL), x, y + 26);
      c.fillStyle = COL.dim;
      c.fillText(Math.round(a.ias), x + 40, y + 26);

      c.textBaseline = 'alphabetic';
    }
  }

  ATC.Radar = Radar;
  ATC.COL = COL;
})(window.ATC = window.ATC || {});
