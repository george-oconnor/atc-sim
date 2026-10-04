#!/usr/bin/env python3
"""Checks the whole thing works without a browser.

The simulation runs in the browser, so most of the logic is JavaScript. These
tests load the real JS modules into an embedded engine (Duktape via dukpy) and
fly the real scenarios through them.

    .venv/bin/python tests/test_sim.py
"""
import glob
import json
import os

# app.py reads SENTRY_DSN from .env and would report a crashing test run to
# the production Sentry project. A real environment variable wins over .env,
# so an empty one here keeps tests out of it.
os.environ["SENTRY_DSN"] = ""
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import dukpy
import esprima

JS_MODULES = ["geo.js", "speech.js", "aircraft.js", "sim.js", "gen.js"]

failures = []


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  " + detail) if detail else ""))
    if not cond:
        failures.append(name)


# --------------------------------------------------------------- javascript
def load_js():
    src = ["var window = {}; var console = {log: function(){}, warn: function(){}};"]
    for f in JS_MODULES:
        with open(os.path.join(BASE, "static/js", f), encoding="utf-8") as fh:
            src.append(fh.read())
    return "\n;\n".join(src)


LIB = load_js()

DRIVE = """
function drive(scen, script, maxT) {
  var sim = new window.ATC.Sim(scen);
  sim.paused = false;
  var fired = {};
  for (var t = 0; t < maxT; t++) {
    for (var i = 0; i < script.length; i++) {
      if (fired[i] || sim.t < script[i][0]) continue;
      fired[i] = 1;
      var r = window.ATC.speech.parse(script[i][1], sim);
      if (!r.ok) { sim.log('rt', 'REJECTED: ' + script[i][1] + ' -- ' + r.error, 0); }
      else if (r.action) {
        if (r.action.kind === 'turn') r.ac.cmdHeading(r.action.hdg, r.action.dir);
        else r.ac.cmdLevel(r.action.fl);
        if (r.notes.length) {
          sim.penaliseFaults(r.notes.length);
          sim.log('rt', 'FAULT: ' + r.notes.join(' | '), 0);
        }
      }
    }
    sim.step(1);
  }
  var s = sim.summary();
  s.rt = sim.events.filter(function (e) { return e.kind === 'rt'; })
                   .map(function (e) { return e.text; });
  s.outcomes = {};
  sim.aircraft.forEach(function (a) { s.outcomes[a.callsign] = a.outcome || 'inflight'; });
  return s;
}
"""


