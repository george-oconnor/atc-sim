"""ATC practice simulator — Flask shell.

The simulation itself runs entirely in the browser (static/js). This server
only: serves the pages, hands out scenario JSON, persists run results so you
can see whether you are actually improving, and (optionally) proxies pilot
readbacks to OpenAI's Realtime voice model so they sound like a real voice rather than the
browser's own speech synthesiser.
"""
import base64
import datetime
import functools
import hashlib
import hmac
import io
import json
import os
import random
import re
import secrets
import sqlite3
import time
import wave

import click
import sentry_sdk
import websocket
from flask import (Flask, Response, abort, flash, g, jsonify, redirect, render_template,
                   request, send_file, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
SCEN_DIR = os.path.join(BASE, "scenarios")
DB_PATH = os.path.join(BASE, "data", "atcsim.db")


def load_dotenv():
    """A minimal .env loader -- one more dependency (python-dotenv) felt
    like too much for one optional key. Real environment variables always
    win, so `export OPENAI_API_KEY=...` still overrides the file."""
    path = os.path.join(BASE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


load_dotenv()

# Optional, like the OpenAI key: no SENTRY_DSN, no error reporting. The
# Flask integration is picked up automatically once Flask is imported.
if os.environ.get("SENTRY_DSN"):
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        # Request headers and IP, so a report says which browser it was.
        send_default_pii=True,
    )

# Voices the Realtime model accepts. The newer ones, not the classic
# alloy/echo/..., which read every line in the same flat announcer tone.
TTS_VOICES = ("cedar", "marin", "ash", "coral", "verse", "sage", "ballad")
# OpenAI shuts off the plain /v1/audio/speech models on 2027-01-06; this is
# their named replacement. It is a conversational model on a WebSocket, so
# it has to be told firmly to recite rather than reply -- see below.
TTS_MODEL = "gpt-realtime-2.1-mini"
TTS_URL = "wss://api.openai.com/v1/realtime?model=" + TTS_MODEL
TTS_RATE = 24000          # Realtime audio is 24 kHz mono 16-bit PCM
TTS_SPEED = 1.1           # pilots talk a touch faster than conversation
TTS_TIMEOUT = 15
# Two jobs: make a chat model behave as a text-to-speech engine (a readback
# that gets paraphrased or "answered" is worse than useless for practice),
# and then make it sound like a pilot rather than an audiobook.
TTS_INSTRUCTIONS = (
    "You are a text-to-speech voice, not an assistant. Every message you "
    "receive is a script. Say the script aloud exactly as written, word for "
    "word: add nothing, leave nothing out, do not reorder, rephrase, expand "
    "or correct anything, and never reply to, answer, acknowledge or "
    "comment on it. Read numbers and letters exactly as the words given, "
    "e.g. 'one two zero' stays 'one two zero'.\n\n"
    "Delivery: you are an airline pilot reading back an air traffic "
    "control instruction over a VHF radio, with your hands busy flying. "
    "Brisk, natural working pace, relaxed, matter-of-fact and confident -- "
    "routine, never theatrical or announcer-like. Run the words together "
    "the way pilots do, no dramatic pauses, quick clear emphasis on the "
    "numbers, and let the callsign at the end drop slightly in pitch like "
    "a sign-off."
)


class TTSError(Exception):
    pass


def realtime_tts(api_key, text, voice):
    """Speak `text` with the Realtime model and return (pcm, transcript).

    One short-lived WebSocket per readback: configure the session, ask for
    a single out-of-band response (conversation "none", so no earlier
    readback can leak into this one), and collect the audio deltas until
    response.done."""
    try:
        ws = websocket.create_connection(
            TTS_URL, timeout=TTS_TIMEOUT,
            header=["Authorization: Bearer " + api_key])
    except websocket.WebSocketBadStatusException as exc:
        raise TTSError("upstream refused the connection: %s %s" % (
            exc.status_code, (exc.resp_body or b"").decode("utf-8", "ignore")))
    except (OSError, websocket.WebSocketException) as exc:
        raise TTSError("unreachable: %s" % exc)

    try:
        ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": TTS_INSTRUCTIONS,
                "output_modalities": ["audio"],
                "audio": {"output": {
                    "format": {"type": "audio/pcm", "rate": TTS_RATE},
                    "voice": voice,
                    "speed": TTS_SPEED,
                }},
            },
        }))
        ws.send(json.dumps({
            "type": "response.create",
            "response": {
                "conversation": "none",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }],
            },
        }))
        chunks, transcript = [], []
        while True:
            ev = json.loads(ws.recv())
            kind = ev.get("type")
            if kind == "response.output_audio.delta":
                chunks.append(base64.b64decode(ev["delta"]))
            elif kind == "response.output_audio_transcript.delta":
                transcript.append(ev.get("delta", ""))
            elif kind == "error":
                raise TTSError(json.dumps(ev.get("error", ev)))
            elif kind == "response.done":
                status = ev.get("response", {}).get("status")
                if status not in ("completed", None) and not chunks:
                    raise TTSError("response %s: %s" % (
                        status, json.dumps(ev["response"].get("status_details"))))
                break
    except (OSError, websocket.WebSocketException) as exc:
        raise TTSError("connection dropped: %s" % exc)
    finally:
        ws.close()

    if not chunks:
        raise TTSError("no audio returned")
    return b"".join(chunks), "".join(transcript)


