package web

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/sendqueue"
	"github.com/asheshgoplani/agent-deck/internal/session"
)

func (s *Server) loadChatSession(id string) (*session.Instance, []*session.Instance, string, error) {
	service, ok := s.menuData.(*SessionDataService)
	if !ok {
		service = NewSessionDataService(s.cfg.Profile)
	}
	storage, profile, err := service.resolveAndOpenStorage()
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = storage.Close() }()
	instances, _, err := storage.LoadWithGroups()
	if err != nil {
		return nil, nil, "", err
	}
	for _, inst := range instances {
		if inst.ID == id {
			return inst, instances, profile, nil
		}
	}
	return nil, nil, "", ErrSessionNotFound
}

func (s *Server) handleSessionOutput(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	inst, peers, _, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	if session.IsCodexCompatible(inst.Tool) && inst.CodexSessionID == "" {
		inst.CodexSessionID = inst.LiveCodexThreadID()
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Query().Get("history") == "1" && s.handleChatHistory(w, r, inst, peers) {
		return
	}
	version := inst.ResponseContentVersion(peers)
	if version != "" && version == r.URL.Query().Get("if-version") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	response, versioned, err := inst.GetLastResponseAtVersion(peers, version)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to read session response")
		return
	}
	if !versioned {
		version = ""
	}
	writeJSON(w, http.StatusOK, struct {
		*session.ResponseOutput
		ContentVersion string `json:"content_version,omitempty"`
	}{response, version})
}

func (s *Server) handleSessionSend(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	if !s.checkMutationsAllowed(w) {
		return
	}
	if s.cfg.ReadOnly {
		writeAPIError(w, http.StatusForbidden, ErrCodeForbidden, "web server is read-only")
		return
	}
	if !s.checkMutationRateLimit(w) {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "text is required")
		return
	}
	inst, _, profile, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	if !inst.Exists() {
		writeAPIError(w, http.StatusConflict, ErrCodeBadRequest, "session is not running")
		return
	}
	profileDir, err := session.GetProfileDir(profile)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	dir := sendqueue.Dir(profileDir)
	now := time.Now()
	record, err := sendqueue.Enqueue(profile, dir, sendqueue.Send{
		SessionID: inst.ID, SessionTitle: inst.Title, Tool: inst.Tool,
		ClaudeSessionID: inst.ClaudeSessionID, Running: true,
		Message: req.Text, Sender: "web", Deadline: now.Add(sendqueue.DefaultRetryBudget),
		RequireInputPrompt: true, IgnoreBudget: true,
	}, now)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to queue message")
		return
	}
	// Use the queue's existing detached worker, exactly as session send --queue.
	// The handler never invokes session send or interpolates a shell command.
	start := s.startChatWorker
	if start == nil {
		start = sendqueue.SpawnWorker
	}
	result := map[string]string{"send_id": record.SendID, "state": record.State}
	if err := start(profile, inst.ID); err != nil {
		result["warning"] = "queued, but delivery worker could not start"
	}
	writeJSON(w, http.StatusAccepted, result)
}

func writeChatSessionError(w http.ResponseWriter, err error) {
	if err == ErrSessionNotFound {
		writeAPIError(w, http.StatusNotFound, ErrCodeNotFound, "session not found")
		return
	}
	writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to load session")
}

func (s *Server) handleSessionSendStatus(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	_, _, profile, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	dir, err := session.GetProfileDir(profile)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	records, err := sendqueue.List(sendqueue.Dir(dir), id)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to read send status")
		return
	}
	type status struct {
		SendID       string `json:"send_id"`
		State        string `json:"state"`
		Message      string `json:"message"`
		Reason       string `json:"reason,omitempty"`
		TargetStatus string `json:"target_status,omitempty"`
		CreatedAt    string `json:"created_at"`
		LandedRowID  string `json:"landed_row_id,omitempty"`
		Settled      bool   `json:"settled,omitempty"`
	}
	sends := make([]status, 0)
	// Keep active deliveries even when many newer sends have already finished.
	for i, record := range records {
		if i < len(records)-chatHistoryPageSize && record.Final() {
			continue
		}
		sends = append(sends, status{record.SendID, record.State, record.Message, record.Reason, record.TargetStatus,
			record.CreatedAt, record.LandedRowID, record.Settled})
	}
	data, _ := json.Marshal(sends)
	version := fmt.Sprintf("%x", sha256.Sum256(data))
	w.Header().Set("Cache-Control", "no-store")
	if version == r.URL.Query().Get("if-version") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Sends   []status `json:"sends"`
		Version string   `json:"content_version"`
	}{sends, version})
}
