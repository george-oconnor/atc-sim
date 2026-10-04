"""A very small headless-Chrome driver over the DevTools protocol.

Enough to load a page, run JavaScript in it and take a screenshot -- the
browser tests use it to fly scenarios in a real engine, and it renders the
pool contact sheets. Uses the Chromium that Playwright leaves in
~/.cache/ms-playwright, and websocket-client, which the app already needs.
"""
import base64
import glob
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

import websocket


def find_chrome():
    pats = ["~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/"
            "chrome-headless-shell",
            "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome"]
    for p in pats:
        hits = sorted(glob.glob(os.path.expanduser(p)))
        if hits:
            return hits[-1]
    for name in ("chromium", "chromium-browser", "google-chrome"):
        if shutil.which(name):
            return shutil.which(name)
    return None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Chrome:
    def __init__(self, width=1280, height=800):
        exe = find_chrome()
        if not exe:
            raise RuntimeError("no Chromium found")
        self.port = free_port()
        self.profile = tempfile.mkdtemp(prefix="atc-chrome-")
        self.proc = subprocess.Popen(
            [exe, "--headless", "--no-sandbox", "--disable-gpu", "--mute-audio",
             "--remote-debugging-port=%d" % self.port, "--remote-allow-origins=*",
             "--user-data-dir=" + self.profile,
             "--window-size=%d,%d" % (width, height), "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json" % self.port, timeout=1))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("Chromium did not start")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120,
                                                 suppress_origin=True)
        self.n = 0
        self.errors = []
        self.call("Runtime.enable")
        self.call("Page.enable")
        self.call("Emulation.setDeviceMetricsOverride", width=width, height=height,
                  deviceScaleFactor=1, mobile=False)

    def call(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                self.errors.append((d.get("exception") or {}).get("description") or d.get("text"))
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    def goto(self, url, wait=0.5):
        self.call("Page.navigate", url=url)
        for _ in range(200):
            if self.eval("document.readyState") == "complete":
                break
            time.sleep(0.05)
        time.sleep(wait)

    def eval(self, expr, await_promise=False):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise)
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError((d.get("exception") or {}).get("description") or d.get("text"))
        return r["result"].get("value")

    def screenshot(self, path):
        data = self.call("Page.captureScreenshot", format="png")["data"]
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data))

    def close(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            shutil.rmtree(self.profile, ignore_errors=True)
