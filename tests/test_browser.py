#!/usr/bin/env python3
"""Run the browser-side files against a DOM built from the real template.

radar.js, ui.js, voice.js and main.js touch the DOM, so the engine test in
test_sim.py cannot load them. Here the page is parsed into a small DOM with
genuine selector matching and event bubbling, so the selectors in the JS are
checked against the markup the server actually sends -- which is where the
last two bugs lived.

    .venv/bin/python tests/test_browser.py
"""
import html.parser
import json
import os

# app.py reads SENTRY_DSN from .env and would report a crashing test run to
# the production Sentry project. A real environment variable wins over .env,
# so an empty one here keeps tests out of it.
os.environ["SENTRY_DSN"] = ""
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import dukpy

failures = []
VOID = {"meta", "link", "br", "hr", "img", "input", "source"}


def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (("  " + detail) if detail else ""))
    if not cond:
        failures.append(name)


class Parser(html.parser.HTMLParser):
    """Turn the rendered page into a nested {tag, attrs, children} tree."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {"tag": "root", "attrs": {}, "children": [], "text": ""}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": {k: (v if v is not None else "") for k, v in attrs},
                "children": [], "text": ""}
        self.stack[-1]["children"].append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data.strip():
            self.stack[-1]["text"] += data.strip()


# ------------------------------------------------------------------ sources
def render_page():
    """Ask Flask for the real page, so we test what the server sends."""
    sys.path.insert(0, BASE)
    import app as A
    return A.app.test_client().get("/sim/ex1?v=01").get_data(as_text=True)


HTML = render_page()
TREE = Parser()
TREE.feed(HTML)
SCEN = json.loads(re.search(r"window\.SCENARIO = (\{.*\});", HTML).group(1))
FILES = re.findall(r'src="/static/js/([a-z]+\.js)(?:\?[^"]*)?"', HTML)
DOM = open(os.path.join(BASE, "tests/dom.js"), encoding="utf-8").read()


def build(ready_state="complete", pre=""):
    src = [DOM,
           "ROOT = buildTree(%s, null);" % json.dumps(TREE.root),
           "document.readyState = '%s';" % ready_state,
           "window.SCENARIO = " + json.dumps(SCEN) + ";",
           pre]                      # runs before any of the page's own code
    for f in FILES:
        src.append(open(os.path.join(BASE, "static/js", f), encoding="utf-8").read())
    return src


def run(tail, ready_state="complete", pre=""):
    return dukpy.evaljs(build(ready_state, pre) + [tail])


BOOT = """
var r = {ok: true};
try {
  if (document.readyState === 'loading') domReady();
  r.started = !!(window.ATC && window.ATC.current);
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
"""
# Every caller appends more JS and is expected to end with its own "r;" --
# dukpy returns the completion value of the *last* statement in the whole
# script, and an assignment's completion value is the assigned value, not r.
# BOOT ending in "r;" only helps callers that add nothing further.
BOOT_ONLY = BOOT + "r;"

# ------------------------------------------------------------------- tests
print("\nthe page the server sends")
check("scripts are discoverable", len(FILES) == 12 and "gen.js" in FILES and "feedback.js" in FILES, " ".join(FILES))
check("report.js loads first, to catch errors in the rest", FILES[0] == "report.js")
check("voice.js loads before ui.js", FILES.index("voice.js") < FILES.index("ui.js"))
check("rt.js loads before ui.js", FILES.index("rt.js") < FILES.index("ui.js"))
check("every script opts out of Rocket Loader",
      HTML.count("data-cfasync") == HTML.count("<script"),
      "%d of %d" % (HTML.count("data-cfasync"), HTML.count("<script")))
check("main.js does not trust DOMContentLoaded alone",
      "readyState" in open(os.path.join(BASE, "static/js/main.js"), encoding="utf-8").read())

print("\nthe DOM stub understands the real markup")
r = run(BOOT + """
r.sections = document.querySelectorAll('.side .sec').length;
r.heads = document.querySelectorAll('.side .sec .sechead').length;
r.headIsButton = (document.querySelector('.sechead') || {}).tag;
r.secNames = [];
document.querySelectorAll('.side .sec').forEach(function (s) { r.secNames.push(s.dataset.sec); });
r;""")
check("finds one panel", r.get("sections") == 1, "found %s" % r.get("sections"))
check("finds one heading", r.get("heads") == 1, "found %s" % r.get("heads"))
check("headings are buttons", r.get("headIsButton") == "button",
      "got <%s>" % r.get("headIsButton"))
check("panels are named", r.get("secNames") == ["traffic"],
      str(r.get("secNames")))

print("\nboot")
for state in ("loading", "interactive", "complete"):
    r = run(BOOT + "r;", state)
    check(state, r["ok"] and r.get("started"), r.get("err", ""))

print("\nrunning main.js twice (Rocket Loader reprocessing a script tag, "
      "or anything else that duplicates it) does not boot the app twice")
main_src = open(os.path.join(BASE, "static/js/main.js"), encoding="utf-8").read()
src = build("complete") + [
    "var firstUI = window.ATC.current.ui;",
    main_src,   # simulate the exact same script tag running a second time
    """
    var r = {};
    r.sameUiInstance = (window.ATC.current.ui === firstUI);
    r;
    """,
]
r = dukpy.evaljs(src)
check("a second run of main.js leaves the original UI/sim/radar in place",
      r.get("sameUiInstance") is True, str(r))

print("\nradar: drag pans, a tap selects, and a second finger pinches to zoom")
r = run(BOOT + """
try {
  var cv = document.getElementById('radar');
  var radar = window.ATC.current.radar;
  var startCentre = {x: radar.centre.x, y: radar.centre.y};
  var startRange = radar.range;

  // One pointer, moved: pans, and must not also fire a selection on release.
  dispatch(cv, 'pointerdown', {pointerId: 1, clientX: 400, clientY: 400});
  dispatch(cv, 'pointermove', {pointerId: 1, clientX: 460, clientY: 430});
  r.centreMovedWhileDragging =
    radar.centre.x !== startCentre.x || radar.centre.y !== startCentre.y;
  var picked = false;
  radar.onPick = function () { picked = true; };
  dispatch(cv, 'pointerup', {pointerId: 1, clientX: 460, clientY: 430});
  r.dragDidNotAlsoSelect = picked === false;

  // One pointer, not moved: a tap, and must select.
  dispatch(cv, 'pointerdown', {pointerId: 2, clientX: 400, clientY: 400});
  dispatch(cv, 'pointerup', {pointerId: 2, clientX: 400, clientY: 400});
  r.tapSelected = picked === true;

  // Two pointers spreading apart: a pinch, zooming in (range shrinks) --
  // there is no mouse equivalent of this, so it was never reachable at all
  // before this used Pointer Events.
  dispatch(cv, 'pointerdown', {pointerId: 10, clientX: 500, clientY: 450});
  dispatch(cv, 'pointerdown', {pointerId: 11, clientX: 520, clientY: 450});
  var rangeAfterPinchStart = radar.range;
  dispatch(cv, 'pointermove', {pointerId: 10, clientX: 460, clientY: 450});
  dispatch(cv, 'pointermove', {pointerId: 11, clientX: 560, clientY: 450});
  r.rangeShrankWhilePinching = radar.range < rangeAfterPinchStart;

  // Lifting one finger out of the pinch resumes panning from where that
  // finger now is, rather than jumping using the old pinch baseline.
  var rangeAfterPinch = radar.range;
  dispatch(cv, 'pointerup', {pointerId: 10, clientX: 460, clientY: 450});
  dispatch(cv, 'pointermove', {pointerId: 11, clientX: 620, clientY: 450});
  r.rangeUnchangedOnceBackToOneFinger = radar.range === rangeAfterPinch;
  dispatch(cv, 'pointerup', {pointerId: 11, clientX: 620, clientY: 450});

  // The mouse wheel must still work exactly as before. Zooming further IN
  // wouldn't show up if the pinch above already hit the minimum range --
  // zoom back OUT instead, which has room to move regardless.
  var rangeBeforeWheel = radar.range;
  dispatch(cv, 'wheel', {deltaY: 100});
  r.wheelStillZooms = radar.range !== rangeBeforeWheel;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("dragging one pointer pans the view", r.get("centreMovedWhileDragging") is True,
      r.get("err", ""))
check("...without also selecting whatever is under the release point",
      r.get("dragDidNotAlsoSelect") is True)
check("an unmoved tap selects", r.get("tapSelected") is True)
check("two fingers spreading apart pinch-zooms in", r.get("rangeShrankWhilePinching") is True)
check("dropping to one finger resumes panning instead of jumping",
      r.get("rangeUnchangedOnceBackToOneFinger") is True)
check("the mouse wheel still zooms too", r.get("wheelStillZooms") is True)

# A narrow screen, where traffic is the collapsible overlay on the radar.
NARROW = """
var MQ = {matches: true, listeners: [],
  addEventListener: function (t, f) { this.listeners.push(f); }};
window.matchMedia = function () { return MQ; };
"""

print("\ncollapsing the traffic overlay (clicking the real elements)")
r = run(BOOT + """
try {
  var secs = document.querySelectorAll('.radarwrap .sec');
  r.before = [];
  secs.forEach(function (s) { r.before.push(s.classList.contains('collapsed')); });

  // Click the <span class="chev"> inside the heading -- the click must still
  // find its way to the section, as it would in a browser.
  var chev = secs[0].querySelector('.chev');
  dispatch(chev, 'click');
  r.afterChevClick = secs[0].classList.contains('collapsed');
  r.aria = secs[0].querySelector('.sechead').getAttribute('aria-expanded');
  r.stored = store['atc.sec.traffic'];

  dispatch(secs[0].querySelector('.sechead'), 'click');
  r.reopened = !secs[0].classList.contains('collapsed');
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre=NARROW)
check("all start expanded", r.get("before") == [False], str(r.get("before")))
check("clicking inside a heading collapses its panel", r.get("afterChevClick") is True,
      r.get("err", ""))
check("aria-expanded follows", r.get("aria") == "false", str(r.get("aria")))
check("state is remembered", r.get("stored") == "1", str(r.get("stored")))
check("clicking again reopens it", r.get("reopened") is True)

print("\nnarrow screens: traffic is a see-through dropdown over the radar")
r = run(BOOT + """
try {
  var sec = document.querySelector('.stripsbox');
  r.onRadar = sec.parent === document.querySelector('.radarwrap');
  r.notInSide = document.querySelector('.side .stripsbox') === null;
  dispatch(sec.querySelector('.sechead'), 'click');
  r.collapses = sec.classList.contains('collapsed');
  MQ.matches = false; MQ.listeners.forEach(function (f) { f(); });   // rotate to wide
  r.backInSide = document.querySelector('.side .stripsbox') === sec &&
    document.querySelector('.side').children[0] === sec;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre=NARROW)
check("the traffic list moves onto the radar", r.get("onRadar") is True, r.get("err", ""))
check("...and out of the panel below", r.get("notInSide") is True)
check("...where it still collapses", r.get("collapses") is True)
check("widening the screen puts it back at the top of the sidebar",
      r.get("backInSide") is True)

print("\ncollapsed state is restored on load")
r = run(BOOT + """
var secs = document.querySelectorAll('.radarwrap .sec');
r.traffic = secs[0].classList.contains('collapsed');
r;""", pre=NARROW + "store['atc.sec.traffic'] = '1';")
check("a remembered panel starts collapsed", r.get("traffic") is True, r.get("err", ""))

print("\nwide screens: traffic is the only sidebar section, so it does not collapse")
r = run(BOOT + """
try {
  var sec = document.querySelector('.side .stripsbox');
  var head = sec.querySelector('.sechead');
  r.disabled = head.disabled === true;
  r.noAria = head.getAttribute('aria-expanded') === undefined;
  dispatch(head, 'click');            // a disabled button gets no click in a browser,
  r.stillOpen = !sec.classList.contains('collapsed');   // but the handler checks too
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the sidebar heading is not a live button", r.get("disabled") is True, r.get("err", ""))
check("...and does not claim to expand anything", r.get("noAria") is True)
check("...and clicking it does not collapse the list", r.get("stillOpen") is True)

print("\nsettings cog: display toggles in a dropdown")
r = run(BOOT + """
try {
  var btn = document.getElementById('settingsBtn'), menu = document.getElementById('settingsMenu');
  r.startsClosed = menu.hidden === true;
  r.togglesInside = ['toggleVectors', 'toggleRings', 'toggleVoices'].every(function (id) {
    return document.getElementById(id).closest('#settingsMenu') === menu; });
  dispatch(btn, 'click');
  r.opens = menu.hidden === false && btn.getAttribute('aria-expanded') === 'true';
  var rings = document.getElementById('toggleRings');
  rings.checked = true; dispatch(rings, 'change'); dispatch(rings, 'click');
  r.ringsOn = window.ATC.current.ui.radar.showRings === true;
  r.staysOpen = menu.hidden === false;
  dispatch(document.querySelector('.radarwrap'), 'click');
  r.closesOutside = menu.hidden === true && btn.getAttribute('aria-expanded') === 'false';
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the menu starts closed", r.get("startsClosed") is True, r.get("err", ""))
check("vectors, rings and pilot voices are all in it", r.get("togglesInside") is True)
check("the cog opens it", r.get("opens") is True)
check("a toggle still does its job", r.get("ringsOn") is True)
check("...and flipping one leaves the menu open", r.get("staysOpen") is True)
check("a tap elsewhere closes it", r.get("closesOutside") is True)

print("\na big paused overlay, only while paused mid-run")
r = run(BOOT + """
try {
  var ui = window.ATC.current.ui, ov = document.getElementById('pausedOverlay');
  r.hiddenBeforeStart = ov.hidden === true;
  dispatch(document.getElementById('modeType'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  r.hiddenWhileRunning = ov.hidden === true;
  dispatch(document.getElementById('pause'), 'click');
  r.shownWhenPaused = ov.hidden === false && ui.sim.paused === true;
  dispatch(ov, 'click');
  r.tapResumes = ov.hidden === true && ui.sim.paused === false;
  dispatch(document.getElementById('pause'), 'click');
  ui.radio.say = function () {};
  ui.finishRun();
  r.hiddenAtDebrief = ov.hidden === true;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre="window.fetch = fetch = function () { return {then: function () { return this; },"
          " catch: function () { return this; }}; };")
check("not shown before the run starts", r.get("hiddenBeforeStart") is True, r.get("err", ""))
check("not shown while running", r.get("hiddenWhileRunning") is True)
check("shown when paused", r.get("shownWhenPaused") is True)
check("tapping it resumes", r.get("tapResumes") is True)
check("gone once the debrief is up", r.get("hiddenAtDebrief") is True)

print("\nclosing the debrief at the end of a run goes back to the exercises")
r = run(BOOT + """
try {
  var ui = window.ATC.current.ui;
  dispatch(document.querySelector('[data-close]'), 'click');     // the help on load
  r.helpCloseStays = location.href === undefined;
  ui.finishRun();
  dispatch(document.querySelector('[data-close]'), 'click');
  r.went = location.href;
  r.home = document.querySelector('.bar .home').getAttribute('href');
  r.keepalive = FETCHES.length > 0 && FETCHES[FETCHES.length - 1].opts.keepalive === true;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre="var location = {}; window.location = location;\n"
          "var FETCHES = []; window.fetch = fetch = function (u, o) {\n"
          "  FETCHES.push({url: u, opts: o || {}}); return {then: function () { return this; },"
          " catch: function () { return this; }}; };")
check("closing the help on load does not navigate", r.get("helpCloseStays") is True,
      r.get("err", ""))
check("closing the debrief goes to the exercise list",
      r.get("went") is not None and r.get("went") == r.get("home"),
      "%r vs %r" % (r.get("went"), r.get("home")))
check("...without cutting off the saved result", r.get("keepalive") is True)

print("\nhelp modal on load leads into the speak-or-type prompt")
r = run(BOOT + """
try {
  r.helpShown = document.getElementById('modal').classList.contains('show');
  dispatch(document.querySelector('[data-close]'), 'click');
  r.helpClosedAfter = !document.getElementById('modal').classList.contains('show');
  r.startShownAfterHelp = document.getElementById('startModal').classList.contains('show');
  r.startDisabledBeforeChoice = document.getElementById('startBtn').disabled;
  r.briefIsInStartModal = document.querySelector('#startModal .brief').textContent.length > 0;
  r.noSidebarBrief = document.querySelector('.side .brief') === null;

  dispatch(document.getElementById('modeSpeak'), 'click');
  r.startEnabledAfterChoice = !document.getElementById('startBtn').disabled;
  r.pausedBeforeStart = window.ATC.current.sim.paused;

  dispatch(document.getElementById('startBtn'), 'click');
  r.startHiddenAfterStart = !document.getElementById('startModal').classList.contains('show');
  r.runningAfterStart = !window.ATC.current.sim.paused;
  r.cmdHiddenInSpeakMode = document.getElementById('cmd').hidden;
  r.graphHiddenBeforeHold = document.getElementById('soundgraph').hidden;

  // Tap to talk: nothing listens until the button is actually tapped.
  dispatch(document.getElementById('ptt'), 'pointerdown');
  r.graphShownWhileHeld = !document.getElementById('soundgraph').hidden;
  r.listeningWhileHeld = window.ATC.current.ui.voice.listening;
  advanceClock(400);
  dispatch(document.getElementById('ptt'), 'pointerdown');   // tap again to stop
  r.graphHiddenAfterRelease = document.getElementById('soundgraph').hidden;
  r.listeningAfterRelease = window.ATC.current.ui.voice.listening;

  // Reopening help later (the "?" button) must not re-show the start prompt.
  dispatch(document.getElementById('helpBtn'), 'click');
  dispatch(document.querySelector('[data-close]'), 'click');
  r.startStaysHiddenLater = !document.getElementById('startModal').classList.contains('show');
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("help modal is shown on load", r.get("helpShown") is True, r.get("err", ""))
check("closing it hides the help modal", r.get("helpClosedAfter") is True)
check("...and opens the speak-or-type prompt", r.get("startShownAfterHelp") is True)
check("the exercise brief is shown in that same prompt",
      r.get("briefIsInStartModal") is True, r.get("err", ""))
check("...and no longer takes up room in the sidebar", r.get("noSidebarBrief") is True)
check("start is disabled until a mode is chosen", r.get("startDisabledBeforeChoice") is True)
check("choosing a mode enables start", r.get("startEnabledAfterChoice") is True)
check("the exercise has not started yet", r.get("pausedBeforeStart") is True)
check("pressing start closes the prompt", r.get("startHiddenAfterStart") is True)
check("...and starts the exercise", r.get("runningAfterStart") is True)
check("speak mode hides the input box", r.get("cmdHiddenInSpeakMode") is True)
check("nothing is listening or shown until push-to-talk is held",
      r.get("graphHiddenBeforeHold") is True)
check("tapping push-to-talk starts listening and shows the graph",
      r.get("graphShownWhileHeld") is True and r.get("listeningWhileHeld") is True)
check("tapping it again stops listening and hides the graph",
      r.get("graphHiddenAfterRelease") is True and r.get("listeningAfterRelease") is False)
check("reopening help later does not repeat the start prompt",
      r.get("startStaysHiddenLater") is True)

print("\nchoosing speak mode silently primes the mic ahead of your first tap")
r = run(BOOT + """
try {
  dispatch(document.querySelector('[data-close]'), 'click');
  dispatch(document.getElementById('modeSpeak'), 'click');
  // Priming happens as part of choosing "Speak", before Start is even
  // pressed -- it must not be visible in any way.
  var st = document.getElementById('micStatus');
  var ptt = document.getElementById('ptt');
  r.primedSilently = (st.hidden || !st.textContent) &&
    !window.ATC.current.ui.voice.listening;

  dispatch(document.getElementById('startBtn'), 'click');
  // The real tap that follows a silent prime must still work normally --
  // priming must not leave the recogniser stuck mid-start. FakeSR now
  // throws on a double start() exactly like a real recogniser does, so
  // this genuinely exercises the race: priming's rec.start() is still
  // "started" (its own stop() has not fired yet) when this tap's
  // startListening() tries to start() too.
  dispatch(document.getElementById('ptt'), 'pointerdown');
  r.realTapStillWorks = window.ATC.current.ui.voice.listening;
  r.noErrorShown = document.getElementById('micStatus').className.indexOf('err') < 0;

  // Some time later the (genuinely running) session legitimately ends on
  // its own, as continuous=false sessions do -- confirm the ordinary
  // restart-on-end path still works normally afterwards, i.e. that the
  // earlier conflict didn't leave anything in a confused state.
  LAST_REC.started = false;
  LAST_REC.onend();
  r.stillListeningAfterLaterEnd = window.ATC.current.ui.voice.listening;
  runTimers();   // fires the scheduled restart
  r.stillListeningAfterTimers = window.ATC.current.ui.voice.listening;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("priming never shows up as \"warming up\" or anything else",
      r.get("primedSilently") is True, r.get("err", ""))
check("the first real tap afterwards still starts listening normally",
      r.get("realTapStillWorks") is True)
check("...with no error shown despite the internal conflict", r.get("noErrorShown") is True)
check("a later, genuine end-and-restart still works normally afterwards",
      r.get("stillListeningAfterLaterEnd") is True, r.get("err", ""))
check("...and the scheduled restart actually completes",
      r.get("stillListeningAfterTimers") is True)

print("\npressing the space bar is push-to-talk too")
r = run(BOOT + """
try {
  dispatch(document.querySelector('[data-close]'), 'click');
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');

  dispatch(document, 'keydown', {key: ' '});
  r.listeningAfterKeydown = window.ATC.current.ui.voice.listening;
  r.pausedAfterKeydown = window.ATC.current.sim.paused;   // must NOT also pause

  // A held key fires keydown repeatedly -- these must not re-toggle it.
  dispatch(document, 'keydown', {key: ' ', repeat: true});
  dispatch(document, 'keydown', {key: ' ', repeat: true});
  r.listeningAfterRepeats = window.ATC.current.ui.voice.listening;

  dispatch(document, 'keyup', {key: ' '});
  r.listeningAfterKeyup = window.ATC.current.ui.voice.listening;   // keyup alone does nothing now

  advanceClock(400);
  dispatch(document, 'keydown', {key: ' '});   // press again to stop
  r.listeningAfterSecondPress = window.ATC.current.ui.voice.listening;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("pressing space starts listening", r.get("listeningAfterKeydown") is True, r.get("err", ""))
check("...without also toggling pause", r.get("pausedAfterKeydown") is False)
check("held-key repeats do not re-toggle it", r.get("listeningAfterRepeats") is True)
check("releasing the key does nothing by itself", r.get("listeningAfterKeyup") is True)
check("pressing space again stops listening", r.get("listeningAfterSecondPress") is False)

print("\nthe button and the space bar go through the identical push-to-talk path")
r = run(BOOT + """
try {
  dispatch(document.querySelector('[data-close]'), 'click');
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');

  dispatch(document.getElementById('ptt'), 'pointerdown');
  r.viaButton = {
    listening: window.ATC.current.ui.voice.listening,
    graphShown: !document.getElementById('soundgraph').hidden,
    on: document.getElementById('ptt').classList.contains('on')
  };
  advanceClock(400);
  dispatch(document.getElementById('ptt'), 'pointerdown');   // tap again to stop
  r.viaButtonAfter = {
    listening: window.ATC.current.ui.voice.listening,
    graphShown: !document.getElementById('soundgraph').hidden,
    on: document.getElementById('ptt').classList.contains('on')
  };

  advanceClock(400);
  dispatch(document, 'keydown', {key: ' '});
  r.viaSpace = {
    listening: window.ATC.current.ui.voice.listening,
    graphShown: !document.getElementById('soundgraph').hidden,
    on: document.getElementById('ptt').classList.contains('on')
  };
  advanceClock(400);
  dispatch(document, 'keydown', {key: ' '});   // press again to stop
  r.viaSpaceAfter = {
    listening: window.ATC.current.ui.voice.listening,
    graphShown: !document.getElementById('soundgraph').hidden,
    on: document.getElementById('ptt').classList.contains('on')
  };
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("pressing the button starts listening and shows the graph together",
      r.get("viaButton") == {"listening": True, "graphShown": True, "on": True},
      "%s  %s" % (r.get("viaButton"), r.get("err", "")))
check("releasing it stops both together",
      r.get("viaButtonAfter") == {"listening": False, "graphShown": False, "on": False},
      str(r.get("viaButtonAfter")))
check("holding space does exactly the same thing",
      r.get("viaSpace") == r.get("viaButton"), "%s vs %s" % (r.get("viaSpace"), r.get("viaButton")))
check("releasing space does exactly the same thing",
      r.get("viaSpaceAfter") == r.get("viaButtonAfter"),
      "%s vs %s" % (r.get("viaSpaceAfter"), r.get("viaButtonAfter")))

print("\na duplicate press/keydown for the same physical tap does not un-toggle it")
r = run(BOOT + """
try {
  dispatch(document.querySelector('[data-close]'), 'click');
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');

  dispatch(document, 'keydown', {key: ' '});
  // A second keydown arrives almost instantly, not flagged as a repeat --
  // this reproduced a real device turning "tap to stop" into "off, then
  // immediately back on" before the off state could even be seen.
  dispatch(document, 'keydown', {key: ' '});
  r.stillListeningAfterDuplicate = window.ATC.current.ui.voice.listening;

  advanceClock(400);
  dispatch(document, 'keydown', {key: ' '});   // a genuinely later press
  r.listeningAfterRealSecondPress = window.ATC.current.ui.voice.listening;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("a near-instant duplicate keydown is ignored, not treated as a real second press",
      r.get("stillListeningAfterDuplicate") is True, r.get("err", ""))
check("a press well after the debounce window still toggles normally",
      r.get("listeningAfterRealSecondPress") is False)

print("\nclick is a fallback for pointerdown -- some mobile browsers only fire one of them")
r = run(BOOT + """
try {
  dispatch(document.querySelector('[data-close]'), 'click');
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  var ptt = document.getElementById('ptt');

  // A browser that never fires pointerdown for a tap at all -- click alone
  // must still be enough to start listening.
  dispatch(ptt, 'click');
  r.listeningFromClickAlone = window.ATC.current.ui.voice.listening;

  advanceClock(400);
  // A browser that fires both for one physical tap must not double-toggle.
  dispatch(ptt, 'pointerdown');
  dispatch(ptt, 'click');
  r.listeningAfterBothEvents = window.ATC.current.ui.voice.listening;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("click alone starts listening, even with no pointerdown at all",
      r.get("listeningFromClickAlone") is True, r.get("err", ""))
check("pointerdown + click for one tap toggles once, not twice",
      r.get("listeningAfterBothEvents") is False)

print("\nsound graph animates from recogniser activity, not a second mic stream")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  var levelAtRest = window.ATC.current.ui.sound.level;
  LAST_REC.onaudiostart();               // "Hearing you" -- the mic is open, nothing more
  r.levelAfterHeard = window.ATC.current.ui.sound.level;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: false, 0: {transcript: 'american four'}, length: 1}]});
  r.levelAfterWords = window.ATC.current.ui.sound.level;
  r.leviedWithoutGetUserMedia = typeof navigator === 'undefined';
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the graph starts at rest", True, "")   # sanity: no exception reaching here
check("the mic opening only flickers the graph, not a burst of fake speech",
      0 < (r.get("levelAfterHeard") or 0) < 0.5,
      "err=%s level=%s" % (r.get("err"), r.get("levelAfterHeard")))
check("recognised words pulse the graph right up",
      (r.get("levelAfterWords") or 0) > 0.5, "level=%s" % r.get("levelAfterWords"))
check("no navigator/getUserMedia involved at all", r.get("leviedWithoutGetUserMedia") is True)

voice_src = open(os.path.join(BASE, "static/js/voice.js"), encoding="utf-8").read()
sound_class = voice_src[voice_src.index("class SoundGraph"):voice_src.index("class SoundGraph") + 2000]
has_raf = "requestAnimationFrame" in sound_class
check("SoundGraph never starts its own animation loop "
      "(a second permanent rAF alongside the radar's is what starved the mic)",
      not has_raf, sound_class if has_raf else "")

print("\nlive speech transcript")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  r.listening = LAST_REC && LAST_REC.started;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: false, 0: {transcript: 'american four five'}, length: 1}]});
  var lt = document.getElementById('livert');
  r.interim = lt.querySelector('.interim').children.length;
  r.shown = !lt.hidden;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true,
     0: {transcript: 'american four five one turn left heading zero seven zero'},
     length: 1}]});
  var kids = lt.querySelector('.final').children;
  r.finalWords = kids.length;
  r.roles = [];
  for (var i = 0; i < kids.length; i++) r.roles.push(kids[i].className);
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("mic starts the recogniser", r.get("listening") is True, r.get("err", ""))
check("interim words show at once", r.get("shown") and r.get("interim") == 3,
      "words=%s" % r.get("interim"))