def fixture(name):
    """The three original hand-built exercises, kept as fixed test data:
    the phraseology checks below need aircraft with known callsigns."""
    with open(os.path.join(BASE, "tests", "fixtures", name + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def exercises():
    with open(os.path.join(BASE, "scenarios", "exercises.json"), encoding="utf-8") as fh:
        ex = json.load(fh)
    for k, v in ex.items():
        v["id"] = k
    return ex


def pool(eid):
    out = []
    for p in sorted(glob.glob(os.path.join(BASE, "scenarios", eid, "*.json"))):
        with open(p, encoding="utf-8") as fh:
            out.append((os.path.basename(p)[:-5], json.load(fh)))
    return out


def fly(scen, script=()):
    js = DRIVE + "drive(SCEN, %s, %d);" % (json.dumps(list(script)),
                                           scen["duration_min"] * 60)
    return dukpy.evaljs([LIB, "var SCEN = " + json.dumps(scen) + ";", js])


# ------------------------------------------------------------------- tests
print("\nJavaScript syntax")
for f in sorted(glob.glob(os.path.join(BASE, "static/js/*.js"))):
    try:
        esprima.parseScript(open(f, encoding="utf-8").read())
        check(os.path.basename(f), True)
    except Exception as exc:
        check(os.path.basename(f), False, str(exc))

EX = exercises()

print("\nThe original Exercise 1 still flies (fixed data for the checks below)")
r = fly(fixture("classic_ex1"))
check("left alone, the head-on happens", r["losses"] >= 1, "losses=%d" % r["losses"])
r = fly(fixture("classic_ex1"), [
    (60,  "United one three zero, descend to flight level two one zero"),
    (600, "American six two, descend to flight level two five zero"),
])
check("flown properly, it comes out clean", r["losses"] == 0 and r["correct"] == 5,
      "losses=%d correct=%d" % (r["losses"], r["correct"]))

print("\nGenerator")
GEN_JS = """
var out = {};
Object.keys(EX).forEach(function (k) {
  var m = EX[k];
  var a = window.ATC.gen.make(m, 4242), b = window.ATC.gen.make(m, 4242);
  var c = window.ATC.gen.make(m, 777);
  out[k] = {same: JSON.stringify(a.scen) === JSON.stringify(b.scen),
            differs: JSON.stringify(a.scen.traffic) !== JSON.stringify(c.scen.traffic),
            ok: !!a.scen && !!c.scen,
            n: a.scen.traffic.length, script: a.solve.script,
            res: a.solve.result, scen: a.scen};
});
out;
"""
gen = dukpy.evaljs([LIB, "var EX = %s;" % json.dumps(EX), GEN_JS])
for eid, g in sorted(gen.items()):
    check("%s: a seed builds a vetted scenario" % eid, g["ok"])
    check("%s: the same seed builds the same scenario" % eid, g["same"])
    check("%s: a different seed builds a different one" % eid, g["differs"])
    lo, hi = EX[eid]["aircraft"]
    check("%s: %d-%d aircraft" % (eid, lo, hi), lo <= g["n"] <= hi, "n=%d" % g["n"])
    r = fly(g["scen"], g["script"])
    check("%s: the auto-controller's transmissions replay clean through the sim" % eid,
          r["losses"] == 0 and r["correct"] == g["n"] and not r["rt"]
          and r["detail"]["phraseology_faults"] == 0 and r["detail"]["excursions"] == 0,
          "losses=%d correct=%d/%d rt=%s" % (r["losses"], r["correct"], g["n"], r["rt"][:2]))

print("\nThe vetted pools")
# Every scenario in every pool is checked here: the full checks the
# generator applied, its stored solution replayed through the real sim,
# and the exercise left alone to show it really does go wrong.
CHECK_JS = """
var a = window.ATC.gen.assess(SCEN, META);
({ok: a.ok, problems: a.problems, conflicts: (a.conflicts || []).length});
"""
for eid in sorted(EX):
    meta = EX[eid]
    scens = pool(eid)
    check("%s: at least 20 scenarios" % eid, len(scens) >= 20, "got %d" % len(scens))
    bad, dirty, idle, shapes = [], [], [], set()
    for name, scen in scens:
        n = len(scen["traffic"])
        a = dukpy.evaljs([LIB, "var SCEN = %s, META = %s;" % (json.dumps(scen), json.dumps(meta)),
                          CHECK_JS])
        if not a["ok"] or scen.get("variant") != name:
            bad.append("%s: %s" % (name, "; ".join(a["problems"]) or "variant id"))
        if not (meta["aircraft"][0] <= n <= meta["aircraft"][1]):
            bad.append("%s: %d aircraft" % (name, n))
        if {t["callsign"][:3] for t in scen["traffic"]} - {"AAL", "DAL", "UAL"}:
            bad.append("%s: foreign callsign" % name)
        if len({t["callsign"] for t in scen["traffic"]}) != n:
            bad.append("%s: duplicate callsign" % name)
        if scen["separation"] != {"lateral_nm": 3, "vertical_ft": 1000}:
            bad.append("%s: separation" % name)
        r = fly(scen, scen["solution"])
        if (r["losses"] or r["correct"] != n or r["rt"] or r["detail"]["excursions"]
                or r["detail"]["phraseology_faults"]):
            dirty.append("%s: losses=%d correct=%d/%d exc=%d rt=%s" % (
                name, r["losses"], r["correct"], n, r["detail"]["excursions"], r["rt"][:1]))
        r = fly(scen)
        # Left alone: straight corridors lose separation; at the bend
        # everything flies out of the side instead.
        hurt = r["detail"]["excursions"] >= 3 if meta["layout"] == "bend" else r["losses"] >= 1
        if not hurt or r["score"] >= 100 * n:
            idle.append("%s: losses=%d exc=%d" % (name, r["losses"], r["detail"]["excursions"]))
        p = scen["corridors"][0]["path"]
        shapes.add(round(((__import__("math").degrees(__import__("math").atan2(
            p[1][0] - p[0][0], p[1][1] - p[0][1])) % 360) // 30)))
    check("%s: every scenario passes the generator's checks" % eid, not bad, "; ".join(bad[:3]))
    check("%s: every stored solution flies clean" % eid, not dirty, "; ".join(dirty[:3]))
    check("%s: every scenario goes wrong if left alone" % eid, not idle, "; ".join(idle[:3]))
    check("%s: corridors point in at least 8 different directions" % eid, len(shapes) >= 8,
          "%d" % len(shapes))

print("\nPhraseology")
CASES = [
    ("clean turn",        "American four five one, turn left heading zero seven zero",  True,  False),
    ("clean climb",       "Delta seven seven, climb to flight level two eight zero",    True,  False),
    ("misheard 'climbed'", "Delta seven seven, climbed flight level two eight zero",    True,  False),
    ("misheard 'descended'", "Delta seven seven, descended flight level two two zero",  True,  False),
    ("misheard 'percent'", "Delta seven seven, percent flight level two two zero",       True,  False),
    ("misheard 'per cent'", "Delta seven seven, per cent flight level two two zero",      True,  False),
    ("misheard 'to send to'", "Delta seven seven, to send to flight level two two zero",  True,  False),
    ("misheard '% of'", "Delta seven seven, % of flight level two two zero",              True,  False),
    ("misheard '%' glued to the callsign", "United one three zero% flight level two one zero", True, False),
    ("misheard '% of' glued to the callsign", "United one three zero% of flight level two one zero", True, False),
    ("misheard 'unit'", "Unit one three zero, descend to flight level two one zero", True, False),
    ("misheard 'two' as 'to', collapsed to a numeral", "American four five one, turn right heading to 70", True, False),
    ("digits hyphenated by dictation", "American four five one, turn left heading 0-60", True, False),
    ("'to' + two spoken digits is a genuine two-digit heading, not a mishearing",
     "American four five one, turn right heading to seven zero", True, True),
    ("correction",        "Correction, American four five one, turn left heading zero seven zero", True, False),
    ("wrong direction",   "American four five one, turn right heading zero seven zero", True,  True),
    ("grouped heading",   "American four five one, turn left heading seventy",          True,  True),
    ("airline code",      "AAL451, turn left heading zero seven zero",                  True,  True),
    ("climb vs descend",  "American four five one, descend to flight level two eight zero", True, True),
    ("no 'heading'",      "American four five one, turn left zero seven zero",          True,  True),
    ("no 'flight level'", "Delta seven seven, climb to two eight zero",                 True,  True),
    ("grouped level",     "Delta seven seven, climb to flight level two eighty",        True,  True),
    ("no numbers",        "American four five one, climb to flight level",              False, None),
    ("not on frequency",  "United nine nine nine, turn left heading zero seven zero",   False, None),
    ("'%' glued, cut off before the level", "United one three zero%",                   False, None),
    ("two transmissions run together as one (two aircraft)",
     "American four five one turn right heading two seven zero Delta six six climb "
     "flight level two eight zero", False, None),
    ("two instructions run together for the same aircraft",
     "Delta seven seven, climb to flight level two eight zero, climb to flight "
     "level three zero zero", False, None),
]
JS = """
var sim = new window.ATC.Sim(SCEN); sim.paused = false;
for (var t = 0; t < 400; t++) sim.step(1);
var out = [], cases = %s;
for (var i = 0; i < cases.length; i++) {
  var r = window.ATC.speech.parse(cases[i], sim);
  out.push({ok: r.ok, err: r.error || '', notes: r.notes || [], corr: !!r.correction,
             hdg: (r.action && r.action.kind === 'turn') ? r.action.hdg : null});
}
out;
""" % json.dumps([c[1] for c in CASES])
res = dukpy.evaljs([LIB, "var SCEN = " + json.dumps(fixture("classic_ex1")) + ";", JS])
for (label, _text, want_ok, want_notes), got in zip(CASES, res):
    ok = got["ok"] == want_ok and (want_notes is None or bool(got["notes"]) == want_notes)
    check(label, ok, got["err"] or ("notes: " + " | ".join(got["notes"])))
check("correction flag set", res[[c[0] for c in CASES].index("correction")]["corr"])
glued = res[[c[0] for c in CASES].index("'%' glued, cut off before the level")]
check("the callsign parses correctly despite the glued '%' -- "
      "the error is about the missing level, not a missing flight number",
      glued["err"] == "no flight level given", repr(glued["err"]))
to_two = res[[c[0] for c in CASES].index("misheard 'two' as 'to', collapsed to a numeral")]
check("'heading to 70' resolves to heading 270, not 070",
      to_two["hdg"] == 270, "hdg=%s" % to_two["hdg"])
hyph = res[[c[0] for c in CASES].index("digits hyphenated by dictation")]
check("'heading 0-60' resolves to heading 060", hyph["hdg"] == 60, "hdg=%s" % hyph["hdg"])
to_literal = res[[c[0] for c in CASES].index(
    "'to' + two spoken digits is a genuine two-digit heading, not a mishearing")]
check("'heading to seven zero' is left as the genuine (faulted) 070, not guessed at",
      to_literal["hdg"] == 70, "hdg=%s" % to_literal["hdg"])

print("\nConflict prediction")
# The alert (amber) is a predicted loss: both minima broken at the same
# moment. A climb or descent levels off at its cleared level -- the
# prediction used to carry it straight on through, which both missed and
# invented conflicts.
PREDICT_JS = """
function pair(a, b) {
  var sim = new window.ATC.Sim(SCEN);
  var sep = {separation: {lateral_nm: 3, vertical_ft: 1000}};
  function mk(o) {
    var ac = new window.ATC.Aircraft({callsign: o.cs, type: 'B738', fl: o.fl,
      clearedFl: o.to, exitFl: o.fl, speed: o.ias || 280, corridor: 0, dir: 1, t: 0,
      x: 0, y: o.y, hdg: o.hdg}, sep);
    ac.update(0.01);                       // picks up its climb/descent rate
    return ac;
  }
  sim.aircraft = [mk(a), mk(b)];
  sim.checkSeparation();
  return sim.conflicts.map(function (k) { return k.kind; });
}
[
  // The reported screenshot: DAL208 at FL254 descending to 250 at 300 kt,
  // head-on with AAL62 at 260 doing 270 kt, about 5 NM apart. They close
  // to 3 NM in ~8 s, but DAL208 needs ~12 s to reach 250: a real loss, and
  // the old check (vertical gap only at the closest point, 20 s out, by
  // which time the descent had been carried on far below 250) missed it.
  pair({cs: 'DAL208', fl: 254, to: 250, y: 4.96, hdg: 180, ias: 300},
       {cs: 'AAL62', fl: 260, to: 260, y: 0, hdg: 360, ias: 270}),
  // Descending to 250 head-on with traffic at 240, a long way off: 1000 ft
  // once level, so no alert -- carried on through 250, the old prediction
  // flagged this one.
  pair({cs: 'DAL208', fl: 260, to: 250, y: 20, hdg: 180},
       {cs: 'AAL62', fl: 240, to: 240, y: 0, hdg: 360}),
  // Descending to the same level as head-on traffic: a real conflict.
  pair({cs: 'DAL208', fl: 260, to: 240, y: 20, hdg: 180},
       {cs: 'AAL62', fl: 240, to: 240, y: 0, hdg: 360}),
  // Same level, diverging: nothing.
  pair({cs: 'DAL208', fl: 240, to: 240, y: 5, hdg: 360},
       {cs: 'AAL62', fl: 240, to: 240, y: 0, hdg: 180}),
];
"""
res = dukpy.evaljs([LIB, "var SCEN = " + json.dumps(fixture("classic_ex1")) + ";", PREDICT_JS])
check("the reported DAL208/AAL62 case is flagged: close before the descent finishes",
      res[0] == ["alert"], str(res[0]))
check("a descent that levels 1000 ft above traffic is not flagged on the way down",
      res[1] == [], str(res[1]))
check("a descent to the same level as head-on traffic is flagged",
      res[2] == ["alert"], str(res[2]))
check("same level but diverging is not flagged", res[3] == [], str(res[3]))

print("\nTurn direction")
# A report that "turn right heading 270" from heading 225 span the long way
# round instead of the direct 45 degrees. cmdHeading/update trace out fine by
# hand, so this locks the short-way case in as a regression guard.
TURN_JS = """
function turnTrace(fromHdg, toHdg, dir) {
  var spec = {callsign: 'AAL451', type: 'B738', fl: 230, exitFl: 230, speed: 280,
              corridor: 0, dir: 1, t: 0, x: 0, y: 0, hdg: fromHdg};
  var ac = new window.ATC.Aircraft(spec, {separation: {lateral_nm: 3, vertical_ft: 1000}});
  ac.cmdHeading(toHdg, dir);
  var trace = [ac.hdg];
  for (var t = 0; t < 60; t++) { ac.update(1); trace.push(ac.hdg); }
  return trace;
}
[turnTrace(225, 270, 'R'), turnTrace(225, 270, null)];
"""
res = dukpy.evaljs([LIB, TURN_JS])
short_trace, undirected_trace = res
check("turn right heading 270 from 225 goes up, not the long way round",
      max(short_trace) <= 270 and min(short_trace) >= 225,
      "trace=%s" % short_trace)
check("reaches 270 within 15s at rate one (3 deg/s)",
      short_trace[15] == 270, "trace[15]=%s" % short_trace[15])
check("with no direction given, the shorter way is still chosen the same way",
      undirected_trace == short_trace, "trace=%s" % undirected_trace)

print("\nFlask routes")
os.environ.setdefault("FLASK_SKIP", "1")
import app as A
A.DB_PATH = os.path.join(BASE, "data", "test-atcsim.db")    # never the real history
if os.path.exists(A.DB_PATH):
    os.remove(A.DB_PATH)

c = A.app.test_client()
for url in ["/", "/phraseology", "/tutorial", "/progress", "/mic-test",
            "/api/scenario/ex1", "/api/scenario/ex2/01"]:
    check(url, c.get(url).status_code == 200)
for url in ["/sim/nope", "/sim/ex1?v=999", "/sim/ex1?v=../ex2/01", "/sim/ex1?seed=abc",
            "/api/scenario/ex1/xx"]:
    check(url + " 404s", c.get(url).status_code == 404)

home = c.get("/").get_data(as_text=True)
check("front page lists the three exercises with their pool size",
      all("/sim/%s" % e in home for e in EX) and "25 scenarios" in home)
check("front page links the unlimited random mode", "/sim/ex3?random=1" in home)

resp = c.get("/sim/ex1")
check("/sim/ex1 redirects to one scenario from the pool",
      resp.status_code == 302 and re.search(r"/sim/ex1\?v=\d\d$", resp.headers["Location"]),
      resp.headers.get("Location", ""))
html = c.get(resp.headers["Location"]).get_data(as_text=True)
embedded = json.loads(re.search(r"window\.SCENARIO = (\{.*\});", html).group(1))
check("the scenario is embedded in the page", embedded["id"] == "ex1" and embedded["traffic"])
check("...without the auto-controller's solution", "solution" not in embedded)
check("...and the page says which one it is", re.search(r"#\d\d of 25", html) is not None)
check("the generator is loaded", "js/gen.js" in html)

seen = []
c2 = A.app.test_client()
for _ in range(12):
    loc = c2.get("/sim/ex2").headers["Location"]
    seen.append(loc.rsplit("=", 1)[1])
check("twelve starts in a row never repeat a scenario", len(set(seen)) == 12, ",".join(seen))

resp = c.get("/sim/ex3?random=1")
check("unlimited mode redirects to a seed",
      resp.status_code == 302 and re.search(r"\?seed=\d+$", resp.headers["Location"]))
html = c.get("/sim/ex3?seed=12345").get_data(as_text=True)
gen_cfg = json.loads(re.search(r"window\.GENERATE = (\{.*\});", html).group(1))
check("a seeded page hands the browser the exercise and seed to build from",
      gen_cfg["seed"] == 12345 and gen_cfg["meta"]["layout"] == "cross"
      and "window.SCENARIO = null" in html)

resp = c.post("/api/run", json={"scenario": "ex1", "score": 500, "handled": 5,
                                "correct": 5, "losses": 0, "commands": 2,
                                "detail": {"variant": "07"}})
check("POST /api/run stores a run", resp.status_code == 200 and resp.get_json()["ok"])
c.post("/api/run", json={"scenario": "ex2", "score": 300, "handled": 9, "correct": 7,
                         "losses": 1, "commands": 20, "detail": {"variant": "seed:991"}})
prog = c.get("/progress").get_data(as_text=True)
check("progress shows which scenario each run was", "#07" in prog and "random" in prog)
check("the best score shows on the front page", "best 500" in c.get("/").get_data(as_text=True))

print("\naccounts and transcription reports")
import io  # noqa: E402
import shutil  # noqa: E402


def csrf(client):
    return client.get("/api/me").get_json()["csrf"]


def register(client, email, pw="correct horse", pw2=None):
    return client.post("/register", data={"email": email, "password": pw,
                                          "password2": pw if pw2 is None else pw2,
                                          "csrf_token": csrf(client)})


other = A.app.test_client()
check("someone else's browser doesn't see this one's anonymous runs",
      "#07" not in other.get("/progress").get_data(as_text=True))
resp = c.post("/login", data={"email": "x@example.com", "password": "y"})
check("a form posted without its CSRF token is refused",
      resp.status_code == 302 and c.get("/api/me").get_json()["user"] is None)
check("mismatched passwords are refused",
      "match" in register(c, "pilot1@example.com", pw2="nope").get_data(as_text=True))
check("short passwords are refused",
      "at least" in register(c, "pilot1@example.com", pw="short").get_data(as_text=True))
check("something that isn't an email address is refused",
      "email address" in register(c, "pilot1").get_data(as_text=True))
resp = register(c, "  Pilot1@Example.com ")
check("registering logs you in, with the address tidied",
      resp.status_code == 302 and
      c.get("/api/me").get_json()["user"] == {"email": "pilot1@example.com", "role": "user"})
check("...and the runs flown logged out move into the account",
      "#07" in c.get("/progress").get_data(as_text=True)
      and "best 500" in c.get("/").get_data(as_text=True))
check("one account per address, whatever the case",
      "already an account" in register(other, "PILOT1@example.COM").get_data(as_text=True))
c.post("/api/run", json={"scenario": "ex3", "score": 42, "handled": 1, "correct": 1,
                         "losses": 0, "commands": 1, "detail": {"variant": "11"}})
check("a run flown logged in is the account's",
      "#11" in c.get("/progress").get_data(as_text=True)
      and "#11" not in other.get("/progress").get_data(as_text=True))

anon = A.app.test_client()
resp = anon.post("/api/report", data={"payload": "{}"}, headers={"X-CSRF-Token": csrf(anon)})
check("reports need an account", resp.status_code == 401)

ATTEMPT = {"heard": "american 98descend flight level 280", "kind": "err", "flagged": True,
           "result": "not understood: no flight number after \"american\"",
           "alternatives": [[{"transcript": "american 98% of flight level 280", "confidence": .8},
                             {"transcript": "american nine eight percent", "confidence": .1}]]}


def report(client, extra=None, audio=None):
    payload = {"said": "American nine eight, descend to flight level two eight zero",
               "attempts": [ATTEMPT], "scenario": "ex1 07", "aircraft": ["AAL98", "UAL791"]}
    payload.update(extra or {})
    data = {"payload": json.dumps(payload)}
    if audio:
        data["audio"] = audio
    return client.post("/api/report", data=data, headers={"X-CSRF-Token": csrf(client)},
                       content_type="multipart/form-data")


resp = report(c, audio=(io.BytesIO(b"OggS-ish"), "r.webm", "audio/webm"))
check("a recording without consent is refused", resp.status_code == 400
      and "agree" in resp.get_json()["error"])
resp = report(c, {"consent": True}, audio=(io.BytesIO(b"\x1aE\xdf\xa3 fake webm"),
                                           "r.webm", "audio/webm;codecs=opus"))
check("a report with a recording goes in", resp.status_code == 200, resp.get_data(as_text=True))
rid = resp.get_json().get("id")
check("...and the recording is kept beside the database",
      os.path.exists(os.path.join(A.reports_dir(), "%s.webm" % rid)))
resp = report(c, {"consent": True}, audio=(io.BytesIO(b"MZ"), "x.exe", "application/x-msdownload"))
check("anything that isn't audio is refused", resp.status_code == 400)
check("a plain user can't read reports",
      c.get("/admin/reports").status_code == 403 and
      c.get("/admin/reports/%s/audio" % rid).status_code == 403)
check("...nor can someone logged out", anon.get("/admin/reports").status_code == 302)

runner = A.app.test_cli_runner()
out = runner.invoke(args=["make-admin", "nobody"])
check("make-admin wants an account that exists", out.exit_code != 0)
register(other, "boss@example.com")
out = runner.invoke(args=["make-admin", "Boss@Example.com"])
check("make-admin promotes an account", out.exit_code == 0, out.output)
listing = other.get("/admin/reports").get_data(as_text=True)
check("an admin sees the report", "98descend" in listing and "pilot1@example.com" in listing)
page = other.get("/admin/reports/%s" % rid).get_data(as_text=True)
check("...with every alternative the recogniser offered",
      "american 98% of flight level 280" in page and "american nine eight percent" in page)
resp = other.get("/admin/reports/%s/audio" % rid)
check("...and can play the recording", resp.status_code == 200 and
      resp.mimetype == "audio/webm" and resp.data.startswith(b"\x1aE"))
other.post("/admin/reports/%s" % rid, data={"status": "resolved", "note": "fixed in speech.js",
                                            "csrf_token": csrf(other)})
check("resolving moves it off the open list",
      "98descend" not in other.get("/admin/reports").get_data(as_text=True) and
      "98descend" in other.get("/admin/reports?status=resolved").get_data(as_text=True))

db = A.sqlite3.connect(A.DB_PATH)
pilot_id = db.execute("SELECT id FROM account WHERE email = 'pilot1@example.com'").fetchone()[0]
boss_id = db.execute("SELECT id FROM account WHERE email = 'boss@example.com'").fetchone()[0]
db.close()
other.post("/admin/users", data={"id": pilot_id, "action": "role", "role": "reviewer",
                                 "csrf_token": csrf(other)})
check("an admin can make someone a reviewer",
      c.get("/api/me").get_json()["user"]["role"] == "reviewer"
      and c.get("/admin/reports").status_code == 200)
check("...who still can't manage accounts", c.get("/admin/users").status_code == 403)
other.post("/admin/users", data={"id": boss_id, "action": "role", "role": "user",
                                 "csrf_token": csrf(other)})
check("an admin can't demote themselves",
      other.get("/api/me").get_json()["user"]["role"] == "admin")
resp = other.post("/admin/users", data={"id": pilot_id, "action": "reset",
                                        "csrf_token": csrf(other)}, follow_redirects=True)
temp = re.search(r"New password for pilot1@example.com: (\S+)", resp.get_data(as_text=True))
check("resetting a password logs that person out everywhere",
      temp and c.get("/api/me").get_json()["user"] is None)
c.post("/login", data={"email": "PILOT1@example.com", "password": temp.group(1) if temp else "",
                       "csrf_token": csrf(c)})
check("...and the new one works (address in any case)", c.get("/api/me").get_json()["user"] is not None)

for _ in range(10):
    anon.post("/login", data={"email": "pilot1@example.com", "password": "guess",
                              "csrf_token": csrf(anon)})
resp = anon.post("/login", data={"email": "pilot1@example.com", "password": temp.group(1) if temp else "",
                                 "csrf_token": csrf(anon)})
check("ten wrong guesses lock the account's logins for a while",
      "Too many" in resp.get_data(as_text=True))
with A.app.test_request_context():
    check("redirects after login stay on this site",
          A._safe_next("//evil.example") == "/" and A._safe_next("/progress") == "/progress"
          and A._safe_next("https://evil.example") == "/")

shutil.rmtree(A.reports_dir(), ignore_errors=True)
os.remove(A.DB_PATH)

print("\npilot voice TTS proxy")
os.environ.pop("OPENAI_API_KEY", None)
resp = c.post("/api/tts", json={"text": "American four five one, turn left heading zero seven zero"})
check("without a key, tells the browser to fall back rather than erroring",
      resp.status_code == 503, str(resp.status_code))
os.environ["OPENAI_API_KEY"] = "sk-test-not-a-real-key"
resp = c.post("/api/tts", json={"text": ""})
check("empty text is rejected", resp.status_code == 400, str(resp.status_code))
resp = c.post("/api/tts", json={"text": "test"})
check("a bad key reaches OpenAI and comes back as an upstream error, not a crash",
      resp.status_code == 502, str(resp.status_code))
real_tts = A.realtime_tts
A.realtime_tts = lambda key, text, voice: (b"\x00\x00" * 2400, text)
resp = c.post("/api/tts", json={"text": "Wilco, Delta two eight", "voice": "cedar"})
check("Realtime PCM comes back as a playable WAV",
      resp.status_code == 200 and resp.mimetype == "audio/wav"
      and resp.data[:4] == b"RIFF" and resp.data[8:12] == b"WAVE",
      "%s %s" % (resp.status_code, resp.mimetype))
A.realtime_tts = real_tts
check("readback drift check ignores case and punctuation",
      A._words("Wilco, Delta two-eight.") == A._words("wilco delta two eight"))
os.environ.pop("OPENAI_API_KEY", None)

print("\n%s" % ("FAILED: " + ", ".join(failures) if failures
                else "all checks passed"))
sys.exit(1 if failures else 0)
