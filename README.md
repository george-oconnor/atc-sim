# ATC assessment centre practice

A practice simulator for the Air Traffic Controller assessment centre, built to
the preparation material: a corridor of controlled airspace, aircraft that only
do what you tell them, and three exercises of increasing traffic.

Try it at **https://atc-sim.georgeoc.com** -- no account needed.

The simulation runs entirely in the browser. The Flask app serves the pages
and the scenario pools, and keeps optional accounts and run history in SQLite.

This is an independent practice tool. It is not affiliated with or endorsed
by any air navigation service provider or assessment provider.

## Running it locally

Developed and tested on Python 3.14.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Put a `SECRET_KEY` in `.env` -- the app will not start without it:

```sh
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Then:

```sh
./run.sh                 # http://127.0.0.1:5000, localhost only
```

`.env` also takes an optional `OPENAI_API_KEY` for natural-sounding pilot
voices (see "Pilot voices" below) and an optional `SENTRY_DSN` for error
tracking. `app.py` loads it on startup, the same way whether you run it with
`run.sh` or under gunicorn; a real exported variable takes priority over the
file. Changes under `static/`, `scenarios/` and `templates/` need no restart,
just a page reload.

## Accounts

Logging in is optional -- anyone who finds the address can fly. Registration is
open (email address and password). Nothing is emailed yet, so there is no
self-service password reset, and addresses aren't verified. An
account keeps your progress across devices; without one, runs belong to the
browser that flew them (an `anon` cookie) and move into an account when that
browser registers or logs in. Only logged-in users can send transcription
reports.

Roles, ranked: `user`, `reviewer` (reads reports at `/admin/reports`) and
`admin` (also `/admin/users`: change roles, reset a forgotten password). Make
the first admin from the command line once the account is registered:

```sh
.venv/bin/flask --app app make-admin you@example.com --claim-old-runs
```

`--claim-old-runs` hands that account every run recorded before accounts
existed. The session cookie is signed with `SECRET_KEY`. Failed logins are
throttled per address and per IP.

## What it models

Straight from the preparation material:

| | |
|---|---|
| Separation | 1,000 ft vertically **or** 3 NM laterally |
| Airspace | a corridor with lateral walls and unlimited vertical extent |
| Traffic | AAL (American), DAL (Delta), UAL (United) only |
| Instructions | turn left/right onto a heading, climb to a FL, descend to a FL |
| Label | callsign, current FL, cleared FL, exit FL, speed, leader line, history dots |
| Objective | stay inside the corridor, stay separated, leave at the exit flight level |

The leader line is a one-minute speed vector, so a faster aircraft has a longer
line, exactly as described.

**There is no speed instruction and no direct-to-fix**, because the assessment
does not have them. You turn aircraft and you move them up and down. That is it.

## The exercises

| | Aircraft | Length | What it is |
|---|---|---|---|
| Exercise 1 | 4–6 | 16 min | Straight corridor. One or two conflicts, two or three exit-level changes. Ask the assessor as often as you like. |
| Exercise 2 | 8–10 | 19 min | The corridor bends 30–65° left or right. Nothing turns unless you turn it, plus three or four conflicts and a level-change trap. |
| Exercise 3 | 11–14 | 21 min | Two corridors crossing at 60–120°. Four to six conflicts, most of them at the junction, and one or two traps. |

None of them is fixed. Each exercise has a pool of 25 vetted scenarios, and
pressing an exercise picks one at random, avoiding the last twelve you were
given (a cookie remembers them). The corridor points a different way each
time, the bend and the crossing change angle, and the traffic -- callsigns,
levels, speeds, directions, timings and which pairs conflict -- is different
in every one. The header shows which one you have ("#07 of 25"); **Run
again** flies the same one, **New scenario** picks another.

If you ever know all 75, **Unlimited random** on the front page builds a
brand-new scenario in the browser from a random seed, with exactly the same
checks as the pool (below). The seed is in the address, so reloading it flies
the same one again.

A *trap* is a pair that is safely separated as they come in, where one of
them has to finish on the other's level: fine once they have passed, a loss
if you clear it the moment it appears.

## Talking to aircraft

Type into the box at the bottom right, or press the microphone and say it
(Chrome and Edge only). In **Phraseology** mode your transmission is marked the
way the assessors mark it:

```
American four five one, turn right heading zero seven zero
Delta six six, climb to flight level two eight zero
United eight seven, descend to flight level two seven zero
Correction, United eight seven, descend to flight level two six zero
```

Sloppy transmissions are still actioned, then faulted, so you find out what was
wrong without losing the aircraft. It catches:

- the airline code instead of the name ("AAL451" rather than "American four five one")
- numbers run together ("seventy" rather than "zero seven zero", "two eighty" rather than "two eight zero")
- a missing turn direction, or the long way round when the short way was available
- "climb" when the aircraft is above the level you gave it
- a missing "heading" or "flight level"

### Speaking it

Press **Speak** and the words appear as you say them. While the recogniser is
still revising a word it shows dim and italic; once it commits, the word lights
up and takes its colour:

| | |
|---|---|
| white, bold | the callsign |
| green | turn, climb, descend, heading, flight level, correction |
| amber | every digit |
| grey | words that are not part of standard phraseology |

That last row is the useful one -- filler like "er", "please" or "for" shows up
grey, which is how you notice you are padding your transmissions. The strip
scrolls to keep the newest word in view, and when the transmission is sent the
underline goes green (clean), amber (understood but faulted) or red (rejected).

The same strip is on the phraseology drill, which is the better place to
practise speaking.

### Reporting a mis-hearing

When the recogniser keeps getting something wrong, **⚑ Report mis-hearing**
(next to the mic, once anything has been heard; it lights up after two misses
in a row) sends the last few transmissions -- each with every alternative the
recogniser offered, and what the parser made of it -- plus what you actually
said. You can also record yourself saying it again, with a consent box. It is
a re-take, not the original: the browser's recogniser never exposes its audio,
and recording alongside it is what breaks recognition on phones, so nothing is
recorded while you fly. Recordings are kept in `data/reports/`.

### Pilot voices

Every instruction that is actioned gets read back out loud, one aircraft at a
time like a real frequency, so you hear "American four five one, turn left
heading zero seven zero" rather than only reading it in the log.

Without any setup this uses the browser's own speech synthesiser, which
works everywhere but sounds synthetic. Set `OPENAI_API_KEY` in the
environment that runs the server (see below) and it calls OpenAI's TTS
instead, which sounds like an actual voice; if that call fails for any
reason -- no key, a bad key, no network -- it falls back to the browser
voice for that run rather than going silent. The **pilot voices** checkbox
mutes either one.

### Collapsing panels

Each panel on the right -- brief, traffic, R/T -- collapses by clicking its
heading, and remembers whether it was collapsed. Worth doing on a phone, where
the brief otherwise eats the radar's space.

**Quick keys** mode drops all of that for drilling speed: `AAL451 R070`,
`DAL66 C280`, `UAL87 D270`.

`/` jumps to the box, space pauses, click selects an aircraft, scroll zooms,
drag pans. On a touchscreen: tap selects, one finger drags to pan, two
fingers pinch to zoom.

**Phraseology drill** (linked from the front page) fires random prompts at you
and grades them with the same parser, which is the cheapest way to get the
wording automatic before the day.

## Scoring

| | |
|---|---|
| Left at its exit flight level | +100 |
| Left at the wrong level | −40 |
| Outside the corridor walls | −60 per excursion |
| Never recovered / left backwards | −80 |
| Loss of separation | −150 per pair |
| Phraseology fault | −5 each |

The debrief at the end lists what went well and what to work on, and every run
is stored, so `/progress` shows whether you are actually getting better.

## Layout

```
app.py                  Flask: pages, scenario pools, run history (SQLite),
                        accounts, transcription reports
