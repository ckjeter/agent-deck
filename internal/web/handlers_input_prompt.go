package web

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
)

type inputPromptResponse struct {
	Supported  bool                     `json:"supported"`
	Tool       string                   `json:"tool,omitempty"`
	Reason     string                   `json:"reason,omitempty"`
	Kind       string                   `json:"kind,omitempty"`
	PromptID   string                   `json:"prompt_id,omitempty"`
	Context    string                   `json:"context,omitempty"`
	Options    []send.CodexPromptOption `json:"options,omitempty"`
	ObservedAt string                   `json:"observed_at,omitempty"`
	Answered   bool                     `json:"answered,omitempty"`
}

func inputPromptID(profile, id, fingerprint string) string {
	data, _ := json.Marshal([]string{profile, id, fingerprint})
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func (s *Server) checkInputPromptMutation(w http.ResponseWriter) bool {
	if !s.checkMutationsAllowed(w) {
		return false
	}
	if s.cfg.ReadOnly {
		writeAPIError(w, http.StatusForbidden, ErrCodeForbidden, "web server is read-only")
		return false
	}
	return s.checkMutationRateLimit(w)
}

func (s *Server) handleInputPrompt(w http.ResponseWriter, r *http.Request, id string, choosing bool) {
	method := http.MethodGet
	if choosing {
		method = http.MethodPost
	}
	if r.Method != method {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if choosing && !s.checkInputPromptMutation(w) {
		return
	}
	var req struct {
		PromptID     string `json:"prompt_id"`
		Choice       string `json:"choice"`
		ConfirmScope bool   `json:"confirm_scope"`
	}
	if choosing {
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.PromptID == "" || req.Choice == "" {
			writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "prompt_id and choice are required")
			return
		}
	}

	// Serialize inspection and dispatch so two taps cannot answer two queued prompts.
	// Retain consumed fingerprints even after an unconfirmed outcome or a fresh GET.
	s.inputPromptMu.Lock()
	defer s.inputPromptMu.Unlock()
	inst, _, profile, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	response := inputPromptResponse{Tool: inst.Tool, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	var target send.CodexApprovalTarget
	switch {
	case inst.IsSSH():
		response.Reason = "remote prompt answering is not supported"
	case !session.IsCodexCompatible(inst.Tool):
		response.Reason = "prompt answering currently supports Codex only"
	default:
		if s.inputPromptTarget != nil {
			target = s.inputPromptTarget(inst)
		} else if inst.Exists() {
			target = inst.GetTmuxSession()
		}
		if target == nil {
			response.Reason = "session is not running"
		}
	}
	if response.Reason != "" {
		if choosing {
			writeAPIError(w, http.StatusConflict, "UNSUPPORTED", response.Reason)
		} else {
			writeJSON(w, http.StatusOK, response)
		}
		return
	}
	prompt, err := send.InspectCodexPrompt(target)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to inspect input prompt")
		return
	}
	response.Supported = true
	if prompt != nil {
		response.Kind = "approval"
		response.PromptID = inputPromptID(profile, inst.ID, prompt.Fingerprint)
		response.Context, response.Options = prompt.Context, prompt.Options
		response.Answered = s.inputPromptAttempts[response.PromptID]
	}
	if !choosing {
		writeJSON(w, http.StatusOK, response)
		return
	}
	if prompt == nil {
		writeAPIError(w, http.StatusConflict, "NO_PROMPT", "no active Codex approval prompt found")
		return
	}
	if req.PromptID != response.PromptID || response.Answered {
		writeAPIError(w, http.StatusConflict, "PROMPT_CHANGED", "prompt changed or this prompt was already answered; inspect it again without replaying the choice")
		return
	}
	var selected *send.CodexPromptOption
	for i := range prompt.Options {
		option := &prompt.Options[i]
		if req.Choice == strconv.Itoa(option.Number) || ((req.Choice == "once" || req.Choice == "deny") && req.Choice == option.Choice) {
			selected = option
			break
		}
	}
	if selected == nil || selected.Number < 1 || selected.Number > 9 {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "choose once, deny, or a displayed single-digit option")
		return
	}
	if selected.Scope != "once" && selected.Scope != "deny" && !req.ConfirmScope {
		writeAPIError(w, http.StatusBadRequest, "SCOPE_CONFIRMATION_REQUIRED", "confirm the displayed option scope before continuing")
		return
	}
	opts := s.inputPromptVerify
	opts.ExpectedFingerprint = prompt.Fingerprint
	result, err := send.ApproveCodexPrompt(target, strconv.Itoa(selected.Number), opts)
	if result.KeySent {
		if s.inputPromptAttempts == nil {
			s.inputPromptAttempts = make(map[string]bool)
		}
		s.inputPromptAttempts[response.PromptID] = true
	}
	if err != nil && !result.KeySent {
		code, status := ErrCodeInternalError, http.StatusInternalServerError
		if errors.Is(err, send.ErrNoCodexPrompt) {
			code, status = "NO_PROMPT", http.StatusConflict
		} else if errors.Is(err, send.ErrCodexPromptChanged) {
			code, status = "PROMPT_CHANGED", http.StatusConflict
		}
		writeAPIError(w, status, code, err.Error())
		return
	}
	outcome, status := "verified", http.StatusOK
	var outcomeError any
	if !result.Verified {
		outcome, status = "unconfirmed", http.StatusConflict
		outcomeError = map[string]string{"code": "OUTCOME_UNCONFIRMED", "message": "choice sent, but prompt clearing was not observed; do not retry"}
	} else if result.NextPromptSeen {
		outcome = "next_prompt"
	}
	writeJSON(w, status, struct {
		Outcome      string `json:"outcome"`
		KeySent      bool   `json:"key_sent"`
		OptionNumber int    `json:"option_number"`
		OptionLabel  string `json:"option_label"`
		Verified     bool   `json:"verified"`
		Error        any    `json:"error,omitempty"`
	}{outcome, result.KeySent, result.OptionNumber, result.OptionLabel, result.Verified, outcomeError})
}
