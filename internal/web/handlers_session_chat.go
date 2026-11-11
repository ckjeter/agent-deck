package web

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
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
		// ClientID is the phone's idempotency key for this message: a retry
		// of a POST whose response was lost carries the same one.
		ClientID string `json:"client_id"`
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
	if req.ClientID != "" && !validChatClientID.MatchString(req.ClientID) {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "invalid client_id")
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
	queued := sendqueue.Send{
		SessionID: inst.ID, SessionTitle: inst.Title, Tool: inst.Tool,
		ClaudeSessionID: inst.ClaudeSessionID, Running: true,
		Message: req.Text, Sender: "web", Deadline: now.Add(sendqueue.DefaultRetryBudget),
		RequireInputPrompt: true, IgnoreBudget: true,
	}
	var record *sendqueue.Record
	if req.ClientID != "" {
		queued.Key = "web-send:" + inst.ID + ":" + req.ClientID
		record, _, err = sendqueue.EnqueueOnce(profile, dir, queued, now)
	} else {
		record, err = sendqueue.Enqueue(profile, dir, queued, now)
	}
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
		if record.Dismissed || (i < len(records)-chatHistoryPageSize && record.Final()) {
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

var validChatClientID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// handleSessionSendDismiss hides a finished send that never landed (failed,
// cancelled, or typed/submitted with its delivery watch over) from the chat.
// It only marks the record: delivery is already over, and text left in the
// agent's composer stays there for the composer takeover to move or discard.
func (s *Server) handleSessionSendDismiss(w http.ResponseWriter, r *http.Request, id string) {
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
		SendID string `json:"send_id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SendID == "" {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "send_id is required")
		return
	}
	_, _, profile, err := s.loadChatSession(id)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	profileDir, err := session.GetProfileDir(profile)
	if err != nil {
		writeChatSessionError(w, err)
		return
	}
	dir := sendqueue.Dir(profileDir)
	record, err := sendqueue.Load(dir, req.SendID)
	if errors.Is(err, sendqueue.ErrUnknown) || (err == nil && record.SessionID != id) {
		writeAPIError(w, http.StatusNotFound, ErrCodeNotFound, "send not found")
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to read send")
		return
	}
	if !record.Final() || record.State == sendqueue.StateLanded {
		writeAPIError(w, http.StatusConflict, "SEND_ACTIVE", "only a finished send that did not land can be dismissed")
		return
	}
	if _, err := sendqueue.Update(dir, record.SendID, time.Now(), func(r *sendqueue.Record) { r.Dismissed = true }); err != nil {
		writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to dismiss send")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"send_id": record.SendID, "dismissed": true})
}
