package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"golang.org/x/time/rate"
)

const inputPane = `  Would you like to run the following command?

  $ curl https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl (p)
  3. No, and tell Codex what to do differently (esc)
`

type inputTarget struct {
	panes []string
	index int
	keys  []string
}

func (f *inputTarget) CapturePaneFresh() (string, error) {
	i := f.index
	if i >= len(f.panes) {
		i = len(f.panes) - 1
	}
	f.index++
	return f.panes[i], nil
}

func (f *inputTarget) SendNamedKey(key string) error {
	f.keys = append(f.keys, key)
	return nil
}

func newInputTest(t *testing.T, panes ...string) (*Server, *inputTarget, string) {
	t.Helper()
	srv := newChatTestServer(t)
	target := &inputTarget{panes: panes}
	srv.inputPromptTarget = func(*session.Instance) send.CodexApprovalTarget { return target }
	srv.inputPromptVerify = send.CodexApprovalOptions{VerifyTimeout: time.Millisecond, PollInterval: time.Millisecond}
	rr := chatRequest(srv, "GET", "/api/sessions/chat-session/input-prompt", "")
	var prompt inputPromptResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &prompt); err != nil || rr.Code != 200 {
		t.Fatalf("inspect: %d %s %v", rr.Code, rr.Body.String(), err)
	}
	return srv, target, prompt.PromptID
}

func chooseInput(srv *Server, id, choice string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"prompt_id": id, "choice": choice})
	return chatRequest(srv, "POST", "/api/sessions/chat-session/input-prompt/choice", string(body))
}

func TestInputPromptOutcomes(t *testing.T) {
	changed := strings.ReplaceAll(inputPane, "example.com", "other.example")
	for _, tc := range []struct {
		name, code string
		panes      []string
		want       int
		keys       int
	}{
		{"verified", `"outcome":"verified"`, []string{inputPane, inputPane, inputPane, inputPane, "› Continue"}, 200, 1},
		{"next prompt", `"outcome":"next_prompt"`, []string{inputPane, inputPane, inputPane, inputPane, changed}, 200, 1},
		{"changed at handler", "PROMPT_CHANGED", []string{inputPane, changed}, 409, 0},
		{"changed before approve", "PROMPT_CHANGED", []string{inputPane, inputPane, changed}, 409, 0},
		{"changed before key", "PROMPT_CHANGED", []string{inputPane, inputPane, inputPane, changed}, 409, 0},
		{"no prompt", "NO_PROMPT", []string{inputPane, "› Continue"}, 409, 0},
		{"unconfirmed", "OUTCOME_UNCONFIRMED", []string{inputPane}, 409, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, target, id := newInputTest(t, tc.panes...)
			rr := chooseInput(srv, id, "once")
			if rr.Code != tc.want || !strings.Contains(rr.Body.String(), tc.code) || len(target.keys) != tc.keys {
				t.Fatalf("status=%d body=%s keys=%v", rr.Code, rr.Body.String(), target.keys)
			}
			if tc.keys > 0 && !strings.Contains(rr.Body.String(), `"key_sent":true`) {
				t.Fatal("missing key_sent evidence")
			}
		})
	}
}

func TestInputPromptDoubleTapNeverReplays(t *testing.T) {
	srv, target, id := newInputTest(t, inputPane)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() { chooseInput(srv, id, "once") })
	}
	wg.Wait()
	if len(target.keys) != 1 {
		t.Fatalf("keys=%v", target.keys)
	}
	// A new inspection must not make an unconfirmed key replayable.
	chatRequest(srv, "GET", "/api/sessions/chat-session/input-prompt", "")
	rr := chooseInput(srv, id, "deny")
	if rr.Code != 409 || len(target.keys) != 1 {
		t.Fatalf("replayed: %d %s keys=%v", rr.Code, rr.Body.String(), target.keys)
	}
}

