package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/recall/query"
	"github.com/asheshgoplani/agent-deck/internal/sendqueue"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"golang.org/x/time/rate"
)

func newChatTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	inst := session.NewInstanceWithTool("chat", dir, "codex")
	inst.ID = "chat-session"
	inst.CodexSessionID = "thread-chat"
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "sessions", "2026", "11", "08", "rollout-test-thread-chat.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data := `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-chat","last_agent_message":"Hello **world**"}}` + "\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	srv := NewServer(Config{ListenAddr: "127.0.0.1:0", WebMutations: true})
	service := NewSessionDataService("")
	service.openStorage = func(string) (storageLoader, error) {
		return &fakeStorage{instances: []*session.Instance{inst}, profile: "_test"}, nil
	}
	srv.menuData = service
	return srv
}

func chatRequest(srv *Server, method, path, body string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := newLocalRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost")
	srv.Handler().ServeHTTP(rr, req)
	return rr
}

func TestSessionChatOutput(t *testing.T) {
	srv := newChatTestServer(t)
	rr := chatRequest(srv, "GET", "/api/sessions/chat-session/output", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Content string `json:"content"`
		Version string `json:"content_version"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Content != "Hello **world**" || body.Version == "" {
		t.Fatalf("unexpected output: %s", rr.Body.String())
	}
	rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?if-version="+body.Version, "")
	if rr.Code != http.StatusNoContent || rr.Body.Len() != 0 {
		t.Fatalf("unchanged: status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestSessionChatGuards(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body string
		readonly, disabled, auth bool
		want                     int
	}{
		{name: "missing", method: "GET", path: "missing/output", want: 404},
		{name: "output method", method: "POST", path: "chat-session/output", want: 405},
		{name: "send method", method: "GET", path: "chat-session/send", want: 405},
		{name: "readonly", method: "POST", path: "chat-session/send", body: `{"text":"hello"}`, readonly: true, want: 403},
		{name: "disabled", method: "POST", path: "chat-session/send", body: `{"text":"hello"}`, disabled: true, want: 403},
		{name: "auth output", method: "GET", path: "chat-session/output", auth: true, want: 401},
		{name: "auth send", method: "POST", path: "chat-session/send", auth: true, want: 401},
		{name: "bad json", method: "POST", path: "chat-session/send", body: `{`, want: 400},
		{name: "empty", method: "POST", path: "chat-session/send", body: `{"text":"  "}`, want: 400},
		{name: "missing target", method: "POST", path: "missing/send", body: `{"text":"hello"}`, want: 404},
		{name: "stopped", method: "POST", path: "chat-session/send", body: `{"text":"hello"}`, want: 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newChatTestServer(t)
			srv.cfg.ReadOnly = tc.readonly
			srv.cfg.WebMutations = !tc.disabled
			if tc.auth {
				srv.cfg.Token = "secret"
			}
			rr := chatRequest(srv, tc.method, "/api/sessions/"+tc.path, tc.body)
			if rr.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", rr.Code, tc.want, rr.Body.String())
			}
		})
	}
}

func TestSessionChatSendQueuesNativeText(t *testing.T) {
	for _, workerFails := range []bool{false, true} {
		t.Run(fmt.Sprint(workerFails), func(t *testing.T) {
			srv := newChatTestServer(t)
			inst, _, _, err := srv.loadChatSession("chat-session")
			if err != nil {
				t.Fatal(err)
			}
			tmuxSession := inst.GetTmuxSession()
			if err := tmuxSession.Start("sleep 60"); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = tmuxSession.Kill() })
			called := false
			srv.startChatWorker = func(profile, id string) error {
				called = true
				if profile != "_test" || id != inst.ID {
					t.Fatalf("worker got %q %q", profile, id)
				}
				if workerFails {
					return fmt.Errorf("worker unavailable")
				}
				return nil
			}
			message := "你好\nDictation and paste: `echo $HOME`"
			payload, _ := json.Marshal(map[string]string{"text": message})
			rr := chatRequest(srv, "POST", "/api/sessions/chat-session/send", string(payload))
			want := http.StatusAccepted
			if rr.Code != want || !called {
				t.Fatalf("status=%d called=%v body=%s", rr.Code, called, rr.Body.String())
			}
			dir, err := session.GetProfileDir("_test")
			if err != nil {
				t.Fatal(err)
			}
			records, err := sendqueue.List(sendqueue.Dir(dir), inst.ID)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, r := range records {
				if r.Message != message {
					continue
				}
				if r.State != sendqueue.StateQueued {
					continue
				}
				if r.Sender != "web" || !r.RequireInputPrompt || !r.IgnoreBudget {
					t.Fatalf("unexpected queue options: %+v", r)
				}
				found = true
			}
			if !found {
				t.Fatalf("queued text not found: %+v", records)
			}
		})
	}
}

