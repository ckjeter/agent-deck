package send

import (
	"regexp"
	"strings"

	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

var codexModelFooterRe = regexp.MustCompile(`(?i)^  (?:gpt[-a-z0-9.]*|codex[-a-z0-9.]*|o[0-9][-a-z0-9.]*)(?: [a-z]+)? · [~/]`)
var codexLimitWarningRe = regexp.MustCompile(`^⚠ Heads up, you have less than \d+% of your .+ limit left\. Run /status for a breakdown\.$`)

// StripCodexChrome cleans pane-derived Codex output. Require a composer and
// footer before removing banners, so ordinary response text stays intact.
func StripCodexChrome(content string) string {
	plain := tmux.StripANSI(content)
	lines := strings.Split(plain, "\n")
	cells := codexCells(plain)
	cut := -1
	if len(cells) > 0 {
		cell := cells[len(cells)-1]
		if !cell.followedByTranscript {
			for i := cell.start + 1; i <= cell.end; i++ {
				if codexModelFooterRe.MatchString(lines[i]) || codexFooterHint(lines[i]) {
					cut = cell.start
					break
				}
			}
		}
	}

	if cut < 0 {
		return content
	}
	// Reuse the send path's live-slot validation, including spinner variants.
	// Testing each suffix locates that slot without matching quoted statuses.
	if tmux.CodexTurnRunning(plain) {
		for i := cut - 1; i >= 0; i-- {
			if tmux.CodexTurnRunning(strings.Join(lines[i:], "\n")) {
				cut = i
				break
			}
		}
	}
	lines = lines[:cut]
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "⚠ Heads up, you have less than ") {
			warning := strings.TrimSpace(lines[i])
			end := i
			for !strings.Contains(warning, "for a breakdown.") && end+1 < len(lines) && end-i < 2 && startsIndented(lines[end+1]) {
				end++
				warning += " " + strings.TrimSpace(lines[end])
			}
			if codexLimitWarningRe.MatchString(warning) {
				i = end
				continue
			}
		}
		out = append(out, lines[i])
	}
	return strings.TrimRight(strings.Join(out, "\n"), " \t\r\n")
}

func codexFooterHint(line string) bool {
	return strings.HasPrefix(line, "  ? for shortcuts") ||
		strings.HasPrefix(line, "  ← for agents · ? for shortcuts")
}
