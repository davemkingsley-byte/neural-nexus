#!/bin/bash
# Build a double-clickable "Fitness Tracker.app" that launches the local server
# and opens the fitness UI in a native pywebview window.
#
# Usage:
#   bash desktop/build_app.sh            # installs to ~/Applications
#   APP_DEST="/some/dir" bash desktop/build_app.sh
#
# Re-run after moving the repo (the .app stores an absolute path to it).
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
APP_DEST="${APP_DEST:-$HOME/Applications}"
APP_NAME="Fitness Tracker"
APP="$APP_DEST/$APP_NAME.app"

echo "Repo:        $REPO_DIR"
echo "Installing:  $APP"

# --- resolve a python3 that has pywebview ----------------------------------
# Preference order: the app's own venv → any system python3 that already has
# pywebview → create a self-contained venv (no changes to your global Python).
VENV="$DESKTOP_DIR/.venv"
PYTHON=""
if [ -x "$VENV/bin/python3" ] && "$VENV/bin/python3" -c "import webview" >/dev/null 2>&1; then
  PYTHON="$VENV/bin/python3"
fi
if [ -z "$PYTHON" ]; then
  for cand in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import webview" >/dev/null 2>&1; then
      PYTHON="$cand"; break
    fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "pywebview not found — creating a self-contained venv at $VENV ..."
  BASEPY="$(command -v python3 || echo /usr/bin/python3)"
  "$BASEPY" -m venv "$VENV"
  "$VENV/bin/python3" -m pip install --quiet --upgrade pip
  "$VENV/bin/python3" -m pip install --quiet pywebview
  PYTHON="$VENV/bin/python3"
fi
if ! "$PYTHON" -c "import webview" >/dev/null 2>&1; then
  echo "ERROR: could not make pywebview available (tried venv at $VENV)." >&2
  exit 1
fi
echo "Python:      $PYTHON"

# --- detect node now (GUI-launched .app won't have the shell PATH) ----------
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for n in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@*/bin/node /usr/local/opt/node@*/bin/node; do
    [ -x "$n" ] && { NODE_BIN="$n"; break; }
  done
fi
if [ -n "$NODE_BIN" ]; then echo "Node:        $NODE_BIN"; else
  echo "WARNING: node not found at build time; the app will probe for it at runtime."
fi

# --- (re)create the bundle --------------------------------------------------
mkdir -p "$APP_DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>FitnessTracker</string>
  <key>CFBundleIdentifier</key><string>press.neuralnexus.fitness</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Launcher: pins the repo path + python chosen at build time.
cat > "$APP/Contents/MacOS/FitnessTracker" <<LAUNCH
#!/bin/bash
export FITNESS_REPO="$REPO_DIR"
export FITNESS_NODE_BIN="$NODE_BIN"
exec "$PYTHON" "$REPO_DIR/desktop/fitness_app.py" "\$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/FitnessTracker"

# Optional icon (drop an AppIcon.icns in desktop/ to use it)
if [ -f "$DESKTOP_DIR/AppIcon.icns" ]; then
  cp "$DESKTOP_DIR/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$APP/Contents/Info.plist" 2>/dev/null || true
fi

echo ""
echo "✓ Built $APP"
echo "  Open it from ~/Applications (or: open \"$APP\")."
echo "  For Claude photo analysis, put ANTHROPIC_API_KEY in $REPO_DIR/.env"
