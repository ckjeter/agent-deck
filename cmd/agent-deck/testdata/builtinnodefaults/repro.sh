#!/bin/sh
# Reproduction: a [tools.crush] busy_patterns entry is ignored because crush has no
# built-in detection patterns, so a crush pane that shows only that busy marker is
# never reported as running.
#
# $1: agent-deck binary under test. Fixtures: /fixtures/bin/crush (fake crush that
# prints CRUSH_FIXTURE_BUSY and then sits still) and /fixtures/crush.toml (the
# [tools.crush] busy pattern that matches it).
#
# Exit 0: the busy marker is recognized, status is running (healthy).
# Exit 1: the busy marker is on screen and status is waiting or idle (the defect).
# Exit 2: anything else (harness or setup error).
set -u
bin="$1"
root=/work/probe
sock=crush-repro

mkdir -p "$root/project" "$XDG_CONFIG_HOME/agent-deck" || exit 2
{ printf '[tmux]\nsocket_name = "%s"\n\n' "$sock"; cat /fixtures/crush.toml; } \
  > "$XDG_CONFIG_HOME/agent-deck/config.toml" || exit 2
export PATH="/fixtures/bin:/usr/local/bin:/usr/bin:/bin" AGENTDECK_SKIP_UPDATE_CHECK=1
command -v crush >/dev/null || { echo 'HARNESS: fake crush not on PATH'; exit 2; }
command -v tmux >/dev/null || { echo 'HARNESS: tmux missing'; exit 2; }
command -v jq >/dev/null || { echo 'HARNESS: jq missing'; exit 2; }

echo '--- config.toml'
cat "$XDG_CONFIG_HOME/agent-deck/config.toml"

rc=0
timeout 25 "$bin" launch -c crush -t busy-probe --json "$root/project" \
  > "$root/launch.json" 2> "$root/launch.stderr" || rc=$?
echo "--- launch exit: $rc"
echo '--- launch.json'; cat "$root/launch.json"
echo '--- launch.stderr'; cat "$root/launch.stderr"

status=
for i in 1 2 3 4 5 6 7 8; do
  sleep 2
  "$bin" list --json > "$root/list.json" 2>> "$root/list.stderr" || continue
  status=$(jq -r '[.[] | select(.title == "busy-probe")][0].status // empty' "$root/list.json" 2>/dev/null)
  echo "poll $i: status=$status"
done
tmux -L "$sock" capture-pane -p > "$root/pane.txt" 2>/dev/null || : > "$root/pane.txt"
tmux -L "$sock" kill-server 2>/dev/null

echo '--- list.json'; cat "$root/list.json"
echo '--- pane'; cat "$root/pane.txt"

marker=$(grep -c CRUSH_FIXTURE_BUSY "$root/pane.txt")
if [ "$rc" -ne 0 ] || [ "$marker" -lt 1 ]; then
  echo "HARNESS: unexpected setup (rc=$rc marker=$marker)"
  exit 2
fi
case "$status" in
  running) echo 'HEALTHY: busy marker recognized, status running'; exit 0 ;;
  waiting|idle) echo "DEFECT: busy marker on screen, status $status"; exit 1 ;;
esac
echo "HARNESS: unexpected status '$status'"
exit 2