def pcm_to_wav(pcm):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TTS_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _words(s):
    return re.findall(r"[a-z0-9]+", s.lower())


def _secret_key():
    """Signs the session cookie. SECRET_KEY must come from .env (or the
    environment) -- no quiet fallback, since a key made up on the spot
    would differ between gunicorn workers and change on every restart,
    logging everyone out."""
    key = os.environ.get("SECRET_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "SECRET_KEY is not set. Add it to .env -- make one with: "
            "python3 -c \"import secrets; print(secrets.token_hex(32))\"")
    return key


app = Flask(__name__)
# Debug is off in production, which also switches off Jinja's template
# auto-reload -- turn it back on so editing a template does not silently do
# nothing until the next restart.
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    # The public site is HTTPS only, and browsers treat http://127.0.0.1 as
    # secure too, so this only needs turning off for some other plain-HTTP
    # address.
    SESSION_COOKIE_SECURE=os.environ.get("ATC_INSECURE_COOKIES") != "1",
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=90),
    # A report's audio is a few seconds of compressed speech; nothing else
    # posted here comes anywhere near this.
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)


def _asset_version(filename):
    try:
        return int(os.path.getmtime(os.path.join(app.static_folder, filename)))
    except OSError:
        return 0


@app.context_processor
def _assets():
    """Static URLs carry the file's mtime, so a changed file is never served
    from a stale browser or CDN cache."""
    from flask import url_for

    def asset(filename):
        return url_for("static", filename=filename, v=_asset_version(filename))

    files = []
    for root, _dirs, names in os.walk(app.static_folder):
        for n in names:
            files.append(os.path.join(root, n))
    build = max((int(os.path.getmtime(f)) for f in files), default=0)
    return {"asset": asset, "build": build}


