package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/asheshgoplani/agent-deck/internal/session"
)

func TestRemoteChatRequiresAuthorization(t *testing.T) {
	srv := NewServer(Config{Token: "secret"})
	for _, action := range []string{"output", "send", "send-status"} {
		rr := chatRequest(srv, http.MethodGet, "/api/remotes/oracle/sessions/remote-1/"+action, "")
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status=%d body=%s", action, rr.Code, rr.Body.String())
		}
	}
}

type fakeRemoteChatRunner struct {
	calls  [][]string
	input  string
	help   string
	output string
	record remoteChatSend
	fail   bool
}

func (f *fakeRemoteChatRunner) RunIO(_ context.Context, input io.Reader, stdout, _ io.Writer, args ...string) error {
	f.calls = append(f.calls, append([]string(nil), args...))
	if f.fail {
		return fmt.Errorf("ssh failed with private diagnostics")
	}
	if input != nil {
		data, _ := io.ReadAll(input)
		f.input = string(data)
	}
	if args[1] == "output" {
		_, _ = io.WriteString(stdout, f.output)
		return nil
	}
	if args[len(args)-1] == "--help" {
		_, _ = io.WriteString(stdout, f.help)
		return nil
	}
	return json.NewEncoder(stdout).Encode(f.record)
}

func remoteChatTestServer() (*Server, *fakeRemoteChatRunner) {
	runner := &fakeRemoteChatRunner{help: "-require-input-prompt -message-file -queue", output: `{"content":"Remote **reply**","content_version":"v1"}`,
		record: remoteChatSend{SendID: "01KADJ6QDB0000000000000000", SessionID: "remote-1", State: "queued", Message: "remote message"}}
	srv := NewServer(Config{WebMutations: true, RemoteFleet: &fakeRemoteFleetLoader{snapshot: session.RemoteFleetSnapshot{
		Remotes: []session.RemoteFleetRemote{{Name: "oracle", Online: true, Sessions: []session.RemoteSessionInfo{{ID: "remote-1", Title: "Remote"}}}},
	}}})
	srv.remoteChatRunner = func(name string) (remoteChatRunner, error) {
		if name != "oracle" {
			return nil, fmt.Errorf("unexpected remote")
		}
		return runner, nil
	}
	return srv, runner
}

const remoteChatPath = "/api/remotes/oracle/sessions/remote-1/"

