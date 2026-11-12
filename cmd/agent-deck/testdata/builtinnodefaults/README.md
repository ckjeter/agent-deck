# builtinnodefaults: busy pattern for a built-in without defaults

Offline reproduction for honoring `[tools.<name>]` pattern overrides on built-ins that have no built-in detection patterns (crush, hermes, aider). Follow-up to #3114.
It runs the real agent-deck binary against a fake crush that prints one busy marker and then sits still.
`fixtures/crush.toml` adds one `[tools.crush].busy_patterns` entry that matches that marker.
No real crush, no model and no credentials are involved.

- `repro.sh <agent-deck>` launches `agent-deck launch -c crush` and polls `agent-deck list --json` for the session status.
- `fixtures/bin/crush` prints `CRUSH_FIXTURE_BUSY generating a reply` and sleeps.

Exit codes:

| Exit | Meaning |
|---|---|
| 0 | Healthy: the busy marker is recognized and the session reads `running` |
| 1 | Defect: the busy marker is on screen and the session reads `waiting` or `idle` |
| 2 | Harness or setup error |

## Run

Build each binary in a container, then run it through the repro runner (network disabled, fresh HOME, private tmux socket):

```sh
dir=cmd/agent-deck/testdata/builtinnodefaults
out=$(mktemp -d)
docker build -t deck-repro-builtinnodefaults "$dir"
docker run --rm -v "$PWD:/src:ro" -v "$out:/out" -w /src -e GOFLAGS=-buildvcs=false \
  golang:1.26.10-bookworm go build -o /out/agent-deck ./cmd/agent-deck
python3 skills/agent-deck/scripts/repro/run.py --image deck-repro-builtinnodefaults \
  --binary "$out/agent-deck" --script "$dir/repro.sh" --fixtures "$dir/fixtures" \
  --out "$out/run"
```

On `77fe2ec5` (before the fix) it exits 1. With the fix it exits 0.