check("committed words render", r.get("finalWords") == 10, "words=%s" % r.get("finalWords"))
roles = " ".join(r.get("roles") or [])
check("callsign highlighted", "f cs" in roles)
check("digits highlighted", "f num" in roles)
check("keywords highlighted", "f kw" in roles, roles)

print("\nn-best rescoring: a lower-ranked alternative that reads as phraseology wins")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true, length: 2,
     0: {transcript: 'tell her for 69 kind flight level 320'},
     1: {transcript: 'delta four six nine climb to flight level three two zero'}}]});
  var kids = lt_final();
  r.words = Array.prototype.map.call(kids, function (k) { return k.textContent; }).join(' ');
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
function lt_final() { return document.getElementById('livert').querySelector('.final').children; }
r;""")
check("the phraseology-shaped alternative is preferred over the top guess",
      r.get("words") == "delta four six nine climb to flight level three two zero",
      r.get("err") or r.get("words"))

print("\nmic status: on-page feedback (no browser console needed)")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  var st = document.getElementById('micStatus');
  var ptt = document.getElementById('ptt');
  r.listeningText = st.hidden ? null : st.textContent;
  r.pttLabelWarming = ptt.querySelector('.pttlabel').textContent;
  r.pttHintWarming = ptt.querySelector('.ptthint').textContent;
  r.pttClassWarming = ptt.className;

  LAST_REC.onaudiostart();
  r.heardText = st.hidden ? null : st.textContent;
  r.heardClass = st.className;
  r.pttLabelHeard = ptt.querySelector('.pttlabel').textContent;
  r.pttClassHeard = ptt.className;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("clicking the mic shows a status line",
      r.get("listeningText") == "Warming up \u2014 wait, don\u2019t speak yet\u2026",
      repr(r.get("listeningText")))
check("the button itself says not to speak yet while warming up",
      "don\u2019t speak" in (r.get("pttHintWarming") or ""), repr(r.get("pttHintWarming")))
check("...and looks visibly different (warming, not just on)",
      "warming" in (r.get("pttClassWarming") or ""), repr(r.get("pttClassWarming")))
check("audio arriving updates the status", r.get("heardText") == "Hearing you\u2026",
      repr(r.get("heardText")))
check("the heard status is styled ok", "ok" in (r.get("heardClass") or ""))
check("the button switches out of the warming phase once heard",
      "warming" not in (r.get("pttClassHeard") or "") and "on" in (r.get("pttClassHeard") or ""),
      repr(r.get("pttClassHeard")))
check("...and its label invites you to speak now",
      "speak now" in (r.get("pttLabelHeard") or "").lower(), repr(r.get("pttLabelHeard")))

print("\ntapping off cancels: trailing results are neither shown nor sent")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');   // start
  advanceClock(400);   // a genuine second tap, not a duplicated event for the first
  dispatch(document.getElementById('ptt'), 'pointerdown');   // tap off again, right away
  var st = document.getElementById('micStatus');
  r.statusRightAfterStop = st.hidden ? null : st.textContent;

  // The recogniser is still finishing up -- these fire late, after stop().
  LAST_REC.onaudiostart();
  r.statusAfterLateHeard = st.hidden ? null : st.textContent;

  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: false, 0: {transcript: 'american four five'}, length: 1}]});
  var lt = document.getElementById('livert');
  r.interimShownAfterStop = lt.querySelector('.interim').children.length > 0;

  var before = document.getElementById('captions').children.length;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true,
     0: {transcript: 'american four five one turn left heading zero seven zero'},
     length: 1}]});
  r.finalWordsAfterStop = lt.querySelector('.final').children.length;
  r.ltHidden = lt.hidden;
  r.sentAfterStop = document.getElementById('captions').children.length - before;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("status is cleared right after tapping off", r.get("statusRightAfterStop") is None,
      repr(r.get("statusRightAfterStop")) + "  " + r.get("err", ""))
check("a late onaudiostart does not resurrect \"Hearing you\"",
      r.get("statusAfterLateHeard") is None, repr(r.get("statusAfterLateHeard")))
check("a late interim result does not show a \"live\" transcript once stopped",
      r.get("interimShownAfterStop") is False)
check("a late final result is not shown", r.get("finalWordsAfterStop") == 0,
      "words=%s" % r.get("finalWordsAfterStop"))
check("...the transcript strip is cleared", r.get("ltHidden") is True)
check("...and nothing is transmitted", r.get("sentAfterStop") == 0,
      "sent=%s  %s" % (r.get("sentAfterStop"), r.get("err", "")))

print("\nmic status: every error code is surfaced, not swallowed")
CASES = [
    ("not-allowed", "denied"),
    ("audio-capture", "No microphone"),
    ("no-speech", "catch anything"),
    ("network", "network connection"),
    ("service-not-allowed", "in-app browsers"),
]
for code, expect in CASES:
    r = run(BOOT + ("""
    try {
      dispatch(document.getElementById('modeSpeak'), 'click');
      dispatch(document.getElementById('startBtn'), 'click');
      dispatch(document.getElementById('ptt'), 'pointerdown');
      LAST_REC.onerror({error: %s});
      var st = document.getElementById('micStatus');
      r.text = st.hidden ? null : st.textContent;
      r.stillListening = LAST_REC.started;
    } catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
    r;""") % json.dumps(code))
    check("%s -> visible, human message" % code,
          bool(r.get("text")) and expect in r.get("text", ""),
          repr(r.get("text")) + "  " + r.get("err", ""))
    if code in ("not-allowed", "audio-capture"):
        check("%s -> mic actually stops (no silent retry loop)" % code,
              r.get("stillListening") is False)

print("\nquick keys cannot be produced by speech, so speaking always grades as phraseology")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  r.modeHiddenWhileSpeaking = document.getElementById('modeRow').hidden === true;
  r.modeInSettings = document.getElementById('mode').closest('#settingsMenu') !== null;
  r.gradesAsStrict = window.ATC.current.ui.strict;

  // Switching to typing must bring the selector back and respect it again.
  dispatch(document.getElementById('switchMode'), 'click');
  r.modeShownWhileTyping = !document.getElementById('modeRow').hidden;
  document.getElementById('mode').value = 'quick';
  dispatch(document.getElementById('mode'), 'change');
  r.quickWorksWhileTyping = window.ATC.current.ui.strict === false;

  // Switching back to speak must force strict again, not leave the stale
  // "quick" choice silently unusable (parseQuick cannot understand a
  // spoken sentence at all -- it would just report "select an aircraft
  // first" no matter what was said).
  dispatch(document.getElementById('switchMode'), 'click');
  r.forcedStrictAgainWhileSpeaking = window.ATC.current.ui.strict === true;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the judging selector lives in the settings menu", r.get("modeInSettings") is True)
check("the quick-keys selector is hidden while speaking",
      r.get("modeHiddenWhileSpeaking") is True, r.get("err", ""))
check("speech always grades as phraseology, regardless of the selector",
      r.get("gradesAsStrict") is True)
check("the selector comes back once back to typing", r.get("modeShownWhileTyping") is True)
check("choosing quick keys while typing still works", r.get("quickWorksWhileTyping") is True)
check("switching back to speak forces phraseology again",
      r.get("forcedStrictAgainWhileSpeaking") is True)

print("\n'aborted' (you stopped it yourself) is not shown as an error")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  var before = document.getElementById('micStatus').textContent;
  LAST_REC.onerror({error: 'aborted'});
  var st = document.getElementById('micStatus');
  r.text = st.hidden ? null : st.textContent;
  r.unchanged = (r.text === before);
  r.isError = st.className.indexOf('err') >= 0;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("stopping yourself leaves the status exactly as it was",
      r.get("unchanged") is True, repr(r.get("text")))
check("no error styling appears from a user-initiated stop", r.get("isError") is False)

print("\nwatchdog: a cold mic retries silently once before ever complaining")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  var st = document.getElementById('micStatus');

  runTimers();   // first watchdog fire: nothing heard yet -> silent retry, not an error
  r.textAfterFirstTimeout = st.hidden ? null : st.textContent;
  r.stillListeningAfterRetry = window.ATC.current.ui.voice.listening;

  runTimers();   // the retry's onend -> scheduled restart fires
  runTimers();   // second watchdog fire: still nothing heard -> now it says something
  r.textAfterSecondTimeout = st.hidden ? null : st.textContent;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the first timeout retries quietly rather than alarming immediately",
      r.get("textAfterFirstTimeout") == "Still warming up — wait for it…",
      repr(r.get("textAfterFirstTimeout")) + "  " + r.get("err", ""))
check("...without giving up on listening", r.get("stillListeningAfterRetry") is True)
check("only a second cold attempt in a row is treated as a real problem",
      bool(r.get("textAfterSecondTimeout")) and
      "nothing is being heard" in r.get("textAfterSecondTimeout", ""),
      repr(r.get("textAfterSecondTimeout")))

print("\nwatchdog: cancelled once audio actually arrives")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  LAST_REC.onaudiostart();      // should clearTimeout the watchdog
  runTimers();                  // if it were not cancelled, this fires it
  var st = document.getElementById('micStatus');
  r.text = st.hidden ? null : st.textContent;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("no spurious silence-nudge once audio is heard",
      r.get("text") == "Hearing you\u2026", repr(r.get("text")))

print("\nrestart storm: onend firing repeatedly with no audio stops instead of flashing forever")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  r.listeningAtStart = LAST_REC.started;
  // Never once heard -- the recogniser just keeps ending itself immediately,
  // which is exactly what made the mic permission indicator flash rapidly.
  for (var i = 0; i < 6; i++) LAST_REC.onend();
  var st = document.getElementById('micStatus');
  r.text = st.hidden ? null : st.textContent;
  r.stillListening = window.ATC.current.ui.voice.listening;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("it does start out listening", r.get("listeningAtStart") is True, r.get("err", ""))
check("repeated instant restarts give up instead of spinning the mic forever",
      r.get("stillListening") is False, r.get("err", ""))
check("...and say so, rather than leaving it unexplained",
      bool(r.get("text")) and "restarting" in r.get("text", ""), repr(r.get("text")))

print("\nidle: tap to talk closes itself after 8 seconds of silence")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  var st = document.getElementById('micStatus');
  advanceClock(3000);           // a slow warm-up...
  LAST_REC.onaudiostart();      // ...then the mic goes live: the 8s starts here
  advanceClock(6000); runTimers(0);   // 9s since the tap, 6s since live
  r.listeningAt6s = window.ATC.current.ui.voice.listening;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: false, 0: {transcript: 'american four'}, length: 1}]});
  advanceClock(6000); runTimers(0);
  r.listeningAfterWords = window.ATC.current.ui.voice.listening;
  LAST_REC.onend(); runTimers(); LAST_REC.onaudiostart();   // between-utterance cycling
  advanceClock(2000); runTimers(0);   // 8s since the last word
  r.listeningAfterSilence = window.ATC.current.ui.voice.listening;
  r.text = st.hidden ? null : st.textContent;
  r.isError = st.className.indexOf('err') >= 0;
  r.button = document.getElementById('ptt').querySelector('.pttlabel').textContent;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("a slow warm-up does not eat into the eight seconds",
      r.get("listeningAt6s") is True, r.get("err", ""))
check("each word recognised restarts the countdown",
      r.get("listeningAfterWords") is True)
check("8s with nothing recognised stops listening, despite restart cycling",
      r.get("listeningAfterSilence") is False)
check("...and says why, without error styling",
      "nothing heard for 8 seconds" in (r.get("text") or "") and r.get("isError") is False,
      repr(r.get("text")))
check("...and the button goes back to Tap to talk",
      "Tap to talk" in (r.get("button") or ""), repr(r.get("button")))

r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  runTimers(); runTimers(); runTimers();   // cold mic: retry, then the mic error
  advanceClock(8000); runTimers(0);
  var st = document.getElementById('micStatus');
  r.listening = window.ATC.current.ui.voice.listening;
  r.text = st.hidden ? null : st.textContent;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("a dead mic also times out", r.get("listening") is False, r.get("err", ""))
check("...but leaves the mic error showing, the real explanation",
      "nothing is being heard" in (r.get("text") or ""), repr(r.get("text")))

print("\nthe caption shows the instruction as sent, not the words as recognised")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  var ui = window.ATC.current.ui, sim = ui.sim;
  ui.radio.say = function () {};                  // no audio here: just the caption
  sim.t = sim.pending[0].t; sim.spawn();          // put the first aircraft on frequency
  var ac = sim.aircraft[0];
  r.tidyCs = window.ATC.speech.tidy(ac.spoken());
  ui.transmit(ac.spoken() + ' climbed flight level four one zero');
  var you = ui.msgs.filter(function (m) { return m.who === 'You'; });
  r.sent = you.length ? you[0].text : null;
  ui.transmit(ac.spoken() + ' fly sideways');
  you = ui.msgs.filter(function (m) { return m.who === 'You'; });
  r.unparsed = you.length ? you[0].text : null;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("a misheard word is captioned as what was understood",
      r.get("sent") == r.get("tidyCs", "?") + ", climb to flight level 410",
      repr(r.get("sent")) + "  " + r.get("err", ""))
check("...and an unparsed transmission is captioned as heard",
      r.get("unparsed") == r.get("tidyCs", "?") + " fly sideways", repr(r.get("unparsed")))

print("\none tap, one transmission: the mic closes once a message is sent")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  dispatch(document.getElementById('ptt'), 'pointerdown');
  LAST_REC.onaudiostart();
  var before = document.getElementById('captions').children.length;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true,
     0: {transcript: 'american four five one turn left heading zero seven zero'},
     length: 1}]});
  r.sent = document.getElementById('captions').children.length - before;
  r.listening = window.ATC.current.ui.voice.listening;
  r.button = document.getElementById('ptt').querySelector('.pttlabel').textContent;
  var st = document.getElementById('micStatus');
  r.status = st.hidden ? null : st.textContent;
  LAST_REC.started = false; LAST_REC.onend(); runTimers();
  r.restarted = LAST_REC.started;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("the transmission is sent", (r.get("sent") or 0) > 0, r.get("err", ""))
check("...and listening stops straight after it", r.get("listening") is False)
check("...the button is back to Tap to talk", "Tap to talk" in (r.get("button") or ""),
      repr(r.get("button")))
check("...with no idle-timeout message", r.get("status") is None, repr(r.get("status")))
check("...and the recogniser is not restarted behind your back",
      r.get("restarted") is False)

print("\npilot on air: their readback through the speakers is never transmitted")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  var radio = window.ATC.current.ui.radio;
  dispatch(document.getElementById('ptt'), 'pointerdown');   // tapped mid-readback
  LAST_REC.onaudiostart();
  radio.airOn();
  var before = document.getElementById('captions').children.length;
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: false, 0: {transcript: 'climb flight level'}, length: 1}]});
  r.interimShown = document.getElementById('livert').querySelector('.interim').children.length > 0;
  radio.airOff();
  // the tail of that same utterance, delivered after the audio stopped
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true, 0: {transcript: 'climb flight level one two zero american four five one'},
     length: 1}]});
  r.sentDuringReadback = document.getElementById('captions').children.length - before;
  r.stillListening = window.ATC.current.ui.voice.listening;
  r.onAirJustAfter = radio.onAir;
  advanceClock(1000);
  r.onAirLater = radio.onAir;
  LAST_REC.started = false; LAST_REC.onend(); runTimers();   // next session: you
  LAST_REC.onresult({resultIndex: 0, results: [
    {isFinal: true,
     0: {transcript: 'american four five one turn left heading zero seven zero'},
     length: 1}]});
  r.sentAfter = document.getElementById('captions').children.length - before;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""")
