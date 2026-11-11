package session

import "testing"

func TestParseCodexOutputStripsChrome(t *testing.T) {
	pane := "• The answer contains › in real text.\n\n⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n\n› Ask Codex to do anything\n  GPT-6.1-Sol medium · ~/project · Session title\n  ← for agents · ? for shortcuts"
	response, err := parseCodexOutput(pane)
	if err != nil {
		t.Fatal(err)
	}
	if response.Content != "• The answer contains › in real text." || response.Tool != "codex" {
		t.Fatalf("unexpected response: %+v", response)
	}
}
