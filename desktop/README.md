# Fitness Tracker — desktop app

A native macOS app that wraps the fitness tracker so you launch it like any other
app instead of opening a browser to a URL. It starts the local Node server, opens
the `/fitness` page in its own window, and auto-logs-in (no password prompt). The
window closes → the server shuts down.

It uses your **local** data (`data/fitness.db` + `data/fitness-photos/`) and your
local `.env`, so it's fully self-contained and works offline (except for Claude
photo analysis and external food lookups, which need the network).

## One-time setup

```bash
# 1. Node deps (if not already installed)
npm install

# 2. pywebview for the desktop shell
python3 -m pip install --user pywebview     # or: pip install -r desktop/requirements.txt

# 3. (optional) enable Claude photo analysis
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env

# 4. build the app into ~/Applications
bash desktop/build_app.sh
```

Then open **Fitness Tracker** from `~/Applications` (or `open ~/Applications/"Fitness Tracker.app"`).

## Notes

- **Run it without building:** `python3 desktop/fitness_app.py`
- The `.app` stores an absolute path to this repo. If you move the repo, re-run
  `bash desktop/build_app.sh`.
- Vision provider defaults to **Claude** (`claude-sonnet-4-6`). Override the model
  with `FITNESS_ANTHROPIC_MODEL=claude-opus-4-8`, or use a local model with
  `FITNESS_VISION_PROVIDER=ollama`. Put any of these in `.env`.
- Auto-login works because the launcher sets `FITNESS_DESKTOP_AUTH=1` and connects
  from localhost; the server only honors that flag for `127.0.0.1`/`::1`, and it is
  never set in production.
- Optional icon: drop `desktop/AppIcon.icns` before building and it'll be used.

## Env overrides

| Variable | Default | Purpose |
|----------|---------|---------|
| `FITNESS_REPO` | repo root | where `server.js` lives |
| `FITNESS_NODE_BIN` | auto-detected | path to the `node` binary |
| `FITNESS_DESKTOP_PORT` | `4199` | preferred local port (falls back to a free one) |
