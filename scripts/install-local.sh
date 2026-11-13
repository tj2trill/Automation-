#!/usr/bin/env bash
# Install or update the self-hosted automaton host on this Linux machine.
#
#   bash install-local.sh            # install, or update and restart
#   bash install-local.sh --no-phone # keep the dashboard on this machine only
#
# Run it as your normal user, not with sudo. It is safe to run again: your
# agents, ledger, keys and settings live in ~/.automaton-host and are never
# replaced.
#
# What it does:
#   1. Checks Docker (usable without sudo) and Node.js 20+.
#   2. Unpacks the source next to this script into ~/automaton and builds it.
#   3. Creates the host config, the agent network and the agent image.
#   4. Asks once for your Anthropic API key (or uses Ollama only) and stores
#      it in ~/.automaton-host/env, readable by you alone.
#   5. Opens the dashboard to your phone and prints a QR code.
#   6. Installs a user service so the host starts at boot and restarts if it
#      stops, an `automaton-host` command, and a desktop launcher.

set -euo pipefail

INSTALL_DIR="${AUTOMATON_DIR:-$HOME/automaton}"
STATE_DIR="${AUTOMATON_HOST_DIR:-$HOME/.automaton-host}"
ENV_FILE="$STATE_DIR/env"
SERVICE_NAME="automaton-host"
SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
BIN_DIR="$HOME/.local/bin"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$HERE/automaton-src.tar.gz"
PNPM_VERSION="10.28.1"

PHONE=1
for arg in "$@"; do
  case "$arg" in
    --no-phone) PHONE=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not root or sudo. The service and files belong to you."

# ── 1. Prerequisites ─────────────────────────────────────────────
step "Checking Docker and Node.js"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Engine, then run this again."
if ! docker info >/dev/null 2>&1; then
  if id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    fail "Docker is installed but not responding. Start it with: sudo systemctl enable --now docker"
  fi
  fail "your user cannot use Docker without sudo. Run: sudo usermod -aG docker $USER
Then log out and back in (or reboot), and run this again."
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "Node.js is not installed. Install Node.js 20 or newer, then run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $("$NODE_BIN" -v) is too old. Install Node.js 20 or newer."
# The service runs without your shell's PATH, so it is given node's real location.
NODE_BIN="$(readlink -f "$NODE_BIN")"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes "pnpm@$PNPM_VERSION")
fi
echo "Docker $(docker version --format '{{.Server.Version}}'), Node.js $("$NODE_BIN" -v)"

# ── 2. Source and build ──────────────────────────────────────────
step "Installing the source into $INSTALL_DIR"
[ -f "$BUNDLE" ] || fail "automaton-src.tar.gz must be in the same folder as this script ($HERE)."
mkdir -p "$INSTALL_DIR"
# Unpack over the previous version. Build output is cleared so no stale file survives.
rm -rf "$INSTALL_DIR/dist"
tar -xzf "$BUNDLE" -C "$INSTALL_DIR"
cd "$INSTALL_DIR"

step "Installing dependencies and building (a few minutes the first time)"
"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" build
CLI=("$NODE_BIN" "$INSTALL_DIR/dist/host/cli.js")

# ── 3. Host config, network, agent image ─────────────────────────
step "Creating the host config and agent network"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
"${CLI[@]}" init

step "Building the agent image (several minutes the first time, quick after)"
"${CLI[@]}" build-image

# ── 4. Model access ──────────────────────────────────────────────
step "Model access"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE" || grep -q '^OPENAI_API_KEY=.\+' "$ENV_FILE"; then
  echo "Using the API key already stored in $ENV_FILE."
elif [ -t 0 ]; then
  echo "Agents use Claude through your Anthropic API key, charged to your Anthropic account."
  echo "Paste it now (input is hidden), or press Enter to use local Ollama models only."
  read -r -s -p "ANTHROPIC_API_KEY: " KEY || KEY=""
  echo
  if [ -n "$KEY" ]; then
    # Written without echoing it to the terminal or putting it on a command line.
    printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
    unset KEY
    echo "Stored in $ENV_FILE (readable by you only)."
  fi
else
  echo "No API key stored and no terminal to ask. Add ANTHROPIC_API_KEY=... to $ENV_FILE later."
fi

