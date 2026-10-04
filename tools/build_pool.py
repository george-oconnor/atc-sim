#!/usr/bin/env python3
"""Build the vetted scenario pool for each exercise.

Runs the real generator (static/js/gen.js) over a range of seeds. Each
candidate has already been checked for anything silly and flown clean by
the auto-controller before make() hands it back; this keeps the ones that
also leave a decent margin, then picks a set that is spread across
orientations, shapes and traffic counts, so two scenarios in a row rarely
look alike.

    .venv/bin/python tools/build_pool.py            # all three, 25 each
    .venv/bin/python tools/build_pool.py ex2 30     # one exercise, 30

Writes scenarios/<exercise>/<NN>.json, replacing what was there. Each file
carries the auto-controller's transmissions as `solution`; the tests replay
them through the simulator, and the server strips them before the page.
"""
import glob
import json
import os
import sys
import time

import dukpy

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCEN = os.path.join(BASE, "scenarios")
JS = ["geo.js", "speech.js", "aircraft.js", "sim.js", "gen.js"]


def lib():
    src = ["var window = {}; var console = {log: function(){}, warn: function(){}};"]
    for f in JS:
        with open(os.path.join(BASE, "static/js", f), encoding="utf-8") as fh:
            src.append(fh.read())
    return "\n;\n".join(src)


def exercises():
    with open(os.path.join(SCEN, "exercises.json"), encoding="utf-8") as fh:
        ex = json.load(fh)
    for k, v in ex.items():
        v["id"] = k
    return ex


MAKE = """
var r = window.ATC.gen.make(META, SEED, {tries: 60});
r.scen ? {scen: r.scen, script: r.solve.script, result: r.solve.result,
          conflicts: r.assess.conflicts.length, traps: r.assess.traps.length,
          changes: r.assess.changes, peak: r.assess.peak} : null;
"""


def candidates(meta, seeds, js):
    out = []
    for seed in seeds:
        r = dukpy.evaljs([js, "var META = %s, SEED = %d;" % (json.dumps(meta), seed), MAKE])
        if r:
            out.append(r)
    return out


def key_bearing(scen):
    p = scen["corridors"][0]["path"]
    import math
    return math.degrees(math.atan2(p[1][0] - p[0][0], p[1][1] - p[0][1])) % 360


def pick(cands, n):
    """Round-robin over 30-degree orientation buckets, so the pool is spread
    round the compass rather than bunched wherever the seeds fell."""
    good = [c for c in cands if (c["result"]["closest"] or 99) >= 3.5]
    buckets = {}
    for c in good:
        buckets.setdefault(int(key_bearing(c["scen"]) // 30), []).append(c)
    chosen = []
    while len(chosen) < n and any(buckets.values()):
        for b in sorted(buckets):
            if buckets[b] and len(chosen) < n:
                chosen.append(buckets[b].pop(0))
    return chosen


def main():
    ex = exercises()
    which = [sys.argv[1]] if len(sys.argv) > 1 else sorted(ex)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    js = lib()
    for eid in which:
        meta = ex[eid]
        t0 = time.time()
        cands = candidates(meta, range(1, n * 2 + 10), js)
        chosen = pick(cands, n)
        if len(chosen) < n:
            sys.exit("%s: only %d usable scenarios" % (eid, len(chosen)))
        d = os.path.join(SCEN, eid)
        os.makedirs(d, exist_ok=True)
        for old in glob.glob(os.path.join(d, "*.json")):
            os.remove(old)
        for i, c in enumerate(chosen, 1):
            scen = c["scen"]
            scen["variant"] = "%02d" % i
            scen["solution"] = c["script"]
            scen["stats"] = {"conflicts": c["conflicts"], "traps": c["traps"],
                             "level_changes": c["changes"], "peak": c["peak"],
                             "solver": c["result"]}
            with open(os.path.join(d, scen["variant"] + ".json"), "w", encoding="utf-8") as fh:
                json.dump(scen, fh, indent=1, ensure_ascii=False)
        print("%s: %d candidates, wrote %d in %.0fs" % (eid, len(cands), len(chosen),
                                                       time.time() - t0))
        for c in chosen:
            s = c["scen"]
            print("   %s  brg %03d  %2d ac  %d conflicts  %d traps  %d level changes  "
                  "peak %2d  %2d calls  closest %.1f" % (
                      s["variant"], key_bearing(s), len(s["traffic"]), c["conflicts"],
                      c["traps"], c["changes"], c["peak"], len(c["script"]),
                      c["result"]["closest"] or 99))


if __name__ == "__main__":
    main()
