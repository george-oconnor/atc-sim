#!/usr/bin/env python3
"""The exercises flown end to end in a real browser (headless Chromium).

test_sim.py proves the scenarios in an embedded engine; this proves them in
the engine people actually use. It serves the app on a spare port, then:

  - replays every pooled scenario's stored solution in V8, so a difference
    in floating point between engines can't turn a clean scenario dirty;
  - boots the real sim page for a pooled scenario of each exercise, clicks
    through the start dialog, flies the solution through the same transmit
    path the keyboard uses, and checks the debrief and the stored run;
  - does the same for the unlimited mode, where the page builds its own
    scenario from a seed.

    .venv/bin/python tests/test_chrome.py
"""
import glob
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time

os.environ["SENTRY_DSN"] = ""
os.environ["OPENAI_API_KEY"] = ""      # browser voice only: no API calls from tests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, "tests"))

from chrome import Chrome, find_chrome, free_port  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  " + detail) if detail else ""))
    if not cond:
        failures.append(name)


if not find_chrome():
    print("no Chromium available -- skipped")
    sys.exit(0)

import app as A  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

A.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="atc-test-"), "runs.db")
PORT = free_port()
server = make_server("127.0.0.1", PORT, A.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d" % PORT

with open(os.path.join(BASE, "scenarios", "exercises.json"), encoding="utf-8") as fh:
    EX = json.load(fh)
for k, v in EX.items():
    v["id"] = k

FLY = """
(function (script, sim, send) {
  sim.paused = false;
  var i = 0, guard = 0;
  while (!sim.finished && guard++ < 4000) {
    while (i < script.length && sim.t >= script[i][0]) { send(script[i][1]); i++; }
    sim.step(1);
  }
  sim.paused = true;
  return {t: sim.t, finished: sim.finished, losses: sim.losses, handled: sim.handled,
          correct: sim.correct, excursions: sim.excursions, faults: sim.faults,
          n: sim.scen.traffic.length, sent: i};
})
"""


def clean(r):
    return (r["finished"] and r["losses"] == 0 and r["correct"] == r["n"] == r["handled"]
            and r["excursions"] == 0 and r["faults"] == 0)


def runs():
    if not os.path.exists(A.DB_PATH):
        return []
    db = sqlite3.connect(A.DB_PATH)
    db.row_factory = sqlite3.Row
    out = [dict(r) for r in db.execute("SELECT * FROM run ORDER BY id")]
    db.close()
    return out


def start_page(c, url):
    """Open a sim page and click through help -> Type -> Start, as a person would."""
    c.errors.clear()
    c.goto(url, wait=0.3)
    for _ in range(100):                      # the unlimited mode builds first
        if c.eval("!!(window.ATC && ATC.current)"):
            break
        time.sleep(0.1)
    c.eval("document.querySelector('#modal [data-close]').click();"
           "document.getElementById('modeType').click();"
           "document.getElementById('startBtn').click();")


def fly_page(c, script_expr):
    return c.eval("%s(%s, ATC.current.sim, function (t) { ATC.current.ui.transmit(t); })"
                  % (FLY.strip(), script_expr))


def debriefed(c):
    for _ in range(40):
        if c.eval("document.getElementById('helpTitle').textContent") == "Debrief":
            return True
        time.sleep(0.1)
    return False


c = Chrome()
try:
    print("\nEvery pooled solution, replayed in V8")
    c.goto(URL + "/static/css/style.css", wait=0.1)
    c.eval("window.ATC = {}")
    for f in ["geo.js", "speech.js", "aircraft.js", "sim.js", "gen.js"]:
        with open(os.path.join(BASE, "static/js", f), encoding="utf-8") as fh:
            c.eval(fh.read())
    for eid in sorted(EX):
        dirty, count = [], 0
        for p in sorted(glob.glob(os.path.join(BASE, "scenarios", eid, "*.json"))):
            with open(p, encoding="utf-8") as fh:
                scen = json.load(fh)
            count += 1
            r = c.eval("""(function (scen) {
              var sim = new ATC.Sim(scen), send = function (t) {
                var r = ATC.speech.parse(t, sim);
                if (!r.ok || r.notes.length) { sim.faults++; return; }
                if (r.action.kind === 'turn') r.ac.cmdHeading(r.action.hdg, r.action.dir);
                else r.ac.cmdLevel(r.action.fl);
              };
              return %s(scen.solution, sim, send);
            })(%s)""" % (FLY.strip(), json.dumps(scen)))
            if not clean(r):
                dirty.append("%s %s" % (os.path.basename(p), r))
        check("%s: all %d clean in V8" % (eid, count), count >= 20 and not dirty,
              "; ".join(dirty[:2]))

    print("\nA pooled scenario of each exercise, flown through the page")
    for eid in sorted(EX):
        before = len(runs())
        start_page(c, URL + "/sim/" + eid + "?v=03")
        check("%s: page boots without script errors" % eid, not c.errors, "; ".join(c.errors[:2]))
        check("%s: running after Start" % eid,
              c.eval("!ATC.current.sim.paused && ATC.current.ui.mode === 'type'"))
        with open(os.path.join(BASE, "scenarios", eid, "03.json"), encoding="utf-8") as fh:
            script = json.load(fh)["solution"]
        r = fly_page(c, json.dumps(script))
        check("%s: clean through the keyboard path" % eid, clean(r), str(r))
        check("%s: debrief shown" % eid, debriefed(c))
        time.sleep(0.5)
        new = runs()[before:]
        check("%s: run stored against the exercise and scenario" % eid,
              len(new) == 1 and new[0]["scenario"] == eid
              and json.loads(new[0]["detail"]).get("variant") == "03",
              str([(x["scenario"], json.loads(x["detail"]).get("variant")) for x in new]))

    print("\nUnlimited mode: the page builds its own scenario")
    for eid in sorted(EX):
        for seed in (101, 90210):
            before = len(runs())
            t0 = time.time()
            start_page(c, URL + "/sim/%s?seed=%d" % (eid, seed))
            took = time.time() - t0
            check("%s seed %d: boots without script errors (%.1fs)" % (eid, seed, took),
                  not c.errors, "; ".join(c.errors[:2]))
            info = c.eval("""({n: SCENARIO.traffic.length, v: SCENARIO.variant,
              brief: document.querySelector('#startModal .brief').textContent,
              label: document.getElementById('variant').textContent})""")
            lo, hi = EX[eid]["aircraft"]
            check("%s seed %d: %d aircraft, briefing written, labelled" % (eid, seed, info["n"]),
                  lo <= info["n"] <= hi and info["brief"].startswith(
                      ("A straight", "The corridor", "Two corridors"))
                  and info["label"] == "random · %d" % seed, str(info))
            r = fly_page(c, "ATC.gen.solve(SCENARIO).script")
            check("%s seed %d: flies clean" % (eid, seed), clean(r), str(r))
            check("%s seed %d: debrief shown" % (eid, seed), debriefed(c))
            time.sleep(0.5)
            new = runs()[before:]
            check("%s seed %d: run stored as a random one" % (eid, seed),
                  len(new) == 1 and json.loads(new[0]["detail"]).get("variant") == "seed:%d" % seed)

    print("\nThe same seed is the same scenario")
    a = []
    for _ in range(2):
        c.goto(URL + "/sim/ex2?seed=5150", wait=0.3)
        for _ in range(100):
            if c.eval("!!(window.ATC && ATC.current)"):
                break
            time.sleep(0.1)
        a.append(c.eval("JSON.stringify(SCENARIO.traffic)"))
    check("reloading a seeded page rebuilds exactly the same traffic", a[0] == a[1])

    print("\nA random pick from the front page")
    c.errors.clear()
    c.goto(URL + "/", wait=0.2)
    c.eval("document.querySelector('a.card[href=\"/sim/ex2\"]').click()")
    time.sleep(1.5)
    loc = c.eval("location.search")
    check("clicking an exercise lands on one of its scenarios", loc.startswith("?v="), loc)
    check("...with no script errors", not c.errors, "; ".join(c.errors[:2]))
    if os.environ.get("SHOTS"):
        c.screenshot(os.environ["SHOTS"])
finally:
    c.close()
    server.shutdown()

print("\n%s" % ("FAILED: " + ", ".join(failures) if failures else "all checks passed"))
sys.exit(1 if failures else 0)