func TestSessionChatCSRFAndRateLimit(t *testing.T) {
	srv := newChatTestServer(t)
	req := newLocalRequest("POST", "/api/sessions/chat-session/send", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("Origin", "https://other.example")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status=%d", rr.Code)
	}
	srv.mutationLimiter = rate.NewLimiter(0, 0)
	rr = chatRequest(srv, "POST", "/api/sessions/chat-session/send", `{"text":"hello"}`)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limit status=%d", rr.Code)
	}
}

func TestSessionChatHistoryPagesAndPolls(t *testing.T) {
	for _, harness := range []string{"claude", "codex", "pi"} {
		t.Run(harness, func(t *testing.T) {
			srv := newChatTestServer(t)
			inst, _, _, _ := srv.loadChatSession("chat-session")
			inst.Tool = harness
			var path string
			if harness == "claude" {
				config := t.TempDir()
				t.Setenv("CLAUDE_CONFIG_DIR", config)
				inst.ClaudeSessionID = "conversation"
				path = session.ClaudeTranscriptPathForInstance(inst)
			} else if harness == "pi" {
				path = filepath.Join(os.Getenv("HOME"), ".pi", "agent-deck", inst.ID, "2026-11-11T00-00-00-000Z_conversation.jsonl")
			} else {
				path = session.CodexRolloutPathForInstance(inst)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			var transcript strings.Builder
			if harness == "pi" {
				fmt.Fprintf(&transcript, "{\"type\":\"session\",\"version\":3,\"id\":\"conversation\",\"cwd\":%q}\n", inst.EffectiveWorkingDir())
			}
			for i := 0; i < 40; i++ {
				for _, role := range []string{"user", "assistant"} {
					id, text := fmt.Sprintf("%s-%d", role, i), fmt.Sprintf("%s turn %d", role, i)
					if harness == "claude" {
						fmt.Fprintf(&transcript, "{\"type\":%q,\"uuid\":%q,\"sessionId\":\"conversation\",\"message\":{\"role\":%q,\"content\":[{\"type\":\"text\",\"text\":%q}]}}\n", role, id, role, text)
					} else if harness == "pi" {
						fmt.Fprintf(&transcript, "{\"type\":\"message\",\"id\":%q,\"message\":{\"role\":%q,\"content\":[{\"type\":\"text\",\"text\":%q}]}}\n", id, role, text)
					} else {
						fmt.Fprintf(&transcript, "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":%q,\"role\":%q,\"content\":[{\"type\":\"input_text\",\"text\":%q}]}}\n", id, role, text)
					}
				}
			}
			if err := os.WriteFile(path, []byte(transcript.String()), 0600); err != nil {
				t.Fatal(err)
			}
			var body struct {
				Messages []struct{ ID, Role, Content string }
				Before   string `json:"before_cursor"`
				Through  string `json:"through_cursor"`
				Version  string `json:"content_version"`
			}
			rr := chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1", "")
			if rr.Code != 200 {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Messages) != 60 || body.Messages[0].Content != "user turn 10" || body.Messages[59].Content != "assistant turn 39" || body.Before == "" || body.Through == "" {
				t.Fatalf("unexpected page: %s", rr.Body.String())
			}
			through, version := body.Through, body.Version
			rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&if-version="+url.QueryEscape(body.Version)+"&since="+url.QueryEscape(body.Through), "")
			if rr.Code != 204 || rr.Body.Len() != 0 {
				t.Fatalf("unchanged: %d %s", rr.Code, rr.Body.String())
			}
			rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&before="+url.QueryEscape(body.Before), "")
			if rr.Code != 200 {
				t.Fatalf("older: %d %s", rr.Code, rr.Body.String())
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Messages) != 20 || body.Messages[0].Content != "user turn 0" || body.Messages[19].Content != "assistant turn 9" {
				t.Fatalf("unexpected earlier page: %s", rr.Body.String())
			}
			rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&before=invalid", "")
			if rr.Code != 409 {
				t.Fatalf("invalid cursor status=%d", rr.Code)
			}
			line := `{"type":"response_item","payload":{"type":"message","id":"new-user","role":"user","content":[{"type":"input_text","text":"Appended question"}]}}` + "\n"
			if harness == "claude" {
				line = `{"type":"user","uuid":"new-user","message":{"role":"user","content":"Appended question"}}` + "\n"
			}
			if harness == "pi" {
				line = `{"type":"message","id":"new-user","message":{"role":"user","content":"Appended question"}}` + "\n"
			}
			if err := os.WriteFile(path, append([]byte(transcript.String()), []byte(line)...), 0600); err != nil {
				t.Fatal(err)
			}
			rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&since="+url.QueryEscape(through)+"&if-version="+url.QueryEscape(version), "")
			if rr.Code != 200 {
				t.Fatalf("incremental: %d %s", rr.Code, rr.Body.String())
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if len(body.Messages) != 1 || body.Messages[0].Content != "Appended question" || body.Version == version {
				t.Fatalf("unexpected incremental page: %s", rr.Body.String())
			}
			if err := os.WriteFile(path, []byte(line), 0600); err != nil {
				t.Fatal(err)
			}
			rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&since="+url.QueryEscape(through), "")
			if rr.Code != 409 {
				t.Fatalf("rewritten transcript status=%d body=%s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestSessionChatSendStatusChangesWithoutTranscriptChanges(t *testing.T) {
	srv := newChatTestServer(t)
	dir, err := session.GetProfileDir("_test")
	if err != nil {
		t.Fatal(err)
	}
	record, err := sendqueue.Enqueue("_test", sendqueue.Dir(dir), sendqueue.Send{SessionID: "chat-session", Message: "waiting message", Sender: "web", Running: true}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Sends []struct {
			SendID         string `json:"send_id"`
			State, Message string
		}
		Version string `json:"content_version"`
	}
	endpoint := "/api/sessions/chat-session/send-status"
	rr := chatRequest(srv, "GET", endpoint, "")
	if rr.Code != 200 {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	rr = chatRequest(srv, "GET", endpoint+"?if-version="+url.QueryEscape(body.Version), "")
	if rr.Code != 204 || rr.Body.Len() != 0 {
		t.Fatalf("unchanged: %d %s", rr.Code, rr.Body.String())
	}
	for _, state := range []string{"typing", "submitted", "landed", "failed"} {
		if _, err := sendqueue.Update(sendqueue.Dir(dir), record.SendID, time.Now(), func(r *sendqueue.Record) { r.State = state }); err != nil {
			t.Fatal(err)
		}
		rr = chatRequest(srv, "GET", endpoint+"?if-version="+url.QueryEscape(body.Version), "")
		if rr.Code != 200 {
			t.Fatalf("changed: %d %s", rr.Code, rr.Body.String())
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, r := range body.Sends {
			if r.SendID == record.SendID && r.State == state && r.Message == "waiting message" {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing state %s: %s", state, rr.Body.String())
		}
	}
	srv.cfg.ReadOnly = true
	rr = chatRequest(srv, "GET", endpoint, "")
	if rr.Code != 200 {
		t.Fatalf("readonly status=%d", rr.Code)
	}
	srv.cfg.Token = "secret"
	rr = chatRequest(srv, "GET", endpoint, "")
	if rr.Code != 401 {
		t.Fatalf("unauthorized status=%d", rr.Code)
	}
}

func TestChatMessagesToolSummaries(t *testing.T) {
	running, failed := false, true
	long := strings.Repeat("界", 180)
	rows := chatMessages([]query.Row{
		{ID: "u", Kind: "user", Body: "Question"},
		{ID: "tool", Kind: "tool", Title: "github.get_issue", Summary: "completed"},
		{ID: "bash", Kind: "bash", Title: long, Body: "SECRET_OUTPUT", Detail: long + "\nsecond line", Summary: "Exit code 1", Finished: &running, IsError: &failed, Meta: map[string]any{"input": "SECRET_INPUT"}},
		{ID: "edit", Kind: "edit", Title: "Edited hello.go", Detail: "hello.go", Finished: &running, Meta: map[string]any{"path": "hello.go", "added": 2, "removed": float64(1)}},
		{ID: "read", Kind: "read", Title: "Read README.md", Detail: "README.md"},
		{ID: "agent", Kind: "subagent", Title: "Count lines", Detail: "Explore", Summary: "Done (1 tool use)"},
		{ID: "todo", Kind: "todo", Title: "TodoWrite", Summary: "1 of 2 done"},
		{ID: "question", Kind: "question", Title: "Continue?"},
		{ID: "skill", Kind: "skill", Title: "Skill: review"},
		{ID: "thinking", Kind: "thinking", Title: "private reasoning heading", Body: "private reasoning"},
		{ID: "a", Kind: "assistant", Body: "Answer"},
	})
	if len(rows) != 11 {
		t.Fatalf("got %d rows, want 11: %+v", len(rows), rows)
	}
	byID := make(map[string]chatMessage, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	bash := byID["bash"]
	if !bash.Tools || bash.Tool == nil || bash.Tool.Kind != "bash" || bash.Tool.Result != "Exit code 1" || bash.Tool.Finished == nil || *bash.Tool.Finished || bash.Tool.IsError == nil || !*bash.Tool.IsError {
		t.Fatalf("unexpected bash summary: %+v", bash)
	}
	if got := len([]rune(bash.Tool.Title)); got > 121 {
		t.Fatalf("title has %d runes, want at most 121", got)
	}
	if got := len([]rune(bash.Tool.Target)); got > 201 || strings.Contains(bash.Tool.Target, "second line") {
		t.Fatalf("target was not truncated to one line: %q", bash.Tool.Target)
	}
	edit := byID["edit"].Tool
	if edit == nil || edit.Path != "hello.go" || edit.Added == nil || *edit.Added != 2 || edit.Removed == nil || *edit.Removed != 1 {
		t.Fatalf("unexpected edit summary: %+v", edit)
	}
	for _, id := range []string{"tool", "read", "agent", "todo", "question", "skill"} {
		if byID[id].Tool == nil || byID[id].Tool.Title == "" {
			t.Fatalf("%s lost its compact title: %+v", id, byID[id])
		}
	}
	if thinking := byID["thinking"].Tool; thinking == nil || thinking.Kind != "thinking" || thinking.Title != "Thinking" || thinking.Detail != "private reasoning" {
		t.Fatalf("existing reasoning should be available collapsed: %+v", byID["thinking"])
	}
	data, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "SECRET_OUTPUT") || strings.Contains(string(data), "SECRET_INPUT") {
		t.Fatalf("full tool input or output leaked: %s", data)
	}
	if !strings.Contains(string(data), `"tools":true`) || !strings.Contains(string(data), `"content":"Answer"`) {
		t.Fatalf("backward-compatible fields missing: %s", data)
	}
}

func TestChatMessagesIncrementalToolResult(t *testing.T) {
	finished := true
	rows := chatMessages([]query.Row{{ID: "tool-1", Summary: "Exit code 0", Finished: &finished, Meta: map[string]any{"added": 3, "removed": 1}}})
	if len(rows) != 1 || !rows[0].Tools || rows[0].Tool == nil || rows[0].Tool.Result != "Exit code 0" || rows[0].Tool.Finished == nil || !*rows[0].Tool.Finished {
		t.Fatalf("incremental tool result was dropped: %+v", rows)
	}
	if rows[0].Tool.Added == nil || *rows[0].Tool.Added != 3 || rows[0].Tool.Removed == nil || *rows[0].Tool.Removed != 1 {
		t.Fatalf("incremental edit counts were dropped: %+v", rows[0].Tool)
	}
}

func TestSessionChatHistoryToolProgress(t *testing.T) {
	srv := newChatTestServer(t)
	inst, _, _, _ := srv.loadChatSession("chat-session")
	inst.Tool = "claude"
	inst.ClaudeSessionID = "tool-progress"
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	path := session.ClaudeTranscriptPathForInstance(inst)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	transcript := `{"type":"assistant","uuid":"turn","message":{"content":[{"type":"thinking","thinking":"Inspect the file first"},{"type":"tool_use","id":"edit","name":"Edit","input":{"file_path":"/tmp/app.go","old_string":"SECRET_INPUT","new_string":"replacement"}}]}}` + "\n"
	if err := os.WriteFile(path, []byte(transcript), 0600); err != nil {
		t.Fatal(err)
	}
	var page struct {
		Messages []chatMessage `json:"messages"`
		Updates  []chatMessage `json:"updates"`
		Through  string        `json:"through_cursor"`
	}
	rr := chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1", "")
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &page) != nil || len(page.Messages) != 2 {
		t.Fatalf("initial history: status=%d body=%s", rr.Code, rr.Body.String())
	}
	edit := page.Messages[1].Tool
	if strings.Contains(rr.Body.String(), "SECRET_") {
		t.Fatalf("tool input leaked: %s", rr.Body.String())
	}
	if edit == nil || edit.Kind != "edit" || edit.Path != "/tmp/app.go" || edit.Finished == nil || *edit.Finished {
		t.Fatalf("missing live edit summary: %+v", edit)
	}
	transcript += `{"type":"user","uuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"edit","content":"SECRET_OUTPUT"}]},"toolUseResult":{"structuredPatch":[{"lines":["-old","+new","+extra"]}]}}` + "\n"
	if err := os.WriteFile(path, []byte(transcript), 0600); err != nil {
		t.Fatal(err)
	}
	rr = chatRequest(srv, "GET", "/api/sessions/chat-session/output?history=1&since="+url.QueryEscape(page.Through), "")
	page.Messages, page.Updates = nil, nil
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &page) != nil || len(page.Updates) != 1 {
		t.Fatalf("incremental history: status=%d body=%s", rr.Code, rr.Body.String())
	}
	edit = page.Updates[0].Tool
	if edit == nil || edit.Added == nil || *edit.Added != 2 || edit.Removed == nil || *edit.Removed != 1 || edit.Finished == nil || !*edit.Finished {
		t.Fatalf("missing completed edit counts: %+v", edit)
	}
	if strings.Contains(rr.Body.String(), "SECRET_") {
		t.Fatalf("tool body leaked: %s", rr.Body.String())
	}
}
