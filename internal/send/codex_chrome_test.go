package send

import "testing"

func TestStripCodexChrome(t *testing.T) {
	footer := "\n  GPT-6.1-Sol medium · ~/project · Session title\n  ← for agents · ? for shortcuts                 ⚠ 7 warnings · f2 to view"
	for _, tc := range []struct{ name, pane, want string }{
		{"idle", "• Done.\n\n› Ask Codex to do anything" + footer, "• Done."},
		{"draft", "• Done.\n\n› Please check this\n  before sending" + footer, "• Done."},
		{"blank", "• Done.\n\n› " + footer, "• Done."},
		{"warning", "• Done.\n\n⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n\n› Ask Codex to do anything" + footer, "• Done."},
		{"wrapped warning", "• Done.\n\n⚠ Heads up, you have less than 25% of your weekly\n  limit left. Run /status for a breakdown.\n\n› Ask Codex to do anything" + footer, "• Done."},
		{"running", "• Checking the tests.\n\n◦ Working (6s • esc to interrupt)\n\n› Ask Codex to do anything" + footer, "• Checking the tests."},
		{"inline glyph", "• Use › in the example.\n\n› Ask Codex to do anything" + footer, "• Use › in the example."},
		{"transcript prompt", "› Explain the symbol\n\n• It means › here.\n\n› Draft" + footer, "› Explain the symbol\n\n• It means › here."},
		{"quoted prompt", "• Example:\n  › Ask Codex to do anything\n  GPT-6.1-Sol medium · ~/project · Example", "• Example:\n  › Ask Codex to do anything\n  GPT-6.1-Sol medium · ~/project · Example"},
		{"ambiguous glyph", "• Example:\n› keep this text\n  with a · separator", "• Example:\n› keep this text\n  with a · separator"},
		{"quoted warning", "• Example:\n  ⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.", "• Example:\n  ⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown."},
		{"plain conversation", "The docs mention GPT-6.1-Sol medium · ~/project.\n? for shortcuts is a hint.", "The docs mention GPT-6.1-Sol medium · ~/project.\n? for shortcuts is a hint."},
		{"warning without frame", "⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n  Keep this explanation.", "⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n  Keep this explanation."},
		{"ansi placeholder", "• Done.\n\n› \x1b[2mTry a different suggestion\x1b[0m" + footer, "• Done."},
		{"classic footer", "• Done.\n\n› draft\n\n  ? for shortcuts                       100% context left", "• Done."},
		{"placeholder in conversation", "• Example prompt:\n› Ask Codex to do anything", "• Example prompt:\n› Ask Codex to do anything"},
		{"quoted complete pane", "• Example:\n  › Ask Codex to do anything" + footer, "• Example:\n  › Ask Codex to do anything" + footer},
		{"hint in conversation", "• Example:\n  ? for shortcuts", "• Example:\n  ? for shortcuts"},
		{"running details", "• Checking the tests.\n\n◦ Working (6s • esc to interrupt)\n  └ tests are running\n\n› Ask Codex to do anything" + footer, "• Checking the tests."},
		{"warning continuation preserved", "• Done.\n\n⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n  Keep this explanation.\n\n› Ask Codex to do anything" + footer, "• Done.\n\n  Keep this explanation."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := StripCodexChrome(tc.pane); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