if command -v ollama >/dev/null 2>&1; then
  OLLAMA_MODEL="$("$NODE_BIN" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const m = c.models.find((m) => m.upstream === "ollama");
    if (m) process.stdout.write(m.id);' "$STATE_DIR/host.json")"
  if [ -n "$OLLAMA_MODEL" ]; then
    echo "Fetching the local fallback model $OLLAMA_MODEL with Ollama (skipped if present)."
    ollama pull "$OLLAMA_MODEL" || echo "Could not fetch $OLLAMA_MODEL. Agents will run, but without the local fallback."
  fi
else
  echo "Ollama is not installed: agents have no local fallback when your balance runs low."
fi

if ! grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE" && ! grep -q '^OPENAI_API_KEY=.\+' "$ENV_FILE" && ! command -v ollama >/dev/null 2>&1; then
  echo "Warning: no API key and no Ollama. The host will run, but agents will have no model to think with."
fi

# ── 5. Phone ─────────────────────────────────────────────────────
if [ "$PHONE" -eq 1 ]; then
  step "Opening the dashboard to your phone"
  "${CLI[@]}" phone || echo "Phone access was not set up. Run 'automaton-host phone' once this machine is on Wi-Fi or Tailscale."
else
  "${CLI[@]}" phone --off >/dev/null
fi

# ── 6. Command, service, launcher ────────────────────────────────
step "Installing the automaton-host command and the background service"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/automaton-host" <<EOF
#!/bin/sh
# Runs the host command line installed in $INSTALL_DIR.
set -a; [ -f "$ENV_FILE" ] && . "$ENV_FILE"; set +a
exec "$NODE_BIN" "$INSTALL_DIR/dist/host/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/automaton-host"

cat > "$INSTALL_DIR/open-dashboard.sh" <<EOF
#!/bin/sh
# Opens the dashboard, signed in, in the default browser.
url=\$("$NODE_BIN" "$INSTALL_DIR/dist/host/cli.js" dashboard | head -n 1)
exec xdg-open "\$url"
EOF
chmod 755 "$INSTALL_DIR/open-dashboard.sh"

mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/automaton.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Automaton
Comment=Dashboard for your self-hosted agents
Exec=$INSTALL_DIR/open-dashboard.sh
Icon=$INSTALL_DIR/dist/host/dashboard/icon-512.png
Terminal=false
Categories=Development;
EOF

DOCKER_DIR="$(dirname "$(readlink -f "$(command -v docker)")")"
mkdir -p "$(dirname "$SERVICE_FILE")"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Automaton host (control plane and dashboard)
Documentation=file://$INSTALL_DIR/docs/self-hosted.md

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=PATH=$(dirname "$NODE_BIN"):$DOCKER_DIR:/usr/local/bin:/usr/bin:/bin
Environment=AUTOMATON_HOST_DIR=$STATE_DIR
EnvironmentFile=-$ENV_FILE
# A user service cannot be ordered after the system's docker.service, so at
# boot it waits for the Docker daemon to answer, up to two minutes. If Docker
# never comes up the start fails and the failure is logged.
ExecStartPre=/bin/sh -c 'i=0; until docker info >/dev/null 2>&1; do i=\$((i+1)); [ \$i -ge 60 ] && echo "Docker did not start" >&2 && exit 1; sleep 2; done'
ExecStart=$NODE_BIN $INSTALL_DIR/dist/host/cli.js serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME.service" >/dev/null
  systemctl --user restart "$SERVICE_NAME.service"
  # Start at boot, before anyone logs in. Needs permission on some systems.
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'yes'; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "Note: the host starts when you log in. For start at boot without logging in, run: sudo loginctl enable-linger $USER"
  fi
  sleep 3
  if systemctl --user is-active --quiet "$SERVICE_NAME.service"; then
    echo "Service running. Logs: journalctl --user -u $SERVICE_NAME -f"
  else
    journalctl --user -u "$SERVICE_NAME" -n 30 --no-pager || true
    fail "the service did not start. The log above says why."
  fi
else
  echo "No user systemd session here. Start the host by hand with: automaton-host serve"
fi

step "Done"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to your PATH to use the automaton-host command." ;; esac
echo "Dashboard on this machine: open 'Automaton' from your applications menu."
[ "$PHONE" -eq 1 ] && echo "On your iPhone: scan the QR code above, open it in Safari, then Share > Add to Home Screen."
echo "Launch your first agent from the dashboard, or: automaton-host launch --name scout --genesis \"...\" --fund 5"
echo "Before adding real money, check the model prices in $STATE_DIR/host.json."
