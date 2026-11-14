#!/usr/bin/env bash
# Installs the self-hosted automaton host into ~/automaton.
#   bash ~/Downloads/install-automaton.sh
# Safe to run again: it updates the code and rebuilds. It never uses sudo
# itself; if something system-wide is missing it tells you the command.
set -euo pipefail

DEST="${AUTOMATON_DIR:-$HOME/automaton}"
REPO="https://github.com/tj2trill/Automation-.git"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARBALL="$HERE/automaton-src.tar.gz"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 Checking what this machine has"
missing=0
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js: missing (need 20 or newer)"; missing=1
else
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then echo "  Node.js: $(node -v), too old (need 20 or newer)"; missing=1
  else echo "  Node.js: $(node -v)"; fi
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "  Docker: missing"; missing=1
elif ! docker info >/dev/null 2>&1; then
  echo "  Docker: installed, but this user can't reach it (daemon off, or you're not in the docker group)"; missing=1
else
  echo "  Docker: $(docker --version | cut -d, -f1)"
fi
if [ "$missing" -ne 0 ]; then
  cat <<'EOF'

Install what's missing, then run this script again. On Ubuntu/Debian:

  Node.js 22:
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs

  Docker:
    sudo apt-get install -y docker.io
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"     # then log out and back in

EOF
  exit 1
fi

say "2/6 Getting the code into $DEST"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
elif command -v git >/dev/null 2>&1 && git clone "$REPO" "$DEST" 2>/dev/null; then
  echo "  cloned from GitHub (update later with: git -C $DEST pull)"
elif [ -f "$TARBALL" ]; then
  [ -e "$DEST" ] && fail "$DEST exists and isn't a git checkout; move it aside and run again."
  mkdir -p "$(dirname "$DEST")"
  tar -xzf "$TARBALL" -C "$(dirname "$DEST")"
  [ "$(basename "$DEST")" = automaton ] || mv "$(dirname "$DEST")/automaton" "$DEST"
  echo "  unpacked from $TARBALL"
else
  fail "Couldn't clone $REPO and no $TARBALL next to this script."
fi
cd "$DEST"

say "3/6 Installing pnpm and dependencies"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1 && corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    npm install -g pnpm@10 --prefix "$HOME/.local" >/dev/null
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
pnpm install --frozen-lockfile

say "4/6 Building"
pnpm build

say "5/6 Setting up the host (~/.automaton-host)"
if [ -f "$HOME/.automaton-host/host.json" ]; then
  echo "  already set up; leaving host.json as it is"
else
  node dist/host/cli.js init
fi

say "6/6 Building the agent container image (a few minutes the first time)"
node dist/host/cli.js build-image

cat <<EOF

Installed in $DEST.

Before adding real money:
  1. Edit ~/.automaton-host/host.json: set each model's id and its real
     price per million tokens (the defaults are placeholders).
  2. Give it a model key:  export ANTHROPIC_API_KEY=...   (or OPENAI_API_KEY)

Then:
  cd $DEST
  node dist/host/cli.js selftest
  node dist/host/cli.js serve          # leave running; prints the dashboard link
  node dist/host/cli.js launch --name scout --genesis "Earn money." --fund 5   # in another terminal
EOF