run.sh                  run it by hand on 127.0.0.1:5000
scenarios/exercises.json  what each exercise is: layout, ranges, timings
scenarios/ex1..3/*.json the vetted pools, generated
static/js/geo.js        navigation and corridor geometry
static/js/speech.js     phraseology parsing and marking
static/js/aircraft.js   flight model
static/js/sim.js        clock, separation, airspace, scoring
static/js/gen.js        scenario generator, checks and auto-controller
static/js/radar.js      the radar display
static/js/ui.js         strips, R/T log, transmissions, debrief
static/js/voice.js      speech input and the live transcript strip
static/js/feedback.js   the "report mis-hearing" dialog and its re-take recorder
static/js/drill.js      the phraseology drill
tools/build_pool.py     build the pools
tools/sheet.py          draw a pool (or fresh seeds) as a sheet of maps
tests/test_sim.py       runs the real JS headlessly against the real scenarios
tests/dom.js            a small DOM with real selector matching and bubbling
tests/test_browser.py   boots the DOM-facing files against the real markup
tests/chrome.py         a tiny headless-Chromium driver
tests/test_chrome.py    the exercises flown end to end in Chromium
tests/fixtures/         the original three exercises, as fixed test data
```

## How scenarios are made, and checked

`static/js/gen.js` builds a scenario from a seed: it lays the corridor out at
a random orientation, places the designed conflicts and traps (head-on,
overtaking, and at the junction in Exercise 3) at spaced-out times, then adds
background traffic that does not conflict at its own level, and finally
gives some aircraft exit levels to reach. The exercise's ranges (aircraft,
conflicts, traps, level changes, reaction time) are in
`scenarios/exercises.json`.

Before a scenario is accepted it has to pass two things.

**Nothing silly.** Every aircraft appears inside the corridor, at least 3 NM
off the wall and at least 5 NM from anything else on the scope; every
conflict leaves at least 2–2½ minutes between the second aircraft appearing
and the loss; no three conflicts inside one minute; everyone can make its
level change and is out before the clock runs out; the scope is never empty
for more than a minute; no aircraft starts sitting on the bend; and callsigns
are distinct, with no flight number a prefix of another on the same airline
(AAL45 next to AAL451 is one dropped word from the wrong aircraft).

**It can be flown clean.** An automatic controller flies it through the real
simulator, knowing only what you can see: nothing is touched for its first
15 seconds on the scope, there is at most one transmission every six
seconds, and every transmission goes through the real phraseology checker.
It must finish with no losses, every aircraft out at its exit level, nobody
outside the walls and no phraseology faults. Its transmissions are stored
with each pooled scenario as `solution` (the server strips them before the
page) and the tests replay them.

To rebuild the pool (it replaces scenarios/ex1..3/):

```sh
.venv/bin/python tools/build_pool.py            # all three, 25 each
.venv/bin/python tools/build_pool.py ex2 30     # one exercise, 30
```

To look at a pool, or at fresh seeds, as a sheet of maps (corridors, every
track, red rings where the conflicts are and amber where the traps are),
with the app running locally:

```sh
.venv/bin/python tools/sheet.py pool ex3 /tmp/ex3.png
.venv/bin/python tools/sheet.py seeds ex1 /tmp/ex1.png 1 24
```

## Tests

```sh
.venv/bin/python tests/test_sim.py       # engine, generator, every pooled scenario, routes
.venv/bin/python tests/test_browser.py   # the page's scripts against the real markup
.venv/bin/python tests/test_chrome.py    # end to end in headless Chromium
```

`test_sim.py` loads the real JavaScript into an embedded engine. It checks
the generator is deterministic per seed, then takes every pooled scenario
and re-runs the generator's checks on it, replays its stored solution
through the simulator (must be clean), and flies it with nobody at the
controls (must go wrong). It also covers the phraseology marking, conflict
prediction and the Flask routes -- with a throwaway database, never your
run history. The original three hand-built exercises live on in
`tests/fixtures/` as fixed data for the phraseology checks.

`test_chrome.py` does the same flying in a real browser: every pooled
solution replayed in V8, one scenario per exercise flown through the actual
page and keyboard path to the debrief, and the unlimited mode building and
flying its own scenarios. It uses the Chromium that Playwright keeps in
`~/.cache/ms-playwright`, and skips if there isn't one.

## Copyright

Copyright (c) 2026 George O'Connor. All rights reserved. The source is
published so it can be read; no licence to reuse it is granted.
