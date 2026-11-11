package web

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/sendqueue"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

type composerResponse struct {
	Visible     bool   `json:"visible"`
	Draft       string `json:"draft"`
	Foreign     bool   `json:"foreign"`
	Suggestion  bool   `json:"suggestion"`
	ObservedAt  string `json:"observed_at"`
	Fingerprint string `json:"fingerprint"`
}

type composerFrame string

func (frame composerFrame) CapturePaneFresh() (string, error) { return string(frame), nil }
func (frame composerFrame) SendNamedKey(string) error {
	return fmt.Errorf("composer frame is read-only")
}

func inspectComposer(raw, tool, profile, id string, records []*sendqueue.Record) composerResponse {
	content := tmux.StripANSI(raw)
	detectorTool := "claude"
	if session.IsCodexCompatible(tool) {
		detectorTool = "codex"
		prompt, _ := send.InspectCodexPrompt(composerFrame(raw))
		if prompt != nil {
			return composerResponse{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		}
	}
	if send.DialogOpen(content) || tmux.NewPromptDetector(detectorTool).ClassifySubstate(content) == tmux.SubstateInteractiveMenu {
		return composerResponse{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	}
	read := send.ComposerDraft
	if session.IsCodexCompatible(tool) {
		read = send.CodexComposerDraft
	}
	draft, visible := read(raw, tmux.StripANSI)
	result := composerResponse{Visible: visible, Draft: draft, Foreign: visible && draft != "", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if visible && draft == "" {
		if session.IsCodexCompatible(tool) {
			for _, row := range strings.Split(tmux.StripANSI(raw), "\n") {
				if strings.HasPrefix(row, "›") {
					result.Suggestion = strings.TrimSpace(strings.TrimPrefix(row, "›")) != ""
				}
			}
		} else {
			body, _ := send.CurrentComposerPrompt(tmux.StripANSI(raw))
			result.Suggestion = send.ComposerBodyIsSuggestion(raw) || strings.TrimSpace(body) != ""
		}
	}
	for _, record := range records {
		if record.Final() || (record.State != sendqueue.StateTyping && record.State != sendqueue.StateTyped && record.State != sendqueue.StateSubmitted) {
			continue
		}
		attribution := send.EnterAttribution{Message: record.Message}
		if result.Foreign && ((session.IsCodexCompatible(tool) && draft == send.NormalizePromptText(record.Message)) ||
			(!session.IsCodexCompatible(tool) && !attribution.EnterWouldSubmitForeignDraft(send.Captured(raw), tmux.StripANSI))) {
			result.Foreign = false
		}
	}
	data, _ := json.Marshal([]string{profile, id, tool, draft})
	result.Fingerprint = fmt.Sprintf("%x", sha256.Sum256(data))
	return result
}

func (s *Server) handleComposer(w http.ResponseWriter, r *http.Request, id string, take bool) {
	method := http.MethodGet
	if take {
		method = http.MethodPost
	}
	if r.Method != method {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if take && !s.checkInputPromptMutation(w) {
		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
	}
	if take {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Fingerprint == "" {
			writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "fingerprint is required")
			return
		}
	}
	inst, _, profile, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	if inst.IsSSH() || (!session.IsClaudeCompatible(inst.Tool) && !session.IsCodexCompatible(inst.Tool)) {
		if take {
			writeAPIError(w, http.StatusConflict, "UNSUPPORTED", "draft handoff supports local Claude and Codex sessions")
		} else {
			writeJSON(w, http.StatusOK, composerResponse{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
		}
		return
	}
	var target send.CodexApprovalTarget
	if s.composerTarget != nil {
		target = s.composerTarget(inst)
	} else if inst.Exists() {
		target = inst.GetTmuxSession()
	}
	if target == nil {
		if take {
			writeAPIError(w, http.StatusConflict, "DRAFT_CHANGED", "session is no longer running")
		} else {
			writeJSON(w, http.StatusOK, composerResponse{ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
		}
		return
	}
	if take {
		lock, err := session.AcquireSendLock(inst.ID, 100*time.Millisecond)
		if err != nil {
			writeAPIError(w, http.StatusConflict, "TARGET_BUSY", "a send is in progress; inspect the composer again shortly")
			return
		}
		defer lock.Release()
	}
	profileDir, err := session.GetProfileDir(profile)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	records, err := sendqueue.List(sendqueue.Dir(profileDir), inst.ID)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to read delivery ownership")
		return
	}
	observe := func() (composerResponse, error) {
		raw, err := target.CapturePaneFresh()
		if err != nil {
			return composerResponse{}, err
		}
		return inspectComposer(raw, inst.Tool, profile, inst.ID, records), nil
	}
	current, err := observe()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to capture composer")
		return
	}
	if !take {
		writeJSON(w, http.StatusOK, current)
		return
	}
	if !current.Foreign || req.Fingerprint != current.Fingerprint {
		writeAPIError(w, http.StatusConflict, "DRAFT_CHANGED", "desktop draft changed; review it again")
		return
	}
	if send.HasUnsentPastedPrompt(current.Draft) {
		writeAPIError(w, http.StatusConflict, "DRAFT_UNREADABLE", "collapsed paste cannot be recovered from the pane; open Terminal to edit it")
		return
	}
	// Reconfirm under the send lock immediately before the first key. No Enter
	// or interrupt is sent, and an unreadable frame never authorizes clearing.
	latest, err := observe()
	if err != nil || !latest.Foreign || latest.Fingerprint != current.Fingerprint {
		writeAPIError(w, http.StatusConflict, "DRAFT_CHANGED", "desktop draft changed; review it again")
		return
	}
	keyErr := target.SendNamedKey("C-e")
	if keyErr == nil {
		latest, err = observe()
		if err != nil || !latest.Foreign || latest.Fingerprint != current.Fingerprint {
			writeAPIError(w, http.StatusConflict, "DRAFT_CHANGED", "desktop draft changed; no text was cleared")
			return
		}
		keyErr = target.SendNamedKey("C-u")
	}
	verified := false
	if keyErr == nil {
		deadline := time.Now().Add(300 * time.Millisecond)
		for {
			frame, err := observe()
			if err == nil && frame.Visible && frame.Draft == "" {
				verified = true
				break
			}
			if time.Now().After(deadline) {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	status := http.StatusOK
	var outcomeError any
	if !verified {
		status = http.StatusConflict
		outcomeError = map[string]string{"code": "CLEAR_UNCONFIRMED", "message": "draft copied, but desktop clearing was not confirmed; inspect Terminal before sending"}
	}
	writeJSON(w, status, struct {
		Draft    string `json:"draft"`
		Verified bool   `json:"verified"`
		Error    any    `json:"error,omitempty"`
	}{current.Draft, verified, outcomeError})
}