@app.template_filter("datetimeformat")
def datetimeformat(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%d %b %H:%M")


# ---------------------------------------------------------------- database
SCHEMA = """
CREATE TABLE IF NOT EXISTS run (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario     TEXT    NOT NULL,
    started_at   REAL    NOT NULL,
    finished_at  REAL    NOT NULL,
    score        INTEGER NOT NULL,
    handled      INTEGER NOT NULL,
    correct      INTEGER NOT NULL,
    losses       INTEGER NOT NULL,
    commands     INTEGER NOT NULL,
    detail       TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    REAL    NOT NULL,
    last_login_at REAL
);
-- A transcription problem reported from the sim: what the recogniser heard,
-- what was actually said, and optionally a recording of it said again.
CREATE TABLE IF NOT EXISTS report (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL REFERENCES account(id),
    created_at  REAL    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'open',
    said        TEXT    NOT NULL,
    heard       TEXT    NOT NULL,
    detail      TEXT    NOT NULL,
    audio       TEXT,
    audio_type  TEXT,
    note        TEXT    NOT NULL DEFAULT ''
);
-- Failed logins and new registrations, for throttling guessers and bots.
CREATE TABLE IF NOT EXISTS auth_event (
    kind      TEXT NOT NULL,
    ip        TEXT NOT NULL,
    email     TEXT NOT NULL,
    at        REAL NOT NULL
);
"""

# Columns added to an existing database after it was first created. A run
# belongs to an account, or -- flown without logging in -- to the browser
# that flew it (the `anon` cookie), until that browser logs in and claims it.
MIGRATIONS = [
    ("run", "account_id", "ALTER TABLE run ADD COLUMN account_id INTEGER"),
    ("run", "anon_id", "ALTER TABLE run ADD COLUMN anon_id TEXT"),
]
INDEXES = """
CREATE INDEX IF NOT EXISTS run_account ON run (account_id);
CREATE INDEX IF NOT EXISTS run_anon ON run (anon_id);
CREATE INDEX IF NOT EXISTS report_status ON report (status, created_at);
"""
_migrated = set()


def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        if not os.path.exists(DB_PATH):
            _migrated.discard(DB_PATH)      # deleted under us: build it afresh
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        if DB_PATH not in _migrated:
            g.db.executescript(SCHEMA)
            for table, column, sql in MIGRATIONS:
                have = {r["name"] for r in g.db.execute("PRAGMA table_info(%s)" % table)}
                if column not in have:
                    try:
                        g.db.execute(sql)
                    except sqlite3.OperationalError as exc:
                        # The other gunicorn worker added it first.
                        if "duplicate column" not in str(exc):
                            raise
            g.db.executescript(INDEXES)
            g.db.commit()
            _migrated.add(DB_PATH)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


# ---------------------------------------------------------------- accounts
# Logging in is optional: anyone can fly. An account keeps your progress
# across devices and lets you send transcription reports. Roles are ranked:
# a reviewer reads reports, an admin also manages accounts.
ROLES = ("user", "reviewer", "admin")
# Deliberately loose: something@somewhere.tld. With no mail sent, there is
# nothing to gain from being stricter than a typo check.
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
MAX_EMAIL = 254
MIN_PASSWORD = 8
ANON_COOKIE = "anon"
ANON_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")


def _pw_tag(password_hash):
    """Kept in the session beside the account id: changing or resetting the
    password changes it, which logs out every other session at once."""
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def _email(v):
    """Email addresses are compared without regard to case or stray spaces."""
    return (v or "").strip().lower()


def has_role(user, role):
    return user is not None and ROLES.index(user["role"]) >= ROLES.index(role)


@app.before_request
def _load_user():
    g.user = None
    uid = session.get("uid")
    if uid is None or request.endpoint == "static":
        return
    row = get_db().execute("SELECT * FROM account WHERE id = ?", (uid,)).fetchone()
    if row is None or session.get("pw") != _pw_tag(row["password_hash"]):
        session.pop("uid", None)
        session.pop("pw", None)
        return
    g.user = row


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


# Posted by pages that predate accounts, and by keepalive fetches that may
# outlive the page -- none of them act on an account's behalf beyond adding
# a run to its history.
CSRF_EXEMPT = {"api_run", "api_tts", "api_client_error"}


@app.before_request
def _check_csrf():
    if request.method != "POST" or request.endpoint in CSRF_EXEMPT:
        return
    sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token") or ""
    want = session.get("csrf") or ""
    if not want or not hmac.compare_digest(sent, want):
        if request.path.startswith("/api/"):
            return jsonify({"error": "session expired -- reload the page"}), 400
        flash("That form had expired -- please try again.", "err")
        rule = request.url_rule
        return redirect(request.full_path if rule is not None and "GET" in rule.methods
                        else url_for("index"))


@app.context_processor
def _account_context():
    me = g.get("user")
    return {
        "me": me,
        "csrf_token": csrf_token,
        "is_reviewer": has_role(me, "reviewer"),
        "is_admin": has_role(me, "admin"),
    }


def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None:
            if request.path.startswith("/api/"):
                return jsonify({"error": "login required"}), 401
            return redirect(url_for("login", next=request.full_path))
        return view(*args, **kwargs)
    return wrapped


def role_required(role):
    def deco(view):
        @functools.wraps(view)
        @login_required
        def wrapped(*args, **kwargs):
            if not has_role(g.user, role):
                abort(403)
            return view(*args, **kwargs)
        return wrapped
    return deco


def _safe_next(url):
    """Only ever redirect back into this site after logging in."""
    if url and url.startswith("/") and not url.startswith("//") and "\\" not in url:
        return url
    return url_for("index")


def client_ip():
    # Cloudflare sits in front of nginx, so the TCP peer is never the user.
    return request.headers.get("CF-Connecting-IP") or request.remote_addr or ""


def _recent_events(kind, window, ip=None, email=None):
    db = get_db()
    since = time.time() - window
    if email is not None:
        return db.execute("SELECT COUNT(*) FROM auth_event WHERE kind = ? AND at > ?"
                          " AND email = ? COLLATE NOCASE",
                          (kind, since, email)).fetchone()[0]
    return db.execute("SELECT COUNT(*) FROM auth_event WHERE kind = ? AND at > ? AND ip = ?",
                      (kind, since, ip)).fetchone()[0]


def _log_event(kind, email=""):
    db = get_db()
    now = time.time()
    db.execute("DELETE FROM auth_event WHERE at < ?", (now - 86400,))
    db.execute("INSERT INTO auth_event (kind, ip, email, at) VALUES (?,?,?,?)",
               (kind, client_ip(), email, now))
    db.commit()


def anon_id():
    v = request.cookies.get(ANON_COOKIE, "")
    return v if ANON_RE.fullmatch(v) else None


def runs_scope():
    """WHERE clause (and its parameters) for the runs this visitor may see."""
    if g.user is not None:
        return "account_id = ?", (g.user["id"],)
    aid = anon_id()
    if aid:
        return "account_id IS NULL AND anon_id = ?", (aid,)
    return "0", ()


def _start_session(row):
    """Log in as `row`, and claim the runs this browser flew logged out."""
    session["uid"] = row["id"]
    session["pw"] = _pw_tag(row["password_hash"])
    session.permanent = True
    db = get_db()
    db.execute("UPDATE account SET last_login_at = ? WHERE id = ?", (time.time(), row["id"]))
    aid = anon_id()
    if aid:
        db.execute("UPDATE run SET account_id = ?, anon_id = NULL"
                   " WHERE anon_id = ? AND account_id IS NULL", (row["id"], aid))
    db.commit()


@app.route("/register", methods=["GET", "POST"])
def register():
    nxt = _safe_next(request.values.get("next"))
    if g.user is not None:
        return redirect(nxt)
    error = None
    email = _email(request.form.get("email"))
    if request.method == "POST":
        password = request.form.get("password") or ""
        db = get_db()
        if _recent_events("register", 3600, ip=client_ip()) >= 5:
            error = "Too many new accounts from here in the last hour -- try again later."
        elif len(email) > MAX_EMAIL or not EMAIL_RE.fullmatch(email):
            error = "That doesn't look like an email address."
        elif len(password) < MIN_PASSWORD:
            error = "Passwords need at least %d characters." % MIN_PASSWORD
        elif password != request.form.get("password2"):
            error = "The two passwords don't match."
        elif db.execute("SELECT 1 FROM account WHERE email = ?", (email,)).fetchone():
            error = "There is already an account for that email address -- log in instead."
        else:
            db.execute("INSERT INTO account (email, password_hash, role, created_at)"
                       " VALUES (?,?,?,?)",
                       (email, generate_password_hash(password), "user", time.time()))
            db.commit()
            _log_event("register", email)
            row = db.execute("SELECT * FROM account WHERE email = ?", (email,)).fetchone()
            _start_session(row)
            return redirect(nxt)
    return render_template("register.html", error=error, email=email, next=nxt)


@app.route("/login", methods=["GET", "POST"])
def login():
    nxt = _safe_next(request.values.get("next"))
    if g.user is not None:
        return redirect(nxt)
    error = None
    email = _email(request.form.get("email"))
    if request.method == "POST":
        password = request.form.get("password") or ""
        if (_recent_events("login-fail", 900, ip=client_ip()) >= 20 or
                _recent_events("login-fail", 900, email=email) >= 10):
            error = "Too many failed attempts -- wait a few minutes and try again."
        else:
            row = get_db().execute("SELECT * FROM account WHERE email = ?",
                                   (email,)).fetchone()
            if row and check_password_hash(row["password_hash"], password):
                _start_session(row)
                return redirect(nxt)
            _log_event("login-fail", email)
            error = "Wrong email address or password."
    return render_template("login.html", error=error, email=email, next=nxt)


@app.route("/logout", methods=["POST"])
def logout():
    session.pop("uid", None)
    session.pop("pw", None)
    return redirect(url_for("index"))


@app.route("/account", methods=["GET", "POST"])
@login_required
def account():
    error = None
    if request.method == "POST":
        current = request.form.get("current") or ""
        new = request.form.get("password") or ""
        if not check_password_hash(g.user["password_hash"], current):
            error = "Your current password isn't right."
        elif len(new) < MIN_PASSWORD:
            error = "Passwords need at least %d characters." % MIN_PASSWORD
        elif new != request.form.get("password2"):
            error = "The two new passwords don't match."
        else:
            h = generate_password_hash(new)
            db = get_db()
            db.execute("UPDATE account SET password_hash = ? WHERE id = ?", (h, g.user["id"]))
            db.commit()
            session["pw"] = _pw_tag(h)     # stay logged in here; everywhere else is not
            flash("Password changed. Any other devices have been logged out.", "ok")
            return redirect(url_for("account"))
    n_runs = get_db().execute("SELECT COUNT(*) FROM run WHERE account_id = ?",
                              (g.user["id"],)).fetchone()[0]
    n_reports = get_db().execute("SELECT COUNT(*) FROM report WHERE account_id = ?",
                                 (g.user["id"],)).fetchone()[0]
    return render_template("account.html", error=error, n_runs=n_runs, n_reports=n_reports)


@app.route("/api/me")
def api_me():
    """Who is logged in, as the sim page sees it now -- someone may have
    logged in in another tab since the page loaded -- with a CSRF token
    to match the current session."""
    me = g.user
    return jsonify({"user": {"email": me["email"], "role": me["role"]} if me else None,
                    "csrf": csrf_token()})


# --------------------------------------------------------------- scenarios
# How many of an exercise's most recent scenarios to steer clear of when
# picking the next one at random (capped at half the pool).
RECENT = 12


def load_exercises():
    """The three exercises and the vetted scenarios in each one's pool
    (scenarios/<exercise>/<NN>.json, built by tools/build_pool.py). Read
    fresh every time, so rebuilding the pool needs no restart."""
    with open(os.path.join(SCEN_DIR, "exercises.json"), encoding="utf-8") as fh:
        ex = json.load(fh)
    for eid, meta in ex.items():
        meta["id"] = eid
        d = os.path.join(SCEN_DIR, eid)
        meta["variants"] = sorted(
            os.path.splitext(f)[0] for f in os.listdir(d) if f.endswith(".json")
        ) if os.path.isdir(d) else []
    return ex


def load_variant(eid, variant):
    """One scenario from the pool, without the auto-controller's answers."""
    if not re.fullmatch(r"\d{2,3}", variant or ""):
        return None
    path = os.path.join(SCEN_DIR, eid, variant + ".json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        scen = json.load(fh)
    scen.pop("solution", None)
    return scen


def pick_variant(eid, variants):
    """A random scenario, avoiding the ones served most recently -- a
    cookie remembers them, so a run of restarts never repeats too soon."""
    recent = request.cookies.get("recent_" + eid, "").split(".")
    keep = min(RECENT, len(variants) // 2)
    fresh = [v for v in variants if v not in recent[-keep:]] if keep else variants
    choice = random.choice(fresh or variants)
    recent = [v for v in recent if v and v != choice] + [choice]
    return choice, ".".join(recent[-RECENT:])


def generator_meta(meta):
    """What the browser-side generator needs to build a scenario."""
    return {k: v for k, v in meta.items() if k != "variants"}


# ------------------------------------------------------------------ routes
@app.route("/")
def index():
    exercises = sorted(load_exercises().values(), key=lambda s: s.get("order", 99))
    db = get_db()
    where, params = runs_scope()
    best = {
        r["scenario"]: r["b"]
        for r in db.execute("SELECT scenario, MAX(score) AS b FROM run WHERE " + where +
                            " GROUP BY scenario", params)
    }
    return render_template("index.html", exercises=exercises, best=best)


@app.route("/sim/<ex_id>")
def sim(ex_id):
    """/sim/ex1 picks a vetted scenario at random and redirects to it
    (?v=07), so reloading -- "Run again" -- flies the same one. ?random=1
    picks a fresh seed for the unlimited mode (?seed=N), which the browser
    generates itself."""
    exercises = load_exercises()
    if ex_id not in exercises:
        abort(404)
    meta = exercises[ex_id]
    seed = request.args.get("seed")
    if seed is not None:
        if not re.fullmatch(r"\d{1,9}", seed):
            abort(404)
        return render_template("sim.html", meta=meta, scenario=None,
                               generate={"meta": generator_meta(meta), "seed": int(seed)},
                               label="random · " + seed,
                               again=url_for("sim", ex_id=ex_id, random=1))
    v = request.args.get("v")
    if v is None:
        if request.args.get("random") or not meta["variants"]:
            return redirect(url_for("sim", ex_id=ex_id, seed=random.randrange(1, 10 ** 9)))
        v, recent = pick_variant(ex_id, meta["variants"])
        resp = redirect(url_for("sim", ex_id=ex_id, v=v))
        resp.set_cookie("recent_" + ex_id, recent, max_age=180 * 86400, samesite="Lax")
        return resp
    scen = load_variant(ex_id, v)
    if scen is None:
        abort(404)
    return render_template("sim.html", meta=meta, scenario=scen, generate=None,
                           label="#%s of %d" % (v, len(meta["variants"])),
                           again=url_for("sim", ex_id=ex_id))


@app.route("/api/scenario/<ex_id>")
@app.route("/api/scenario/<ex_id>/<variant>")
def api_scenario(ex_id, variant=None):
    exercises = load_exercises()
    if ex_id not in exercises or not exercises[ex_id]["variants"]:
        abort(404)
    scen = load_variant(ex_id, variant or random.choice(exercises[ex_id]["variants"]))
    if scen is None:
        abort(404)
    return jsonify(scen)


@app.route("/api/run", methods=["POST"])
def api_run():
    d = request.get_json(force=True)
    db = get_db()
    # Logged out, the run belongs to this browser until it logs in.
    new_anon = None
    if g.user is None and anon_id() is None:
        new_anon = secrets.token_urlsafe(24)
    cur = db.execute(
        "INSERT INTO run (scenario, started_at, finished_at, score, handled,"
        " correct, losses, commands, detail, account_id, anon_id)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (
            d["scenario"],
            d.get("started_at", time.time()),
            time.time(),
            int(d["score"]),
            int(d["handled"]),
            int(d["correct"]),
            int(d["losses"]),
            int(d.get("commands", 0)),
            json.dumps(d.get("detail", {})),
            g.user["id"] if g.user is not None else None,
            None if g.user is not None else (new_anon or anon_id()),
        ),
    )
    db.commit()
    resp = jsonify({"ok": True, "id": cur.lastrowid})
    if new_anon:
        resp.set_cookie(ANON_COOKIE, new_anon, max_age=2 * 365 * 86400,
                        samesite="Lax", httponly=True)
    return resp


@app.route("/api/tts", methods=["POST"])
def api_tts():
    """Proxy one pilot readback to OpenAI's TTS and hand back the audio.
    A key kept server-side, never shipped to the browser, is the whole
    reason this is a proxy rather than a direct client-side call."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return jsonify({"error": "not configured"}), 503

    d = request.get_json(force=True)
    text = (d.get("text") or "").strip()
    if not text:
        abort(400)
    voice = d.get("voice")
    if voice not in TTS_VOICES:
        voice = TTS_VOICES[0]

    try:
        pcm, said = realtime_tts(api_key, text, voice)
    except TTSError as exc:
        # Surfaced as-is (rather than a generic 502) so a bad/expired key
        # shows up as exactly that in the browser console, not a mystery.
        return jsonify({"error": "tts upstream error", "detail": str(exc)}), 502

    # The model is told to recite, but it is still a chat model -- leave a
    # trail in the log whenever it strays, so drift is visible, not guessed.
    if said and _words(said) != _words(text):
        app.logger.warning("tts readback drifted: asked %r, said %r", text, said)

    return Response(pcm_to_wav(pcm), mimetype="audio/wav")


@app.route("/api/client-error", methods=["POST"])
def api_client_error():
    """Problems only the browser can see -- a pilot voice that fell back to
    the robotic one, an uncaught exception -- relayed to the server log and
    Sentry, since nobody on a phone is reading a devtools console."""
    d = request.get_json(force=True, silent=True) or {}
    kind = str(d.get("kind") or "error")[:60]
    message = str(d.get("message") or "")[:500]
    detail = d.get("detail") if isinstance(d.get("detail"), dict) else {}
    app.logger.warning("client %s: %s %s", kind, message, json.dumps(detail)[:1000])
    with sentry_sdk.new_scope() as scope:
        scope.set_tag("source", "browser")
        scope.set_tag("kind", kind)
        scope.set_context("client", detail)
        scope.set_extra("page", d.get("page"))
        level = d.get("level") if d.get("level") in ("error", "warning", "info") else "error"
        sentry_sdk.capture_message("%s: %s" % (kind, message), level=level)
    return jsonify({"ok": True})


@app.route("/mic-test")
def mic_test():
    return render_template("mic_test.html")


@app.route("/phraseology")
def phraseology():
    return render_template("phraseology.html")


@app.route("/tutorial")
def tutorial():
    return render_template("tutorial.html")


@app.route("/progress")
def progress():
    db = get_db()
    runs = []
    where, params = runs_scope()
    for r in db.execute("SELECT * FROM run WHERE " + where +
                        " ORDER BY finished_at DESC LIMIT 100", params):
        r = dict(r)
        try:
            v = json.loads(r["detail"]).get("variant")
        except (ValueError, AttributeError):
            v = None
        r["variant"] = ("random" if str(v).startswith("seed") else "#" + v) if v else ""
        runs.append(r)
    names = {k: v.get("name", k) for k, v in load_exercises().items()}
    return render_template("progress.html", runs=runs, names=names)


# ------------------------------------------------------------------ reports
# What MediaRecorder produces: webm/opus in Chrome and Firefox, mp4/aac in
# Safari. Anything else is refused rather than stored as a mystery file.
AUDIO_TYPES = {
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a",
    "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3",
    "audio/wav": "wav", "audio/x-wav": "wav",
}
MAX_AUDIO = 5 * 1024 * 1024
REPORTS_PER_DAY = 50


def reports_dir():
    """Beside the database, so a test's throwaway database gets throwaway
    recordings too."""
    return os.path.join(os.path.dirname(DB_PATH), "reports")


def _text(v, n):
    return str(v if v is not None else "").strip()[:n]


def _clean_attempt(a):
    """One transmission as the sim saw it, cut down to known fields."""
    if not isinstance(a, dict):
        return None
    alts = []
    for alt in (a.get("alternatives") or [])[:6]:
        # One list per recognised phrase, each a list of its alternatives.
        if not isinstance(alt, list):
            continue
        row = []
        for x in alt[:10]:
            if isinstance(x, dict):
                try:
                    conf = round(float(x.get("confidence") or 0), 3)
                except (TypeError, ValueError):
                    conf = 0
                row.append({"transcript": _text(x.get("transcript"), 300), "confidence": conf})
        alts.append(row)
    return {
        "heard": _text(a.get("heard"), 500),
        "result": _text(a.get("result"), 300),
        "kind": _text(a.get("kind"), 10),
        "sim_t": a.get("sim_t") if isinstance(a.get("sim_t"), (int, float)) else None,
        "flagged": bool(a.get("flagged")),
        "alternatives": alts,
    }


@app.route("/api/report", methods=["POST"])
@login_required
def api_report():
    """A transcription problem, sent from the sim: the transmissions as
    recognised (with every alternative the recogniser offered), what was
    really said, and optionally a recording of it said again."""
    try:
        d = json.loads(request.form.get("payload") or "{}")
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return jsonify({"error": "bad report"}), 400
    attempts = [a for a in map(_clean_attempt, (d.get("attempts") or [])[:10]) if a]
    said = _text(d.get("said"), 500)
    if not said and not any(a["flagged"] for a in attempts):
        return jsonify({"error": "say what you actually said, or tick a transmission"}), 400

    db = get_db()
    today = db.execute("SELECT COUNT(*) FROM report WHERE account_id = ? AND created_at > ?",
                       (g.user["id"], time.time() - 86400)).fetchone()[0]
    if today >= REPORTS_PER_DAY:
        return jsonify({"error": "that's a lot of reports for one day -- try again tomorrow"}), 429

    audio = request.files.get("audio")
    data = mime = None
    if audio is not None:
        if d.get("consent") is not True:
            return jsonify({"error": "tick the box to agree to the recording being kept"}), 400
        mime = (audio.mimetype or "").split(";")[0].strip().lower()
        if mime not in AUDIO_TYPES:
            return jsonify({"error": "unsupported audio format " + mime}), 400
        data = audio.read(MAX_AUDIO + 1)
        if not data or len(data) > MAX_AUDIO:
            return jsonify({"error": "recording missing or too long"}), 400

    flagged = [a for a in attempts if a["flagged"]] or attempts
    heard = " | ".join(a["heard"] for a in flagged)[:2000]
    detail = {
        "attempts": attempts,
        "page": _text(d.get("page"), 200),
        "scenario": _text(d.get("scenario"), 60),
        "aircraft": [_text(c, 12) for c in (d.get("aircraft") or [])[:40]],
        "user_agent": _text(request.headers.get("User-Agent"), 300),
        "consent": bool(audio is not None and d.get("consent") is True),
    }
    cur = db.execute("INSERT INTO report (account_id, created_at, said, heard, detail)"
                     " VALUES (?,?,?,?,?)",
                     (g.user["id"], time.time(), said, heard, json.dumps(detail)))
    rid = cur.lastrowid
    if data is not None:
        os.makedirs(reports_dir(), exist_ok=True)
        name = "%d.%s" % (rid, AUDIO_TYPES[mime])
        with open(os.path.join(reports_dir(), name), "wb") as fh:
            fh.write(data)
        db.execute("UPDATE report SET audio = ?, audio_type = ? WHERE id = ?", (name, mime, rid))
    db.commit()
    return jsonify({"ok": True, "id": rid})


@app.route("/admin/reports")
@role_required("reviewer")
def admin_reports():
    status = request.args.get("status", "open")
    if status not in ("open", "resolved", "all"):
        status = "open"
    sql = ("SELECT report.*, account.email FROM report"
           " JOIN account ON account.id = report.account_id")
    params = ()
    if status != "all":
        sql += " WHERE status = ?"
        params = (status,)
    rows = get_db().execute(sql + " ORDER BY created_at DESC LIMIT 300", params).fetchall()
    counts = dict(get_db().execute("SELECT status, COUNT(*) FROM report GROUP BY status")
                  .fetchall())
    return render_template("admin_reports.html", reports=rows, status=status, counts=counts)


@app.route("/admin/reports/<int:rid>", methods=["GET", "POST"])
@role_required("reviewer")
def admin_report(rid):
    db = get_db()
    row = db.execute("SELECT report.*, account.email FROM report"
                     " JOIN account ON account.id = report.account_id"
                     " WHERE report.id = ?", (rid,)).fetchone()
    if row is None:
        abort(404)
    if request.method == "POST":
        status = request.form.get("status")
        if status not in ("open", "resolved"):
            status = row["status"]
        db.execute("UPDATE report SET status = ?, note = ? WHERE id = ?",
                   (status, _text(request.form.get("note"), 2000), rid))
        db.commit()
        flash("Report #%d saved." % rid, "ok")
        return redirect(url_for("admin_reports") if status == "resolved"
                        else url_for("admin_report", rid=rid))
    try:
        detail = json.loads(row["detail"])
    except ValueError:
        detail = {}
    return render_template("admin_report.html", r=row, detail=detail)


@app.route("/admin/reports/<int:rid>/audio")
@role_required("reviewer")
def admin_report_audio(rid):
    row = get_db().execute("SELECT audio, audio_type FROM report WHERE id = ?",
                           (rid,)).fetchone()
    if row is None or not row["audio"]:
        abort(404)
    path = os.path.join(reports_dir(), os.path.basename(row["audio"]))
    if not os.path.exists(path):
        abort(404)
    # conditional: Safari won't play audio from a server without Range support.
    return send_file(path, mimetype=row["audio_type"], conditional=True,
                     download_name="report-%d.%s" % (rid, row["audio"].rsplit(".", 1)[-1]))


@app.route("/admin/users", methods=["GET", "POST"])
@role_required("admin")
def admin_users():
    db = get_db()
    if request.method == "POST":
        target = db.execute("SELECT * FROM account WHERE id = ?",
                            (request.form.get("id", type=int),)).fetchone()
        action = request.form.get("action")
        if target is None:
            abort(404)
        if target["id"] == g.user["id"]:
            # Demoting yourself by accident leaves nobody to undo it.
            flash("You can't change your own account here -- use Account.", "err")
        elif action == "role" and request.form.get("role") in ROLES:
            db.execute("UPDATE account SET role = ? WHERE id = ?",
                       (request.form["role"], target["id"]))
            db.commit()
            flash("%s is now %s." % (target["email"], request.form["role"]), "ok")
        elif action == "reset":
            temp = secrets.token_urlsafe(9)
            db.execute("UPDATE account SET password_hash = ? WHERE id = ?",
                       (generate_password_hash(temp), target["id"]))
            db.commit()
            flash("New password for %s: %s -- pass it on; they can change it under "
                  "Account. They have been logged out everywhere." % (target["email"], temp),
                  "ok")
        return redirect(url_for("admin_users"))
    users = db.execute(
        "SELECT account.*,"
        " (SELECT COUNT(*) FROM run WHERE run.account_id = account.id) AS n_runs,"
        " (SELECT COUNT(*) FROM report WHERE report.account_id = account.id) AS n_reports"
        " FROM account ORDER BY created_at DESC").fetchall()
    return render_template("admin_users.html", users=users, roles=ROLES)


@app.cli.command("make-admin")
@click.argument("email")
@click.option("--claim-old-runs", is_flag=True,
              help="Also give this account every run recorded before accounts existed.")
def make_admin(email, claim_old_runs):
    """Promote an existing account to admin (register it on the site first)."""
    with app.app_context():
        db = get_db()
        row = db.execute("SELECT * FROM account WHERE email = ?", (_email(email),)).fetchone()
        if row is None:
            raise click.ClickException("no account %r -- register it on the site first" % email)
        db.execute("UPDATE account SET role = 'admin' WHERE id = ?", (row["id"],))
        n = 0
        if claim_old_runs:
            n = db.execute("UPDATE run SET account_id = ?"
                           " WHERE account_id IS NULL AND anon_id IS NULL",
                           (row["id"],)).rowcount
        db.commit()
        click.echo("%s is now an admin%s." % (
            row["email"], " and owns %d older runs" % n if claim_old_runs else ""))


if __name__ == "__main__":
    # Bound to localhost by default: reach it over an SSH tunnel rather than
    # exposing it. ATC_DEBUG=1 enables the Werkzeug debugger, which is remote
    # code execution for anyone who can reach the port -- never with ATC_HOST
    # set to anything but 127.0.0.1.
    app.run(
        host=os.environ.get("ATC_HOST", "127.0.0.1"),
        port=int(os.environ.get("ATC_PORT", "5000")),
        debug=os.environ.get("ATC_DEBUG") == "1",
    )