func TestRemoteChatOutputVersion(t *testing.T) {
	srv, runner := remoteChatTestServer()
	rr := chatRequest(srv, "GET", remoteChatPath+"output", "")
	if rr.Code != 200 || !strings.Contains(rr.Body.String(), "Remote **reply**") {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	if got := strings.Join(runner.calls[0], " "); got != "session output remote-1 --json" {
		t.Fatal(got)
	}
	runner.output = `{"unchanged":true,"content_version":"v1"}`
	rr = chatRequest(srv, "GET", remoteChatPath+"output?if-version=v1", "")
	if rr.Code != 204 || rr.Body.Len() != 0 {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
	if got := strings.Join(runner.calls[1], " "); got != "session output remote-1 --json --if-version v1" {
		t.Fatal(got)
	}
	runner.output = `{"content":"older remote"}`
	rr = chatRequest(srv, "GET", remoteChatPath+"output", "")
	var data struct {
		Version string `json:"content_version"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	rr = chatRequest(srv, "GET", remoteChatPath+"output?if-version="+data.Version, "")
	if rr.Code != 204 {
		t.Fatalf("fallback status=%d", rr.Code)
	}
	if got := strings.Join(runner.calls[3], " "); strings.Contains(got, "--if-version") {
		t.Fatal(got)
	}
}

func TestRemoteChatSendAndStatus(t *testing.T) {
	srv, runner := remoteChatTestServer()
	text := "你好\nDictation, paste `echo $HOME` and 'quotes'"
	payload, _ := json.Marshal(map[string]string{"text": text})
	rr := chatRequest(srv, "POST", remoteChatPath+"send", string(payload))
	if rr.Code != 202 || runner.input != text {
		t.Fatalf("status=%d input=%q body=%s", rr.Code, runner.input, rr.Body.String())
	}
	want := "session send remote-1 --message-file - --queue --json --no-tag --ignore-budget --require-input-prompt"
	if got := strings.Join(runner.calls[1], " "); got != want {
		t.Fatal(got)
	}
	for _, state := range []string{"queued", "typing", "submitted", "landed", "failed"} {
		runner.record.State = state
		rr = chatRequest(srv, "GET", remoteChatPath+"send-status?send-id="+runner.record.SendID, "")
		if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"state":"`+state+`"`) {
			t.Fatalf("%d %s", rr.Code, rr.Body.String())
		}
	}
	runner.record.SessionID = "another-session"
	rr = chatRequest(srv, "GET", remoteChatPath+"send-status?send-id="+runner.record.SendID, "")
	if rr.Code != 502 {
		t.Fatalf("cross-session status=%d", rr.Code)
	}
}

func TestRemoteChatGatesBeforeSSH(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body string
		code                     int
		setup                    func(*Server)
	}{
		{"read-only", "POST", "send", `{"text":"hi"}`, 403, func(s *Server) { s.cfg.ReadOnly = true }},
		{"mutations off", "POST", "send", `{"text":"hi"}`, 403, func(s *Server) { s.cfg.WebMutations = false }},
		{"status worker read-only", "GET", "send-status?send-id=01KADJ6QDB0000000000000000", "", 403, func(s *Server) { s.cfg.ReadOnly = true }},
		{"bad body", "POST", "send", `{`, 400, nil},
		{"empty text", "POST", "send", `{"text":" "}`, 400, nil},
		{"bad status id", "GET", "send-status?send-id=--help", "", 400, nil},
		{"wrong method", "GET", "send", "", 405, nil},
		{"unknown action", "GET", "terminal", "", 404, nil},
		{"offline", "GET", "output", "", 503, func(s *Server) { s.remoteFleet.(*fakeRemoteFleetLoader).snapshot.Remotes[0].Online = false }},
		{"archived", "GET", "output", "", 404, func(s *Server) {
			s.remoteFleet.(*fakeRemoteFleetLoader).snapshot.Remotes[0].Sessions[0].Archived = true
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, runner := remoteChatTestServer()
			if tc.setup != nil {
				tc.setup(srv)
			}
			rr := chatRequest(srv, tc.method, remoteChatPath+tc.path, tc.body)
			if rr.Code != tc.code || len(runner.calls) != 0 {
				t.Fatalf("status=%d calls=%v body=%s", rr.Code, runner.calls, rr.Body.String())
			}
		})
	}
	srv, runner := remoteChatTestServer()
	for _, path := range []string{"/api/remotes/missing/sessions/remote-1/output", "/api/remotes/oracle/sessions/missing/output"} {
		if rr := chatRequest(srv, "GET", path, ""); rr.Code != 404 {
			t.Fatalf("status=%d", rr.Code)
		}
	}
	req := newLocalRequest("POST", remoteChatPath+"send", strings.NewReader(`{"text":"hi"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != 403 || len(runner.calls) != 0 {
		t.Fatalf("csrf status=%d calls=%v", rr.Code, runner.calls)
	}
}

func TestRemoteChatUnsupportedAndAmbiguousDelivery(t *testing.T) {
	srv, runner := remoteChatTestServer()
	runner.help = "old remote help"
	rr := chatRequest(srv, "POST", remoteChatPath+"send", `{"text":"hi"}`)
	if rr.Code != 501 || len(runner.calls) != 1 {
		t.Fatalf("%d %v", rr.Code, runner.calls)
	}
	runner.fail = true
	rr = chatRequest(srv, "GET", remoteChatPath+"output", "")
	if rr.Code != 502 || strings.Contains(rr.Body.String(), "private diagnostics") {
		t.Fatalf("%d %s", rr.Code, rr.Body.String())
	}
}

type remoteHistoryRunner struct {
	*fakeRemoteChatRunner
	history  string
	err      error
	deadline bool
}

func (f *remoteHistoryRunner) RunIO(ctx context.Context, input io.Reader, stdout, stderr io.Writer, args ...string) error {
	if args[0] != "recall" {
		return f.fakeRemoteChatRunner.RunIO(ctx, input, stdout, stderr, args...)
	}
	_, f.deadline = ctx.Deadline()
	f.calls = append(f.calls, append([]string(nil), args...))
	if _, err := io.WriteString(stdout, f.history); err != nil {
		return err
	}
	return f.err
}

func TestRemoteChatHistory(t *testing.T) {
	srv, base := remoteChatTestServer()
	runner := &remoteHistoryRunner{fakeRemoteChatRunner: base}
	srv.remoteChatRunner = func(string) (remoteChatRunner, error) { return runner, nil }
	rows := make([]map[string]string, chatHistoryPageSize)
	for i := range rows {
		rows[i] = map[string]string{"id": fmt.Sprint(i), "kind": "assistant", "body": fmt.Sprintf("reply %d", i)}
	}
	setHistory := func(turns any, through string) {
		data, _ := json.Marshal(map[string]any{"session": map[string]string{"id": "remote-1"}, "turns": turns, "before_cursor": "older", "through_cursor": through, "updates": []map[string]string{{"id": "0", "kind": "assistant", "body": "updated"}}, "removed": []string{"gone"}})
		runner.history = string(data)
	}
	setHistory(rows, "current")
	var body struct {
		Messages []chatMessage `json:"messages"`
		Updates  []chatMessage `json:"updates"`
		Removed  []string      `json:"removed"`
		Before   string        `json:"before_cursor"`
		Through  string        `json:"through_cursor"`
		Version  string        `json:"content_version"`
		HasMore  bool          `json:"has_more"`
	}
	rr := chatRequest(srv, "GET", remoteChatPath+"output?history=1", "")
	if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &body) != nil || len(body.Messages) != 60 || body.Messages[0].Content != "reply 0" || !body.HasMore || body.Before != "older" || body.Through != "current" || len(body.Updates) != 1 || len(body.Removed) != 1 || !runner.deadline {
		t.Fatalf("history: %d %s deadline=%v", rr.Code, rr.Body.String(), runner.deadline)
	}
	if got := strings.Join(runner.calls[0], " "); got != "recall timeline remote-1 --json --tail 60" {
		t.Fatal(got)
	}
	version := body.Version
	rr = chatRequest(srv, "GET", remoteChatPath+"output?history=1&since=current&if-version="+version, "")
	if rr.Code != 204 {
		t.Fatalf("unchanged: %d %s", rr.Code, rr.Body.String())
	}
	setHistory(rows[:1], "next")
	for _, tc := range []struct{ query, want string }{
		{"before=older", "--before older --limit 60"},
		{"since=current", "--since current"},
		{"since=" + strings.Repeat("a", 1200), "--since " + strings.Repeat("a", 1200)},
	} {
		rr = chatRequest(srv, "GET", remoteChatPath+"output?history=1&"+tc.query, "")
		if rr.Code != 200 || json.Unmarshal(rr.Body.Bytes(), &body) != nil || body.HasMore || body.Version == version || !strings.HasSuffix(strings.Join(runner.calls[len(runner.calls)-1], " "), tc.want) {
			t.Fatalf("%s: %d %s", tc.query, rr.Code, rr.Body.String())
		}
	}
}

func TestRemoteChatHistoryFallbackAndBounds(t *testing.T) {
	for _, tc := range []struct {
		name, history string
		err           error
		query         string
		code          int
		fallback      bool
	}{
		{"missing", `{"code":"NOT_FOUND"}`, fmt.Errorf("exit 1"), "", 200, true},
		{"old CLI", "unknown command recall", fmt.Errorf("exit 1"), "", 200, true},
		{"malformed", `{`, nil, "", 200, true},
		{"wrong session", `{"session":{"id":"other"},"through_cursor":"cursor"}`, nil, "", 200, true},
		{"resync", `{"code":"RESYNC_REQUIRED"}`, fmt.Errorf("exit 1"), "&since=stale", 409, false},
		{"oversize", strings.Repeat("x", remoteChatHistoryMaxBytes+1), nil, "", 502, false},
		{"bad cursor", "", nil, "&before=--help", 400, false},
		{"combined cursors", "", nil, "&before=older&since=current", 400, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, base := remoteChatTestServer()
			runner := &remoteHistoryRunner{fakeRemoteChatRunner: base, history: tc.history, err: tc.err}
			srv.remoteChatRunner = func(string) (remoteChatRunner, error) { return runner, nil }
			rr := chatRequest(srv, "GET", remoteChatPath+"output?history=1"+tc.query, "")
			if rr.Code != tc.code || (tc.fallback && (!strings.Contains(rr.Body.String(), `"latest_only":true`) || len(runner.calls) != 2)) {
				t.Fatalf("%d %s calls=%v", rr.Code, rr.Body.String(), runner.calls)
			}
		})
	}
}

func TestRemoteChatCodexChrome(t *testing.T) {
	pane := "• Reply with › preserved.\n\n⚠ Heads up, you have less than 25% of your 5h limit left. Run /status for a breakdown.\n\n› Draft to keep private\n  GPT-6.1-Sol medium · ~/project · Session title\n  ← for agents · ? for shortcuts"
	for _, tool := range []string{"codex", "claude"} {
		t.Run(tool, func(t *testing.T) {
			srv, runner := remoteChatTestServer()
			srv.remoteFleet.(*fakeRemoteFleetLoader).snapshot.Remotes[0].Sessions[0].Tool = tool
			body, err := json.Marshal(map[string]string{"content": pane})
			if err != nil {
				t.Fatal(err)
			}
			runner.output = string(body)
			rr := chatRequest(srv, "GET", remoteChatPath+"output", "")
			var result struct {
				Content    string `json:"content"`
				Version    string `json:"content_version"`
				LatestOnly bool   `json:"latest_only"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			want := pane
			if tool == "codex" {
				want = "• Reply with › preserved."
			}
			if rr.Code != 200 || result.Content != want || !result.LatestOnly {
				t.Fatalf("status=%d result=%+v", rr.Code, result)
			}
			if rr := chatRequest(srv, "GET", remoteChatPath+"output?if-version="+result.Version, ""); rr.Code != 204 {
				t.Fatalf("repeat status=%d", rr.Code)
			}
		})
	}
}

func TestRemoteChatVersionedCodexResponsePreservesText(t *testing.T) {
	srv, runner := remoteChatTestServer()
	srv.remoteFleet.(*fakeRemoteFleetLoader).snapshot.Remotes[0].Sessions[0].Tool = "codex"
	content := "Example pane:\n› Ask Codex to do anything\n  GPT-6.1-Sol medium · ~/project · Example\n  ← for agents · ? for shortcuts"
	body, err := json.Marshal(map[string]string{"content": content, "content_version": "v1-structured-rollout"})
	if err != nil {
		t.Fatal(err)
	}
	runner.output = string(body)
	rr := chatRequest(srv, "GET", remoteChatPath+"output", "")
	var result struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if rr.Code != 200 || result.Content != content {
		t.Fatalf("status=%d content=%q", rr.Code, result.Content)
	}
}
