package web

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/recall/query"
	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
)

type remoteChatRunner interface {
	RunIO(context.Context, io.Reader, io.Writer, io.Writer, ...string) error
}

func configuredRemoteChatRunner(name string) (remoteChatRunner, error) {
	cfg, err := session.LoadUserConfig()
	if err != nil {
		return nil, err
	}
	remote, ok := cfg.Remotes[name]
	if !ok {
		return nil, fmt.Errorf("remote is not configured")
	}
	return session.NewSSHRunner(name, remote), nil
}

type remoteChatSend struct {
	SendID    string `json:"send_id"`
	SessionID string `json:"session_id"`
	State     string `json:"state"`
	Message   string `json:"message"`
	Reason    string `json:"reason,omitempty"`
	CreatedAt string `json:"created_at"`
	Settled   bool   `json:"settled,omitempty"`
}

func (s *Server) handleRemoteSessionChat(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeRequest(r) {
		writeAPIError(w, http.StatusUnauthorized, ErrCodeUnauthorized, "unauthorized")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/remotes/"), "/")
	if len(parts) >= 4 && parts[1] == "sessions" && parts[2] != "" && parts[3] == "input-prompt" {
		if len(parts) == 4 && r.Method == http.MethodGet {
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusOK, inputPromptResponse{Reason: "remote prompt answering is not supported"})
		} else if len(parts) == 5 && parts[4] == "choice" && r.Method == http.MethodPost {
			if s.checkInputPromptMutation(w) {
				writeAPIError(w, http.StatusConflict, "UNSUPPORTED", "remote prompt answering is not supported")
			}
		} else {
			writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		}
		return
	}
	if len(parts) != 4 || parts[1] != "sessions" || parts[2] == "" || strings.HasPrefix(parts[2], "-") {
		writeAPIError(w, http.StatusNotFound, ErrCodeNotFound, "remote session not found")
		return
	}
	name, id, action := parts[0], parts[2], parts[3]
	method := http.MethodGet
	if action == "send" {
		method = http.MethodPost
	}
	if action != "send" && action != "output" && action != "send-status" {
		writeAPIError(w, http.StatusNotFound, ErrCodeNotFound, "unknown remote session action")
		return
	}
	if r.Method != method {
		writeAPIError(w, http.StatusMethodNotAllowed, ErrCodeMethodNotAllowed, "method not allowed")
		return
	}
	// The CLI status reader can restart a queued worker, so it needs the same
	// mutation gates as sending. Reading output never starts a worker.
	if action != "output" {
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
	}
	found, online := false, false
	tool := ""
	if s.remoteFleet != nil {
		for _, remote := range s.remoteFleet.Snapshot().Remotes {
			if remote.Name != name {
				continue
			}
			online = remote.Online
			for _, inst := range remote.Sessions {
				if inst.ID == id && !inst.Archived {
					found = true
					tool = inst.Tool
				}
			}
		}
	}
	if !found {
		writeAPIError(w, http.StatusNotFound, ErrCodeNotFound, "remote session not found")
		return
	}
	if !online {
		writeAPIError(w, http.StatusServiceUnavailable, ErrCodeInternalError, "remote is offline")
		return
	}
	var text string
	sendID := r.URL.Query().Get("send-id")
	if action == "send" {
		var req struct {
			Text string `json:"text"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		if json.NewDecoder(r.Body).Decode(&req) != nil || strings.TrimSpace(req.Text) == "" {
			writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "text is required")
			return
		}
		text = req.Text
	}
	if action == "send-status" && (len(sendID) != 26 || strings.ContainsAny(sendID, "/\\ \t\r\n") || strings.HasPrefix(sendID, "-")) {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "invalid send id")
		return
	}
	factory := s.remoteChatRunner
	if factory == nil {
		factory = configuredRemoteChatRunner
	}
	runner, err := factory(name)
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, ErrCodeInternalError, "remote configuration is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	run := func(input io.Reader, args ...string) error {
		stdout.Reset()
		stderr.Reset()
		return runner.RunIO(ctx, input, &stdout, &stderr, args...)
	}
	w.Header().Set("Cache-Control", "no-store")
	if action == "output" {
		if r.URL.Query().Get("history") == "1" && s.serveRemoteChatHistory(w, runner, ctx, id, r.URL.Query()) {
			return
		}
		args := []string{"session", "output", id, "--json"}
		version := r.URL.Query().Get("if-version")
		if version != "" && !strings.HasPrefix(version, "hash:") {
			args = append(args, "--if-version", version)
		}
		var result struct {
			Content   string `json:"content"`
			Version   string `json:"content_version"`
			Unchanged bool   `json:"unchanged"`
		}
		if run(nil, args...) != nil || json.Unmarshal(stdout.Bytes(), &result) != nil {
			writeAPIError(w, http.StatusBadGateway, ErrCodeInternalError, "unable to read remote output")
			return
		}
		// Release remotes still return pane chrome when no rollout is available.
		// A content version proves a structured source, whose text must stay intact.
		if session.IsCodexCompatible(tool) && result.Version == "" {
			result.Content = send.StripCodexChrome(result.Content)
		}
		if result.Version == "" {
			result.Version = fmt.Sprintf("hash:%x", sha256.Sum256([]byte(result.Content)))
		}
		if result.Unchanged || result.Version == version {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"content": result.Content, "content_version": result.Version, "latest_only": true})
		return
	}
	if action == "send" {
		if run(nil, "session", "send", "--help") != nil {
			writeAPIError(w, http.StatusBadGateway, ErrCodeInternalError, "unable to check remote send support")
			return
		}
		help := stdout.String() + stderr.String()
		for _, flag := range []string{"-require-input-prompt", "-message-file", "-queue"} {
			if !strings.Contains(help, flag) {
				writeAPIError(w, http.StatusNotImplemented, ErrCodeNotImplemented, "remote needs an agent-deck update for guarded queued sends")
				return
			}
		}
		err = run(strings.NewReader(text), "session", "send", id, "--message-file", "-", "--queue", "--json", "--no-tag", "--ignore-budget", "--require-input-prompt")
	} else {
		err = run(nil, "session", "send-status", sendID, "--json")
	}
	var record remoteChatSend
	if err != nil || json.Unmarshal(stdout.Bytes(), &record) != nil || record.SendID == "" || record.SessionID != id || (action == "send-status" && record.SendID != sendID) {
		writeAPIError(w, http.StatusBadGateway, ErrCodeInternalError, "remote delivery could not be confirmed; check the remote before retrying")
		return
	}
	code := http.StatusOK
	if action == "send" {
		code = http.StatusAccepted
	}
	writeJSON(w, code, record)
}

// remoteChatHistoryMaxBytes bounds one remote `recall timeline` response.
// A 60-row page fits far below this; anything larger is refused instead of
// buffered.
const remoteChatHistoryMaxBytes = 4 << 20

// remoteChatCursorPattern accepts only the base64url cursors `recall
// timeline` itself issues, so a cursor can never smuggle a shell metacharacter
// or a leading option into the remote command line.
var remoteChatCursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// cappedBuffer bounds one remote command's stdout; a Write past max fails the
// command instead of buffering an unbounded response.
type cappedBuffer struct {
	buf    bytes.Buffer
	max    int
	capped bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.max {
		c.capped = true
		return 0, fmt.Errorf("remote output exceeded %d bytes", c.max)
	}
	return c.buf.Write(p)
}

// remoteChatTimeline is the subset of the remote `recall timeline --json`
// answer this handler maps into the local history DTO.
type remoteChatTimeline struct {
	Session       struct{ ID string } `json:"session"`
	Turns         []query.Row         `json:"turns"`
	Updates       []query.Row         `json:"updates"`
	Removed       []string            `json:"removed"`
	BeforeCursor  string              `json:"before_cursor"`
	ThroughCursor string              `json:"through_cursor"`
}

// serveRemoteChatHistory answers the phone's history request by running
// `recall timeline` on the remote and mapping its rows through the same
// presenter as local history. It returns false when the remote cannot serve
// native history (missing transcript, unknown command, unreachable remote):
// the caller then falls back to the latest-response read, whose own failure
// becomes the response the client sees. It writes the response itself
// whenever it returns true.
func (s *Server) serveRemoteChatHistory(w http.ResponseWriter, runner remoteChatRunner, ctx context.Context, id string, q url.Values) bool {
	since, before := q.Get("since"), q.Get("before")
	if since != "" && before != "" {
		writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "history cursors cannot be combined")
		return true
	}
	for _, cursor := range []string{since, before} {
		if cursor != "" && (len(cursor) > 64<<10 || strings.HasPrefix(cursor, "-") || !remoteChatCursorPattern.MatchString(cursor)) {
			writeAPIError(w, http.StatusBadRequest, ErrCodeBadRequest, "invalid history cursor")
			return true
		}
	}
	args := []string{"recall", "timeline", id, "--json"}
	switch {
	case before != "":
		args = append(args, "--before", before, "--limit", strconv.Itoa(chatHistoryPageSize))
	case since != "":
		args = append(args, "--since", since)
	default:
		args = append(args, "--tail", strconv.Itoa(chatHistoryPageSize))
	}
	stdout := &cappedBuffer{max: remoteChatHistoryMaxBytes}
	stderr := &cappedBuffer{max: 64 << 10}
	err := runner.RunIO(ctx, nil, stdout, stderr, args...)
	if stdout.capped || stderr.capped {
		writeAPIError(w, http.StatusBadGateway, ErrCodeInternalError, "remote history response was too large")
		return true
	}
	if err != nil {
		// A CLI failure prints its JSON error on stdout with the exit status.
		var failure struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(stdout.buf.Bytes(), &failure) == nil && failure.Code == "RESYNC_REQUIRED" {
			writeAPIError(w, http.StatusConflict, ErrCodeBadRequest, "conversation changed; reload history")
			return true
		}
		return false
	}
	var tl remoteChatTimeline
	if err := json.Unmarshal(stdout.buf.Bytes(), &tl); err != nil {
		return false
	}
	if tl.ThroughCursor == "" || (tl.Session.ID != "" && tl.Session.ID != id) {
		return false
	}
	version := "hash:" + fmt.Sprintf("%x", sha256.Sum256([]byte(tl.ThroughCursor)))
	if before == "" && version == q.Get("if-version") {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	writeJSON(w, http.StatusOK, struct {
		Messages []chatMessage `json:"messages"`
		Updates  []chatMessage `json:"updates,omitempty"`
		Removed  []string      `json:"removed,omitempty"`
		Before   string        `json:"before_cursor,omitempty"`
		Through  string        `json:"through_cursor,omitempty"`
		HasMore  bool          `json:"has_more"`
		Version  string        `json:"content_version,omitempty"`
	}{chatMessages(tl.Turns), chatMessages(tl.Updates), tl.Removed,
		tl.BeforeCursor, tl.ThroughCursor, len(tl.Turns) >= chatHistoryPageSize, version})
	return true
}
