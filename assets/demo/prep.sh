#!/usr/bin/env bash
# Builds a throwaway repolith workspace at /root/demo and a 2-pane tmux session "demo".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/demo"
tmux kill-server 2>/dev/null || true
[ -d "$D" ] && rm -r --force "$D"
mkdir -p "$D/app/src"
cp "$HERE/panerc.sh" "$HERE/demo.tmux.conf" "$D/"
cat > "$D/repolith.toml" <<'TOML'
[workspace]
name = "acme"

[[repos]]
name = "app"
url  = "https://github.com/acme/app.git"
path = "app"
ref  = "main"
TOML
cd "$D/app"
git init -q -b main
git config user.email demo@example.com; git config user.name demo
cat > src/auth.ts <<'TS'
export async function login(user: string, pass: string) {
  const session = await verify(user, pass);
  return issueToken(session);
}
TS
git add -A && git commit -qm "init"
cd "$D"
repolith hooks install --post-commit >/dev/null
tmux -f "$D/demo.tmux.conf" new-session -d -s demo -x 220 -y 50 "SESSION=A bash --rcfile $D/panerc.sh"
tmux split-window -h -t demo "SESSION=B bash --rcfile $D/panerc.sh"
tmux select-pane -t demo:0.0 -T " Claude Code · session A "
tmux select-pane -t demo:0.1 -T " Claude Code · session B "
tmux select-pane -t demo:0.0
