#!/usr/bin/env python3
"""Contact sheet: a grid of scenarios drawn as maps, for eyeballing.

Each panel shows the corridors, every aircraft's track (thin, from where it
appears to where it leaves), where the designed conflicts happen if nobody
touches a level (red) and where the level-change traps are (amber), with a
line of stats underneath. Drawn by the real generator code in headless
Chromium and saved as a PNG.

    .venv/bin/python tools/sheet.py pool ex2 out.png         # the vetted pool
    .venv/bin/python tools/sheet.py seeds ex3 out.png 1 24   # fresh, seeds 1-24

Needs the app running locally (ATC_URL, default http://127.0.0.1:5055).
"""
import glob
import json
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "tests"))
from chrome import Chrome  # noqa: E402

URL = os.environ.get("ATC_URL", "http://127.0.0.1:5055")
JS = ["geo.js", "speech.js", "aircraft.js", "sim.js", "gen.js"]

DRAW = r"""
(function (list, meta) {
  const G = ATC.geo, gen = ATC.gen;
  const COLS = ['#4dffb0', '#7fb2ff', '#ffd27f', '#ff9de2'];
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#04120c;color:#9dffd4;' +
    'font:11px ui-monospace,monospace;display:flex;flex-wrap:wrap;gap:6px;padding:6px;width:1888px';
  const mm = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.round(s % 60)).padStart(2, '0');
  list.forEach(item => {
    const scen = item.scen;
    const a = gen.assess(scen, meta);
    const S = 300, R = scen.view.range_nm;
    const X = p => (S / 2 + (p.x - scen.view.x) * S / (2 * R)).toFixed(1);
    const Y = p => (S / 2 - (p.y - scen.view.y) * S / (2 * R)).toFixed(1);
    let svg = '';
    scen.corridors.forEach(c => {
      const o = G.corridorOutline(c);
      svg += '<polygon points="' + o.map(p => X(p) + ',' + Y(p)).join(' ') +
        '" fill="rgba(45,120,85,0.18)" stroke="#39805c"/>';
      const n = c.path.length;
      svg += '<text x="' + X({x: c.path[0][0], y: c.path[0][1]}) + '" y="' +
        Y({x: c.path[0][0], y: c.path[0][1]}) + '" fill="#6fbf96" font-size="9">' + c.entry + '</text>';
      svg += '<text x="' + X({x: c.path[n-1][0], y: c.path[n-1][1]}) + '" y="' +
        Y({x: c.path[n-1][0], y: c.path[n-1][1]}) + '" fill="#6fbf96" font-size="9">' + c.exit + '</text>';
    });
    const fl = {};
    scen.traffic.forEach((s, i) => {
      const f = gen.fly(s, scen);
      fl[s.callsign] = f;
      const col = COLS[(s.corridor || 0) * 2 + (s.dir > 0 ? 0 : 1)];
      let d = '';
      for (let k = 0; k < f.xs.length; k += 10) d += (k ? 'L' : 'M') + X({x: f.xs[k], y: f.ys[k]}) + ' ' + Y({x: f.xs[k], y: f.ys[k]});
      svg += '<path d="' + d + '" stroke="' + col + '" stroke-width="0.7" fill="none" opacity="0.6"/>';
      svg += '<circle cx="' + X(s) + '" cy="' + Y(s) + '" r="2.2" fill="' + col + '"/>';
      svg += '<text x="' + (+X(s) + 3) + '" y="' + (+Y(s) - 2) + '" fill="' + col + '" font-size="7.5">' +
        s.callsign + ' ' + s.fl + (s.exitFl !== s.fl ? '>' + s.exitFl : '') + ' ' + mm(s.t) + '</text>';
    });
    const mark = (k, col) => {
      const fa = fl[k.a], fb = fl[k.b], t = k.loss != null ? k.loss : k.t;
      const pa = {x: fa.xs[t - fa.t0], y: fa.ys[t - fa.t0]};
      const pb = {x: fb.xs[t - fb.t0], y: fb.ys[t - fb.t0]};
      if (pa.x == null || pb.x == null) return;
      const p = {x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2};
      svg += '<circle cx="' + X(p) + '" cy="' + Y(p) + '" r="6" fill="none" stroke="' + col + '" stroke-width="1.5"/>';
      svg += '<text x="' + (+X(p) + 7) + '" y="' + (+Y(p) + 10) + '" fill="' + col + '" font-size="8">' + mm(t) + '</text>';
    };
    (a.conflicts || []).forEach(k => mark(k, '#ff4d4d'));
    (a.traps || []).forEach(k => mark(k, '#ffc233'));
    const st = item.stats || {};
    const div = document.createElement('div');
    div.style.cssText = 'width:300px;border:1px solid #1e2b24';
    div.innerHTML = '<svg width="300" height="300" style="display:block">' + svg + '</svg>' +
      '<div style="padding:3px 5px;line-height:1.35">' + item.label + ' · ' + scen.traffic.length + ' ac · ' +
      (a.conflicts || []).length + ' conf · ' + (a.traps || []).length + ' traps · ' + a.changes + ' lvl<br>' +
      'peak ' + a.peak + ' · calls ' + (st.calls != null ? st.calls : '?') + ' · closest ' +
      (st.closest != null ? st.closest : '?') + ' · last out ' + mm(a.lastExit) +
      (a.ok ? '' : '<br><span style="color:#ff4d4d">' + a.problems.join('; ') + '</span>') + '</div>';
    document.body.appendChild(div);
  });
  return document.body.scrollHeight;
})(LIST, META)
"""


def main():
    mode, eid, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(os.path.join(BASE, "scenarios/exercises.json"), encoding="utf-8") as fh:
        meta = json.load(fh)[eid]
    meta["id"] = eid
    c = Chrome(width=1900, height=1000)
    try:
        c.goto(URL + "/static/css/style.css", wait=0.1)
        c.eval("window.ATC = {}")
        for f in JS:
            with open(os.path.join(BASE, "static/js", f), encoding="utf-8") as fh:
                c.eval(fh.read())
        if mode == "pool":
            items = []
            for p in sorted(glob.glob(os.path.join(BASE, "scenarios", eid, "*.json"))):
                with open(p, encoding="utf-8") as fh:
                    s = json.load(fh)
                sv = s.get("stats", {}).get("solver", {})
                items.append({"scen": s, "label": "#" + s["variant"],
                              "stats": {"calls": len(s.get("solution", [])),
                                        "closest": sv.get("closest")}})
            list_js = json.dumps(items)
        else:
            a, b = int(sys.argv[4]), int(sys.argv[5])
            list_js = ("(function(){var o=[];for(var s=%d;s<=%d;s++){var r=ATC.gen.make(%s,s);"
                       "if(r.scen)o.push({scen:r.scen,label:'seed '+s+' ('+r.attempts+')',"
                       "stats:{calls:r.solve.script.length,closest:r.solve.result.closest}});}"
                       "return o;})()" % (a, b, json.dumps(meta)))
        h = c.eval(DRAW.replace("LIST", list_js).replace("META", json.dumps(meta)))
        c.call("Emulation.setDeviceMetricsOverride", width=1900, height=int(h) + 10,
               deviceScaleFactor=1, mobile=False)
        c.screenshot(out)
        print("wrote", out, "errors:", c.errors)
    finally:
        c.close()


if __name__ == "__main__":
    main()