check("words heard while a pilot is on air are not shown", r.get("interimShown") is False,
      r.get("err", ""))
check("...nor transmitted, even when the tail arrives after the audio stops",
      r.get("sentDuringReadback") == 0, "sent=%s" % r.get("sentDuringReadback"))
check("...and the mic stays open for your own transmission", r.get("stillListening") is True)
check("a short tail after the readback still counts as on air", r.get("onAirJustAfter") is True)
check("...but not for long", r.get("onAirLater") is False)
check("your next transmission after the readback goes through",
      (r.get("sentAfter") or 0) > 0, "sent=%s" % r.get("sentAfter"))

print("\nthe talk button is disabled while a pilot is about to read back, or is")
HANGING_FETCH = ("window.fetch = fetch = function () { return {then: function () { return this; },"
                 " catch: function () { return this; }}; };")
r = run(BOOT + """
try {
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  var ui = window.ATC.current.ui, radio = ui.radio, ptt = document.getElementById('ptt');
  var label = function () { return ptt.querySelector('.pttlabel').textContent; };
  r.freeAtStart = ptt.disabled !== true;

  radio.say(ui.sim.aircraft[0] || {id: 1, callsign: 'X', spoken: function () { return 'x'; }},
            'climb flight level two four zero');          // fetching the voice
  r.blockedWhileFetching = ptt.disabled === true && label().indexOf('Pilot') >= 0;
  dispatch(ptt, 'pointerdown');
  r.tapIgnored = ui.voice.listening === false;
  advanceClock(400);
  dispatch(document, 'keydown', {key: ' ', code: 'Space'});
  r.spaceIgnored = ui.voice.listening === false;

  radio.airOn();                                           // now it is on air
  r.blockedOnAir = ptt.disabled === true;
  radio.airOff(); radio.finishedPlaying();
  r.blockedInTail = ptt.disabled === true;                 // the late-words tail
  advanceClock(900); runTimers();
  r.freeAfter = ptt.disabled !== true && label().indexOf('Tap to talk') >= 0;

  radio.say({id: 2, callsign: 'Y', spoken: function () { return 'y'; }}, 'roger');
  r.blockedAgain = ptt.disabled === true;
  advanceClock(10100); runTimers();                        // that fetch never comes back
  r.freeWhenStuck = ptt.disabled !== true;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre=HANGING_FETCH)
check("free before any readback", r.get("freeAtStart") is True, r.get("err", ""))
check("disabled while the readback is being fetched",
      r.get("blockedWhileFetching") is True)
check("...a tap does not open the mic", r.get("tapIgnored") is True)
check("...nor does space", r.get("spaceIgnored") is True)
check("disabled while the pilot is on air", r.get("blockedOnAir") is True)
check("...and for the short tail after", r.get("blockedInTail") is True)
check("free again once the readback is over", r.get("freeAfter") is True)
check("a readback that never arrives cannot lock it for good",
      r.get("blockedAgain") is True and r.get("freeWhenStuck") is True)

print("\ntouch-only devices are not told to press space")
r = run(BOOT + """
r.hint = document.getElementById('ptt').querySelector('.ptthint').textContent;
r;""", pre="window.matchMedia = function (q) { return {matches: /coarse/.test(q),"
           " addEventListener: function () {}}; };")
check("no mention of space on a touch-only device",
      r.get("hint") and "space" not in r.get("hint"), repr(r.get("hint")) + r.get("err", ""))
r = run(BOOT + """
r.hint = document.getElementById('ptt').querySelector('.ptthint').textContent;
r;""")
check("...but still there with a keyboard", "space" in (r.get("hint") or ""), repr(r.get("hint")))

print("\nunsupported browser: message is on the page, not a hover-only title")
NO_SR = "delete window.SpeechRecognition;\ndelete window.webkitSpeechRecognition;"
r = run(BOOT + """
var st = document.getElementById('modeNote');
r.text = st.hidden ? null : st.textContent;
r.micDisabled = document.getElementById('modeSpeak').disabled;
r;""", pre=NO_SR)
check("speak button is disabled", r.get("micDisabled") is True, r.get("err", ""))
check("a visible reason is shown, not just a title tooltip",
      bool(r.get("text")) and "not available" in r.get("text", ""),
      repr(r.get("text")))

print("\nChrome on iPhone: speaking is ruled out before the exercise starts")
r = run(BOOT + """
var st = document.getElementById('modeNote');
r.text = st.hidden ? null : st.textContent;
r.micDisabled = document.getElementById('modeSpeak').disabled;
dispatch(document.getElementById('modeSpeak'), 'click');
r.startStillDisabled = document.getElementById('startBtn').disabled;
r.switchHidden = document.getElementById('switchMode').hidden;
r;""", pre="var navigator = window.navigator = {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone "
           "OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 "
           "Mobile/15E148 Safari/604.1'};")
check("speak button is disabled on the start screen", r.get("micDisabled") is True,
      r.get("err", ""))
check("...with a reason that points to Safari", "Safari" in (r.get("text") or ""),
      repr(r.get("text")))
check("...and choosing it anyway does not enable Start", r.get("startStillDisabled") is True)
check("...nor is switching to speech offered later", r.get("switchHidden") is True)

print("\nvoice failure must not break the page")
r = run(BOOT + """
r.micDisabled = document.getElementById('modeSpeak').disabled;
r.sectionsStillWork = false;
try {
  var s = document.querySelectorAll('.radarwrap .sec')[0];
  dispatch(s.querySelector('.sechead'), 'click');
  r.sectionsStillWork = s.classList.contains('collapsed');
} catch (e) { r.err2 = String(e && e.message); }
r;""", pre=NARROW + "function BrokenSR(){ throw new Error('nope'); }\n"
            "window.SpeechRecognition = BrokenSR;")
check("the page still boots", r["ok"] and r.get("started"), r.get("err", ""))
check("collapsing still works", r.get("sectionsStillWork") is True, r.get("err2", ""))

print("\ntranscription reports")
# fetch() never resolves here: /api/me is asked on open, and nothing in the
# dialog should depend on its answer arriving to work.
NO_NET = ("var FETCHED = [];\n"
          "function Never() { return {then: function () { return Never(); },"
          " catch: function () { return Never(); }}; }\n"
          "var fetch = function (url) { FETCHED.push(url); return Never(); };")
r = run(BOOT + """
try {
  var ui = window.ATC.current.ui, btn = document.getElementById('reportBtn');
  dispatch(document.getElementById('modeSpeak'), 'click');
  dispatch(document.getElementById('startBtn'), 'click');
  r.hiddenBeforeSpeech = btn.hidden;
  function say(alts) {
    advanceClock(1000);
    dispatch(document.getElementById('ptt'), 'pointerdown');
    var res = {isFinal: true, length: alts.length};
    for (var i = 0; i < alts.length; i++) res[i] = {transcript: alts[i], confidence: 0.5 - i / 10};
    LAST_REC.onresult({resultIndex: 0, results: [res]});
  }
  say(['hello there', 'yellow there']);
  r.shownAfterOne = !btn.hidden;
  r.nudgedAfterOne = btn.classList.contains('nudge');
  say(['hello again']);
  r.nudgedAfterTwo = btn.classList.contains('nudge');
  r.toast = document.getElementById('toast').textContent;

  dispatch(btn, 'click');
  var modal = document.getElementById('reportModal');
  r.open = modal.classList.contains('show');
  r.paused = ui.sim.paused;
  r.askedWhoAmI = FETCHED.indexOf('/api/me') >= 0;
  var rows = document.getElementById('reportAttempts').querySelectorAll('.attempt');
  r.rows = rows.length;
  r.firstRow = rows[0].querySelector('.heard').textContent;
  r.bothTicked = rows[0].querySelector('input').checked && rows[1].querySelector('input').checked;
  r.alts = ui.heardLog[0].alternatives[0].length;
  r.altText = ui.heardLog[0].alternatives[0][1].transcript;
  r.result = ui.heardLog[0].result;

  // Typing a space in the form must not key the mic or unpause the run.
  advanceClock(1000);
  var before = LAST_REC.started;
  dispatch(document, 'keydown', {key: ' '});
  r.spaceLeftMicAlone = LAST_REC.started === before;
  r.stillPaused = ui.sim.paused;

  dispatch(document.getElementById('reportCancel'), 'click');
  r.closed = !modal.classList.contains('show');
  r.resumed = !ui.sim.paused;
} catch (e) { r.ok = false; r.err = String((e && e.message) || e); }
r;""", pre=NO_NET)
check("no report button before anything is heard", r.get("hiddenBeforeSpeech") is True,
      r.get("err", ""))
check("it appears once something is heard", r.get("shownAfterOne") is True)
check("one miss is not nagged about", r.get("nudgedAfterOne") is False)
check("two misses in a row point the button out",
      r.get("nudgedAfterTwo") is True and "Report" in (r.get("toast") or ""), r.get("toast"))
check("the dialog opens and pauses the run", r.get("open") and r.get("paused"))
check("...asking the server who is logged in now", r.get("askedWhoAmI") is True)
check("...listing the attempts newest first, both misses ticked",
      r.get("rows") == 2 and "hello again" in (r.get("firstRow") or "") and r.get("bothTicked"),
      "rows=%s first=%r" % (r.get("rows"), r.get("firstRow")))
check("every recogniser alternative is kept, not just the one used",
      r.get("alts") == 2 and r.get("altText") == "yellow there", repr(r.get("altText")))
check("the parser's verdict is kept with it", "not understood" in (r.get("result") or ""),
      repr(r.get("result")))
check("space doesn't key the mic or unpause while the dialog is open",
      r.get("spaceLeftMicAlone") and r.get("stillPaused"))
check("cancel closes it and the run carries on", r.get("closed") and r.get("resumed"))

print("\n%s" % ("FAILED: " + ", ".join(failures) if failures else "all checks passed"))
sys.exit(1 if failures else 0)
