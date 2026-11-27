package send

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

const claudeSurveyQuestion = "How is Claude doing this session?"

var ErrNoClaudeSurvey = errors.New("no active Claude session survey found")
var ErrClaudeSurveyChanged = errors.New("Claude session survey changed before the key could be sent")

var claudeSurveyOptionPattern = regexp.MustCompile(`\b([0-9]):\s+([A-Za-z']+)`)

// InspectClaudeSurvey captures the pane and returns Claude Code's end of turn
// feedback survey ("1: Bad 2: Fine 3: Good 0: Dismiss") when it is the live
// prompt. Claude takes a single digit only while its input box is empty, so a
// survey shown above a typed draft is not reported.
func InspectClaudeSurvey(target CodexApprovalTarget) (*CodexPrompt, error) {
	if target == nil {
		return nil, fmt.Errorf("survey target is nil")
	}
	raw, err := target.CapturePaneFresh()
	if err != nil {
		return nil, fmt.Errorf("capture Claude pane: %w", err)
	}
	return detectClaudeSurvey(raw), nil
}

func detectClaudeSurvey(raw string) *CodexPrompt {
	if draft, _ := ComposerDraft(raw, tmux.StripANSI); draft != "" {
		return nil
	}
	lines := tailLines(tmux.StripANSI(raw), 20)
	for i := len(lines) - 2; i >= 0; i-- {
		if !strings.Contains(lines[i], claudeSurveyQuestion) {
			continue
		}
		var options []CodexPromptOption
		for _, match := range claudeSurveyOptionPattern.FindAllStringSubmatch(lines[i+1], -1) {
			number, _ := strconv.Atoi(match[1])
			options = append(options, CodexPromptOption{Number: number, Choice: match[1], Label: strings.TrimSpace(match[2]), Scope: "once"})
		}
		if len(options) < 2 {
			return nil
		}
		// Lines above the survey keep a second survey later in the session
		// from looking like the one already answered.
		var block []string
		for j := max(0, i-8); j <= i+1; j++ {
			if line := strings.TrimSpace(lines[j]); line != "" {
				block = append(block, line)
			}
		}
		return &CodexPrompt{
			Fingerprint: fmt.Sprintf("%x", sha256.Sum256([]byte(strings.Join(block, "\n")))),
			Context:     strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(lines[i]), "●")),
			Options:     options,
		}
	}
	return nil
}

// AnswerClaudeSurvey sends one displayed survey digit, without Enter, after
// checking the survey is still the same one, then waits for it to clear.
func AnswerClaudeSurvey(target CodexApprovalTarget, choice string, opts CodexApprovalOptions) (CodexApprovalResult, error) {
	var result CodexApprovalResult
	if opts.VerifyTimeout <= 0 {
		opts.VerifyTimeout = 5 * time.Second
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = 50 * time.Millisecond
	}
	first, err := InspectClaudeSurvey(target)
	if err != nil {
		return result, err
	}
	if first == nil {
		return result, ErrNoClaudeSurvey
	}
	if opts.ExpectedFingerprint != "" && first.Fingerprint != opts.ExpectedFingerprint {
		return result, ErrClaudeSurveyChanged
	}
	var selected *CodexPromptOption
	for i := range first.Options {
		if first.Options[i].Choice == choice {
			selected = &first.Options[i]
		}
	}
	if selected == nil {
		return result, fmt.Errorf("Claude survey option %q is not displayed", choice)
	}
	result.Choice, result.OptionNumber, result.OptionLabel = selected.Choice, selected.Number, selected.Label
	if err := target.SendNamedKey(selected.Choice); err != nil {
		return result, fmt.Errorf("send Claude survey key: %w", err)
	}
	result.KeySent = true
	deadline := time.Now().Add(opts.VerifyTimeout)
	for {
		if current, err := InspectClaudeSurvey(target); err == nil && (current == nil || current.Fingerprint != first.Fingerprint) {
			result.Verified = true
			return result, nil
		}
		if !time.Now().Before(deadline) {
			return result, fmt.Errorf("survey key %s was sent, but the survey did not clear within %s; not retrying automatically", selected.Choice, opts.VerifyTimeout)
		}
		time.Sleep(opts.PollInterval)
	}
}