func TestInputPromptChoices(t *testing.T) {
	for _, tc := range []struct {
		choice, extra string
		want          int
	}{
		{"always", "", 400}, {"session", "", 400}, {"4", "", 400}, {"10", "", 400},
		{"2", "", 400}, {"2", `,"confirm_scope":true`, 409}, {"deny", "", 409},
	} {
		t.Run(tc.choice+tc.extra, func(t *testing.T) {
			srv, target, id := newInputTest(t, inputPane)
			body := `{"prompt_id":"` + id + `","choice":"` + tc.choice + `"` + tc.extra + `}`
			rr := chatRequest(srv, "POST", "/api/sessions/chat-session/input-prompt/choice", body)
			if rr.Code != tc.want {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if tc.want == 400 && len(target.keys) != 0 {
				t.Fatalf("invalid choice sent %v", target.keys)
			}
		})
	}
}

func TestInputPromptGuards(t *testing.T) {
	for _, name := range []string{"readonly", "disabled", "auth", "csrf", "rate", "wrong identity"} {
		t.Run(name, func(t *testing.T) {
			srv, target, id := newInputTest(t, inputPane)
			want := http.StatusForbidden
			switch name {
			case "readonly":
				srv.cfg.ReadOnly = true
			case "disabled":
				srv.cfg.WebMutations = false
			case "auth":
				srv.cfg.Token = "secret"
				want = 401
			case "rate":
				srv.mutationLimiter = rate.NewLimiter(0, 0)
				want = 429
			case "wrong identity":
				id = "another-profile-or-session"
				want = 409
			}
			var rr *httptest.ResponseRecorder
			if name == "csrf" {
				rr = httptest.NewRecorder()
				req := newLocalRequest("POST", "/api/sessions/chat-session/input-prompt/choice", strings.NewReader(`{}`))
				req.Header.Set("Origin", "https://evil.example")
				srv.Handler().ServeHTTP(rr, req)
			} else {
				rr = chooseInput(srv, id, "once")
			}
			if rr.Code != want || len(target.keys) != 0 {
				t.Fatalf("status=%d want=%d body=%s keys=%v", rr.Code, want, rr.Body.String(), target.keys)
			}
		})
	}
}

func TestInputPromptUnsupported(t *testing.T) {
	for _, name := range []string{"tool", "stopped", "ssh", "remote"} {
		t.Run(name, func(t *testing.T) {
			srv := newChatTestServer(t)
			inst, _, _, _ := srv.loadChatSession("chat-session")
			path := "/api/sessions/chat-session/input-prompt"
			switch name {
			case "tool":
				inst.Tool = "claude"
			case "ssh":
				inst.SSHHost = "test-host"
			case "remote":
				path = "/api/remotes/host/sessions/chat-session/input-prompt"
			}
			rr := chatRequest(srv, "GET", path, "")
			if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"supported":false`) || !strings.Contains(rr.Body.String(), `"reason":`) {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestInputPromptBindsResolvedProfileAndSession(t *testing.T) {
	for _, name := range []string{"profile", "session"} {
		t.Run(name, func(t *testing.T) {
			srv, target, id := newInputTest(t, inputPane)
			inst, _, _, _ := srv.loadChatSession("chat-session")
			profile := "_test"
			if name == "profile" {
				profile = "other-profile"
			} else {
				inst.ID = "other-session"
			}
			srv.menuData.(*SessionDataService).openStorage = func(string) (storageLoader, error) {
				return &fakeStorage{instances: []*session.Instance{inst}, profile: profile}, nil
			}
			body := `{"prompt_id":"` + id + `","choice":"once"}`
			rr := chatRequest(srv, "POST", "/api/sessions/"+inst.ID+"/input-prompt/choice", body)
			if rr.Code != 409 || !strings.Contains(rr.Body.String(), "PROMPT_CHANGED") || len(target.keys) != 0 {
				t.Fatalf("identity not bound: status=%d body=%s keys=%v", rr.Code, rr.Body.String(), target.keys)
			}
		})
	}
}
