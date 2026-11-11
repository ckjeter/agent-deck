package send

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestInspectCodexPrompt(t *testing.T) {
	target := &fakeCodexApprovalTarget{captures: []string{codexExecApprovalPrompt}}
	prompt, err := InspectCodexPrompt(target)
	if err != nil || prompt == nil {
		t.Fatalf("inspect: %v, %v", prompt, err)
	}
	if len(prompt.Fingerprint) != 64 || !strings.Contains(prompt.Context, "$ curl https://example.com") || len(prompt.Options) != 3 {
		t.Fatalf("unexpected prompt: %+v", prompt)
	}
	if prompt.Options[0].Choice != "once" || prompt.Options[1].Scope != "persistent" || prompt.Options[2].Choice != "deny" || len(target.sent) != 0 {
		t.Fatalf("unexpected options: %+v, sent %v", prompt.Options, target.sent)
	}
}

func TestApproveCodexPromptBindsExpectedFingerprint(t *testing.T) {
	target := &fakeCodexApprovalTarget{captures: []string{codexExecApprovalPrompt}}
	prompt, _ := InspectCodexPrompt(target)
	target.captures = []string{strings.ReplaceAll(codexExecApprovalPrompt, "example.com", "changed.example")}
	_, err := ApproveCodexPrompt(target, "once", CodexApprovalOptions{ExpectedFingerprint: prompt.Fingerprint})
	if !errors.Is(err, ErrCodexPromptChanged) || len(target.sent) != 0 {
		t.Fatalf("err=%v sent=%v", err, target.sent)
	}
}

func TestApproveCodexPromptDeny(t *testing.T) {
	target := &fakeCodexApprovalTarget{captures: []string{codexExecApprovalPrompt, codexExecApprovalPrompt, "› Continue"}}
	result, err := ApproveCodexPrompt(target, "deny", CodexApprovalOptions{VerifyTimeout: time.Millisecond})
	if err != nil || !result.Verified || len(target.sent) != 1 || target.sent[0] != "3" {
		t.Fatalf("result=%+v err=%v sent=%v", result, err, target.sent)
	}
}

func TestInspectCodexPromptDoesNotGuessTrustMenus(t *testing.T) {
	target := &fakeCodexApprovalTarget{captures: []string{"Trust this folder?\n› 1. Trust and continue\n  2. Back\n"}}
	prompt, err := InspectCodexPrompt(target)
	if err != nil || prompt != nil {
		t.Fatalf("unsafe generic menu recognized: %+v, %v", prompt, err)
	}
}

func TestInspectCodexPromptRejectsMixedMenuHistory(t *testing.T) {
	target := &fakeCodexApprovalTarget{captures: []string{codexExecApprovalPrompt + "\nTrust this folder?\n› 1. Trust and continue\n  2. Back\n"}}
	prompt, err := InspectCodexPrompt(target)
	if err != nil || prompt != nil {
		t.Fatalf("mixed stale approval and trust menu recognized: %+v, %v", prompt, err)
	}
}

func TestInspectCodexPromptPreservesCommandWhitespace(t *testing.T) {
	firstPane := strings.ReplaceAll(codexExecApprovalPrompt, "curl https://example.com", "printf 'a  b'")
	secondPane := strings.ReplaceAll(firstPane, "'a  b'", "'a b'")
	first, _ := InspectCodexPrompt(&fakeCodexApprovalTarget{captures: []string{firstPane}})
	second, _ := InspectCodexPrompt(&fakeCodexApprovalTarget{captures: []string{secondPane}})
	if first == nil || second == nil || first.Fingerprint == second.Fingerprint {
		t.Fatal("whitespace inside a quoted command must change the prompt fingerprint")
	}
}
