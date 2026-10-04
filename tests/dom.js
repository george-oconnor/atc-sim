/* A small DOM, built from the real template, with enough selector matching
 * and event bubbling to run the page's own code against it. Good enough to
 * prove that the selectors in the JS match the markup the server sends. */
var EVT = [];

function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

function Node(tag, attrs) {
  var self = this;
  this.tag = String(tag).toLowerCase();
  this.attrs = attrs || {};
  this.children = [];
  this.parent = null;
  this.id = this.attrs.id || '';
  this.classes = (this.attrs['class'] || '').split(/\s+/).filter(Boolean);
  this.dataset = {};
  this.style = {};
  this.value = '';
  this.checked = false;
  this.hidden = 'hidden' in this.attrs;
  this.disabled = 'disabled' in this.attrs;
  this.textContent = this.attrs.__text || '';
  this.innerHTML = '';
  this.title = '';
  this.scrollLeft = 0;
  this.scrollWidth = 400;
  this.listeners = {};
  // className must stay in step with the list the selectors match against.
  Object.defineProperty(this, 'className', {
    get: function () { return self.classes.join(' '); },
    set: function (v) { self.classes = String(v).split(/\s+/).filter(Boolean); }
  });
  Object.defineProperty(this, 'lastChild', {
    get: function () { return self.children[self.children.length - 1] || null; }
  });
  Object.defineProperty(this, 'firstChild', {
    get: function () { return self.children[0] || null; }
  });
  for (var k in this.attrs) {
    if (k.indexOf('data-') === 0) this.dataset[camel(k.slice(5))] = this.attrs[k];
  }
  this.classList = {
    contains: function (c) { return self.classes.indexOf(c) >= 0; },
    add: function (c) { if (self.classes.indexOf(c) < 0) self.classes.push(c); },
    remove: function (c) {
      var i = self.classes.indexOf(c); if (i >= 0) self.classes.splice(i, 1);
    },
    toggle: function (c, force) {
      var on = force === undefined ? self.classes.indexOf(c) < 0 : !!force;
      if (on) self.classList.add(c); else self.classList.remove(c);
      return on;
    }
  };
}

Object.defineProperty(Node.prototype, 'innerHTML', {
  get: function () { return this._html || ''; },
  set: function (v) { this._html = v; if (v === '') this.children = []; }
});

// Like the real thing, adding a node that is already in the tree moves it.
Node.prototype.appendChild = function (c) {
  if (c.parent) c.parent.removeChild(c);
  c.parent = this; this.children.push(c); return c;
};
Node.prototype.insertBefore = function (c, ref) {
  if (c.parent) c.parent.removeChild(c);
  var i = ref ? this.children.indexOf(ref) : -1;
  c.parent = this;
  if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
  return c;
};
Node.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c);
  if (i >= 0) { this.children.splice(i, 1); c.parent = null; }
  return c;
};
Node.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
Node.prototype.getAttribute = function (k) { return this.attrs[k]; };
Node.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
Node.prototype.focus = function () {};
Node.prototype.getBoundingClientRect = function () {
  return { width: 1035, height: 900, left: 0, top: 0 };
};
Node.prototype.getContext = function () {
  var n = function () { return c; };
  var c = { setTransform: n, fillRect: n, clearRect: n, strokeRect: n, beginPath: n,
    moveTo: n, lineTo: n, closePath: n, stroke: n, fill: n, arc: n, fillText: n,
    setLineDash: n, measureText: function () { return { width: 10 }; } };
  return c;
};
Node.prototype.addEventListener = function (ev, fn) {
  (this.listeners[ev] = this.listeners[ev] || []).push(fn);
};
Node.prototype.removeEventListener = function (ev, fn) {
  if (!this.listeners[ev]) return;
  this.listeners[ev] = this.listeners[ev].filter(function (f) { return f !== fn; });
};

/* ---- selector matching: tags, .class, #id, [attr] / [attr="value"], and
   descendants ---- */
