#!/usr/bin/env python3
"""
Fitness Tracker — native desktop wrapper.

Launches the local Neural NeXus Node server, waits for it to come up, and opens
the /fitness page in a native pywebview window (no browser, no login). The server
is started with FITNESS_DESKTOP_AUTH=1 so the localhost connection auto-authenticates.

The Node server reads .env (via dotenv), so put ANTHROPIC_API_KEY there to enable
Claude photo analysis.

Env overrides:
  FITNESS_REPO       repo root containing server.js (default: parent of this file)
  FITNESS_NODE_BIN   path to the node binary (default: auto-detected)
  FITNESS_DESKTOP_PORT  preferred local port (default: 4199; falls back to a free one)
"""

import os
import sys
import time
import shutil
import socket
import pathlib
import subprocess
import urllib.request

try:
    import webview  # pywebview
except ImportError:
    sys.stderr.write(
        "pywebview is not installed. Install it with:\n"
        "    python3 -m pip install --user pywebview\n"
    )
    sys.exit(1)

REPO = pathlib.Path(os.environ.get("FITNESS_REPO", pathlib.Path(__file__).resolve().parent.parent))
PREFERRED_PORT = int(os.environ.get("FITNESS_DESKTOP_PORT", "4199"))
LOG_FILE = pathlib.Path(os.path.expanduser("~/Library/Logs/FitnessTracker.log"))


def pick_port(preferred):
    """Use the preferred port if free, else an OS-assigned free port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", preferred))
        s.close()
        return preferred
    except OSError:
        s.close()
        s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s2.bind(("127.0.0.1", 0))
        port = s2.getsockname()[1]
        s2.close()
        return port


def find_node():
    # A Finder-launched .app gets a minimal PATH (no Homebrew), so shutil.which()
    # usually fails — build_app.sh bakes FITNESS_NODE_BIN, and we also probe common
    # install locations incl. version-pinned Homebrew kegs (e.g. node@22).
    import glob
    candidates = [
        os.environ.get("FITNESS_NODE_BIN"),
        shutil.which("node"),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/opt/node/bin/node",
    ]
    candidates += sorted(glob.glob("/opt/homebrew/opt/node@*/bin/node"), reverse=True)
    candidates += sorted(glob.glob("/usr/local/opt/node@*/bin/node"), reverse=True)
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def wait_for_server(health_url, proc, timeout=40):
    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            return False  # node exited early
        try:
            urllib.request.urlopen(health_url, timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def error_window(message):
    safe = message.replace("<", "&lt;").replace(">", "&gt;")
    html = (
        "<body style='background:#06060b;color:#f0f0f5;font-family:system-ui;"
        "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
        "<div style='max-width:480px;padding:24px;text-align:center'>"
        "<h2 style='color:#f87171'>Fitness Tracker couldn't start</h2>"
        f"<p style='color:rgba(255,255,255,0.7);line-height:1.5'>{safe}</p></div></body>"
    )
    webview.create_window("Fitness Tracker", html=html, width=560, height=360)
    webview.start()


def main():
    server_js = REPO / "server.js"
    if not server_js.exists():
        error_window(f"server.js not found in {REPO}. Set FITNESS_REPO to the repo root.")
        return

    node = find_node()
    if not node:
        error_window("Node.js was not found. Install Node, or set FITNESS_NODE_BIN to its path.")
        return

    port = pick_port(PREFERRED_PORT)
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["FITNESS_DESKTOP_AUTH"] = "1"          # localhost auto-auth for the desktop app
    env.setdefault("NODE_ENV", "production")

    # Log node's output to a file so failures are diagnosable (not /dev/null).
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        logf = open(LOG_FILE, "a", buffering=1)
        logf.write(f"\n--- Fitness Tracker start: node={node} port={port} repo={REPO} ---\n")
    except Exception:
        logf = subprocess.DEVNULL

    proc = subprocess.Popen(
        [node, "server.js"],
        cwd=str(REPO),
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
    )

    if not wait_for_server(f"http://127.0.0.1:{port}/", proc, timeout=40):
        try:
            proc.terminate()
        except Exception:
            pass
        error_window(f"The local server didn't come up in time. Check {LOG_FILE} and that dependencies are installed (npm install).")
        return

    webview.create_window(
        "Fitness Tracker",
        f"http://127.0.0.1:{port}/fitness",
        width=1200,
        height=900,
        min_size=(380, 600),
    )
    try:
        webview.start()
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == "__main__":
    main()
