# shadowlog: pattern-only built-in override logged as ignored

Offline reproduction for the shadow warning on pattern-only `[tools.<builtin>]` entries (follow-up to #3114).
It starts the real agent-deck TUI with `AGENTDECK_DEBUG=1` in a private tmux server and reads `debug.log`.
No agent, no model and no credentials are involved.

- `fixtures/pi.toml` is the pattern-only `[tools.pi]` entry from `../issue3098`. `MergeToolPatterns` applies it.
- `fixtures/hermes.toml` is a control. hermes has no built-in pattern defaults, so the entry is still ignored and must still warn. It proves the registry was built in the run.

Exit codes:

| Exit | Meaning |
|---|---|
| 0 | Healthy: `debug.log` has the shadow warning for hermes and none for pi |
| 1 | Defect: `debug.log` has the shadow warning for pi |
| 2 | Harness or setup error (no `debug.log`, or no warning for the control) |

## Run

The image is the one from `../issue3098` (Go image plus tmux and jq). Build each binary in a container, then run it through the repro runner (network disabled, fresh HOME, private tmux socket):

```sh
dir=cmd/agent-deck/testdata/shadowlog
out=$(mktemp -d)
docker build -t deck-repro-3098 cmd/agent-deck/testdata/issue3098
docker run --rm -v "$PWD:/src:ro" -v "$out:/out" -w /src -e GOFLAGS=-buildvcs=false \
  golang:1.26.10-bookworm go build -o /out/agent-deck ./cmd/agent-deck
python3 skills/agent-deck/scripts/repro/run.py --image deck-repro-3098 \
  --binary "$out/agent-deck" --script "$dir/repro.sh" --fixtures "$dir/fixtures" \
  --out "$out/run"
```

On `77fe2ec5` (before the fix) it exits 1. With the fix it exits 0.