function matchSimple(node, sel) {
  var parts = sel.match(/([.#][\w-]+|\[[\w-]+(?:=["'][^"']*["'])?\]|[a-zA-Z][\w-]*)/g) || [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.charAt(0) === '.') { if (node.classes.indexOf(p.slice(1)) < 0) return false; }
    else if (p.charAt(0) === '#') { if (node.id !== p.slice(1)) return false; }
    else if (p.charAt(0) === '[') {
      var inner = p.slice(1, -1);
      var eq = inner.indexOf('=');
      if (eq < 0) { if (!(inner in node.attrs)) return false; }
      else {
        var attr = inner.slice(0, eq);
        var val = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (node.attrs[attr] !== val) return false;
      }
    }
    else if (node.tag !== p.toLowerCase()) return false;
  }
  return parts.length > 0;
}

function matchSel(node, sel) {
  var steps = sel.trim().split(/\s+(?![^\[]*\])/);
  if (!matchSimple(node, steps[steps.length - 1])) return false;
  var n = node.parent, i = steps.length - 2;
  while (i >= 0) {
    if (!n) return false;
    if (matchSimple(n, steps[i])) i--;
    n = n.parent;
  }
  return true;
}

function walk(node, fn) {
  for (var i = 0; i < node.children.length; i++) { fn(node.children[i]); walk(node.children[i], fn); }
}

Node.prototype.querySelectorAll = function (sel) {
  var out = [];
  walk(this, function (n) { if (matchSel(n, sel)) out.push(n); });
  return out;
};
Node.prototype.querySelector = function (sel) {
  return this.querySelectorAll(sel)[0] || null;
};
Node.prototype.closest = function (sel) {
  var n = this;
  while (n) { if (matchSel(n, sel)) return n; n = n.parent; }
  return null;
};

/* ---- the document ---- */
var ROOT = null;

function buildTree(spec, parent) {
  var n = new Node(spec.tag, spec.attrs);
  n.textContent = spec.text || '';
  if (parent) parent.appendChild(n);
  for (var i = 0; i < (spec.children || []).length; i++) buildTree(spec.children[i], n);
  return n;
}

var document = {
  readyState: 'complete',
  getElementById: function (id) {
    var found = null;
    walk(ROOT, function (n) { if (!found && n.id === id) found = n; });
    return found;
  },
  querySelector: function (sel) { return ROOT.querySelector(sel); },
  querySelectorAll: function (sel) { return ROOT.querySelectorAll(sel); },
  createElement: function (t) { return new Node(t, {}); },
  listeners: {},
  addEventListener: function (ev, fn) {
    if (ev === 'DOMContentLoaded') document.__ready = fn;
    (document.listeners[ev] = document.listeners[ev] || []).push(fn);
  },
  removeEventListener: function (ev, fn) {
    if (!document.listeners[ev]) return;
    document.listeners[ev] = document.listeners[ev].filter(function (f) { return f !== fn; });
  }
};

/** Dispatch an event at `node` and let it bubble, as a browser would. */
function domReady() {
  var fns = document.listeners['DOMContentLoaded'] || [];
  for (var i = 0; i < fns.length; i++) fns[i]({});
}

function dispatch(node, type, extra) {
  var ev = { type: type, target: node, preventDefault: function () {},
             stopped: false, stopPropagation: function () { this.stopped = true; },
             key: (extra && extra.key) || '', code: (extra && extra.code) || '',
             repeat: !!(extra && extra.repeat),
             clientY: (extra && extra.clientY) || 0, clientX: (extra && extra.clientX) || 0,
             pointerId: (extra && extra.pointerId) || 0, deltaY: (extra && extra.deltaY) || 0 };
  // Dispatching directly on `document` (a plain object, not part of any
  // node's .parent chain) must not also fall through to the document-level
  // block below -- that would fire every document listener twice.
  if (node === document) {
    var dfns0 = document.listeners[type] || [];
    for (var k = 0; k < dfns0.length; k++) dfns0[k](ev);
    return ev;
  }
  var n = node;
  while (n && !ev.stopped) {
    var fns = n.listeners[type] || [];
    for (var i = 0; i < fns.length; i++) fns[i](ev);
    n = n.parent;
  }
  if (ev.stopped) return ev;
  var dfns = document.listeners[type] || [];
  for (var j = 0; j < dfns.length; j++) dfns[j](ev);
  return ev;
}

var store = {};
var localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); }
};

var LAST_REC = null;
function FakeSR() { LAST_REC = this; this.started = false; }
// Real SpeechRecognition throws InvalidStateError from start() if it thinks
// it's already running -- exactly the case priming/a warm-up retry racing
// against a real start() needs to be tested against.
FakeSR.prototype.start = function () {
  if (this.started) throw new Error('InvalidStateError: already started');
  this.started = true;
};
FakeSR.prototype.stop = function () { this.started = false; if (this.onend) this.onend(); };

var window = {
  addEventListener: function () {},
  devicePixelRatio: 1,
  SpeechRecognition: FakeSR,
  localStorage: localStorage
};
var console = { log: function () {}, warn: function () {}, error: function () {} };
// A controllable clock, not the real one: real elapsed time in one of these
// scripts is a few milliseconds regardless of how many dispatches it makes,
// which would make anything debounced by wall-clock time (the push-to-talk
// button/space handler) look identical to a single rapid double-fire.
// Tests call advanceClock() between dispatches that represent a genuinely
// later, separate press.
var FAKE_NOW = 1700000000000;
var Date = { now: function () { return FAKE_NOW; } };
function advanceClock(ms) { FAKE_NOW += ms; }
var performance = { now: function () { return Date.now(); } };
var frames = 0;
function requestAnimationFrame(fn) { if (frames++ < 3) fn(performance.now()); }
// Controllable timers: tests fire pending callbacks with runTimers()
// rather than racing a real clock, and clearTimeout genuinely cancels --
// that cancellation is exactly what the speech watchdog depends on.
var TIMERS = [], TIMER_ID = 1;
function setTimeout(fn, ms) {
  var id = TIMER_ID++;
  TIMERS.push({ id: id, fn: fn, at: FAKE_NOW + (ms || 0) });
  return id;
}
function clearTimeout(id) {
  TIMERS = TIMERS.filter(function (t) { return t.id !== id; });
}
function runTimers(within) {
  // Only timers due within the next `within` ms of the fake clock (default
  // 2s) fire, so one call covers the speech watchdog (1.5s) and restart
  // (250ms) without also tripping the 8s idle auto-stop -- tests reach
  // that one deliberately, with advanceClock() first.
  var limit = FAKE_NOW + (within === undefined ? 2000 : within);
  var due = TIMERS.filter(function (t) { return t.at <= limit; });
  TIMERS = TIMERS.filter(function (t) { return t.at > limit; });
  due.forEach(function (t) { t.fn(); });
}
