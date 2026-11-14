#!/bin/sh
# Reproduction for the shadow warning on pattern-only built-in overrides (follow-up to #3114).
# A [tools.pi] entry with only prompt_patterns_extra is applied by MergeToolPatterns,
# but the tool registry still logs it as "ignored custom tool: name shadows a built-in".
#
# $1: agent-deck binary under test. Fixtures: /fixtures/pi.toml (pattern-only [tools.pi])
# and /fixtures/hermes.toml (control: hermes has no pattern defaults, so it must still warn).
# The TUI runs with AGENTDECK_DEBUG=1 in a private tmux server and writes debug.log.
#
# Exit 0: debug.log has the hermes warning and none for pi (healthy).
# Exit 1: debug.log has the shadow warning for pi (the defect).
# Exit 2: anything else (no debug.log, no control warning, harness or setup error).
set -u
bin="$1"
sock=shadow-repro
outer=shadow-outer
msg='ignored custom tool: name shadows a built-in'

mkdir -p "$XDG_CONFIG_HOME/agent-deck" || exit 2
{ printf '[tmux]\nsocket_name = "%s"\n\n' "$sock"; cat /fixtures/pi.toml; echo; cat /fixtures/hermes.toml; } \
  > "$XDG_CONFIG_HOME/agent-deck/config.toml" || exit 2
export PATH="/usr/local/bin:/usr/bin:/bin" AGENTDECK_SKIP_UPDATE_CHECK=1 TERM=xterm-256color
command -v tmux >/dev/null || { echo 'HARNESS: tmux missing'; exit 2; }

echo '--- config.toml'
cat "$XDG_CONFIG_HOME/agent-deck/config.toml"

tmux -L "$outer" new-session -d -x 160 -y 48 -s tui \
  "env DO_NOT_TRACK=1 AGENTDECK_DEBUG=1 AGENT_DECK_ALLOW_OUTER_TMUX=1 AGENTDECK_SKIP_UPDATE_CHECK=1 HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_DATA_HOME=$XDG_DATA_HOME XDG_CACHE_HOME=$XDG_CACHE_HOME XDG_STATE_HOME=$XDG_STATE_HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR TMUX_TMPDIR=$TMUX_TMPDIR $bin; sleep 30" \
  || { echo 'HARNESS: could not start the TUI'; exit 2; }
findlog() { find "$XDG_CACHE_HOME" "$HOME" -name debug.log 2>/dev/null | head -n 1; }
i=0
while [ "$i" -lt 20 ] && ! grep -q "$msg" "$(findlog)" 2>/dev/null; do sleep 1; i=$((i + 1)); done
sleep 3
tmux -L "$outer" capture-pane -p -t tui > /work/pane.txt 2>/dev/null || : > /work/pane.txt
tmux -L "$outer" kill-server 2>/dev/null
tmux -L "$sock" kill-server 2>/dev/null

echo '--- pane'; cat /work/pane.txt
log=$(findlog)
echo "--- debug.log: ${log:-missing}"
echo '--- shadow warnings in debug.log'
grep "$msg" "$log" 2>/dev/null

[ -n "$log" ] && [ -s "$log" ] || { echo 'HARNESS: debug.log missing or empty'; exit 2; }
pi=$(grep "$msg" "$log" | grep -c '"name":"pi"')
hermes=$(grep "$msg" "$log" | grep -c '"name":"hermes"')

if [ "$pi" -ge 1 ]; then
  echo "DEFECT: pattern-only [tools.pi] logged as ignored (pi=$pi hermes=$hermes)"
  exit 1
fi
if [ "$hermes" -ge 1 ]; then
  echo "HEALTHY: registry built, hermes control warned, no warning for pattern-only pi (hermes=$hermes)"
  exit 0
fi
echo "HARNESS: registry warning path not observed (pi=$pi hermes=$hermes)"
exit 2
