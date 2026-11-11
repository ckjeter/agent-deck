package web

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/sendqueue"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"golang.org/x/time/rate"
)

func composerPane(tool, body string) string {
	if tool == "codex" {
		return "• Previous response\n\n› " + body + "\n\n  gpt-5.3-codex · 100% left · /tmp/project\n"
	}
	return "● Previous response\n──────────────────────────────\n❯ " + body + "\n──────────────────────────────\n  ? for shortcuts\n"
}

func composerServer(t *testing.T, tool string, panes ...string) (*Server, *inputTarget) {
	t.Helper()
	srv := newChatTestServer(t)
	inst, _, _, _ := srv.loadChatSession("chat-session")
	inst.Tool = tool
	target := &inputTarget{panes: panes}
	srv.composerTarget = func(*session.Instance) send.CodexApprovalTarget { return target }
	return srv, target
}

func getComposer(t *testing.T, srv *Server) composerResponse {
	t.Helper()
	rr := chatRequest(srv, "GET", "/api/sessions/chat-session/composer", "")
	var result composerResponse
	if json.Unmarshal(rr.Body.Bytes(), &result) != nil || rr.Code != 200 {
		t.Fatalf("inspect: %d %s", rr.Code, rr.Body.String())
	}
	return result
}

func takeComposer(srv *Server, fingerprint string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"fingerprint": fingerprint})
	return chatRequest(srv, "POST", "/api/sessions/chat-session/composer/take", string(body))
}

func TestComposerInspection(t *testing.T) {
	for _, tool := range []string{"claude", "codex"} {
		for _, tc := range []struct {
			name, body, want string
			suggestion       bool
		}{
			{"foreign", "Review 中文 deployment", "Review 中文 deployment", false},
			{"empty", "", "", false},
			{"suggestion", "\x1b[2mReview deployment\x1b[0m", "", true},
		} {
			t.Run(tool+"/"+tc.name, func(t *testing.T) {
				srv, target := composerServer(t, tool, composerPane(tool, tc.body))
				result := getComposer(t, srv)
				if !result.Visible || result.Draft != tc.want || result.Foreign != (tc.want != "") || result.Suggestion != tc.suggestion || result.ObservedAt == "" || len(target.keys) != 0 {
					t.Fatalf("result=%+v keys=%v", result, target.keys)
				}
			})
		}
	}
	for _, tool := range []string{"claude", "codex"} {
		placeholder := `Try "write a test for <filepath>"`
		if tool == "codex" {
			placeholder = "Ask Codex to do anything"
		}
		srv, _ := composerServer(t, tool, composerPane(tool, placeholder))
		if result := getComposer(t, srv); result.Foreign || result.Draft != "" {
			t.Fatalf("placeholder: %+v", result)
		}
	}
}

func TestComposerOwnPayload(t *testing.T) {
	for _, tool := range []string{"claude", "codex"} {
		for _, state := range []string{sendqueue.StateTyping, sendqueue.StateTyped, sendqueue.StateQueued, sendqueue.StateLanded} {
			t.Run(tool+"/"+state, func(t *testing.T) {
				pane := composerPane(tool, "Payload from phone")
				records := []*sendqueue.Record{{Message: "Payload from phone", State: state}}
				result := inspectComposer(pane, tool, "work", "one", records)
				wantForeign := state == sendqueue.StateQueued || state == sendqueue.StateLanded
				if result.Foreign != wantForeign {
					t.Fatalf("own payload: %+v", result)
				}
				result = inspectComposer(composerPane(tool, "Payload from phone plus foreign text"), tool, "work", "one", records)
				if !result.Foreign {
					t.Fatalf("foreign continuation: %+v", result)
				}
			})
		}
	}
}

func TestComposerTakeSerializedWithSends(t *testing.T) {
	srv, target := composerServer(t, "claude", composerPane("claude", "draft"))
	fingerprint := getComposer(t, srv).Fingerprint
	lock, err := session.AcquireSendLock("chat-session", time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	rr := takeComposer(srv, fingerprint)
	if rr.Code != 409 || !strings.Contains(rr.Body.String(), "TARGET_BUSY") || len(target.keys) != 0 {
		t.Fatalf("%d %s keys=%v", rr.Code, rr.Body.String(), target.keys)
	}
}

func TestComposerReadOnlyInspectionAndMethods(t *testing.T) {
	srv, target := composerServer(t, "claude", composerPane("claude", "draft"))
	srv.cfg.ReadOnly = true
	if !getComposer(t, srv).Foreign || len(target.keys) != 0 {
		t.Fatal("read-only inspection must preserve draft")
	}
	for _, tc := range []struct {
		method, path, body string
		want               int
	}{
		{"POST", "composer", "", 405},
		{"GET", "composer/take", "", 405},
	} {
		rr := chatRequest(srv, tc.method, "/api/sessions/chat-session/"+tc.path, tc.body)
		if rr.Code != tc.want {
			t.Fatalf("%d %s", rr.Code, rr.Body.String())
		}
	}
}

func TestComposerDoesNotClearDialogs(t *testing.T) {
	for _, tc := range []struct{ tool, pane string }{
		{"codex", inputPane},
		{"claude", "Do you trust this folder?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel"},
	} {
		srv, target := composerServer(t, tc.tool, tc.pane)
		result := getComposer(t, srv)
		if result.Foreign || result.Visible || result.Draft != "" {
			t.Fatalf("dialog treated as draft: %+v", result)
		}
		rr := takeComposer(srv, "stale-fingerprint")
		if rr.Code != 409 || len(target.keys) != 0 {
			t.Fatalf("dialog mutated: %d %s %v", rr.Code, rr.Body.String(), target.keys)
		}
	}
}

func TestComposerTake(t *testing.T) {
	for _, tool := range []string{"claude", "codex"} {
		t.Run(tool, func(t *testing.T) {
			pane := composerPane(tool, "Owner draft 中文")
			srv, target := composerServer(t, tool, pane, pane, pane, pane, composerPane(tool, ""))
			result := getComposer(t, srv)
			rr := takeComposer(srv, result.Fingerprint)
			if rr.Code != 200 || !strings.Contains(rr.Body.String(), `"draft":"Owner draft 中文"`) || !strings.Contains(rr.Body.String(), `"verified":true`) || strings.Join(target.keys, ",") != "C-e,C-u" {
				t.Fatalf("take: %d %s keys=%v", rr.Code, rr.Body.String(), target.keys)
			}
		})
	}
}

func TestComposerTakeChangedAndUnconfirmed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		panes []string
		code  string
		keys  int
	}{
		{"changed", []string{"first", "other"}, "DRAFT_CHANGED", 0},
		{"changed before key", []string{"first", "first", "other"}, "DRAFT_CHANGED", 0},
		{"changed before clear", []string{"first", "first", "first", "other"}, "DRAFT_CHANGED", 1},
		{"not cleared", []string{"first"}, "CLEAR_UNCONFIRMED", 2},
		{"paste marker", []string{"[Pasted text #1 +89 lines]"}, "DRAFT_UNREADABLE", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			panes := make([]string, len(tc.panes))
			for i, body := range tc.panes {
				panes[i] = composerPane("claude", body)
			}
			srv, target := composerServer(t, "claude", panes...)
			rr := takeComposer(srv, getComposer(t, srv).Fingerprint)
			if rr.Code != 409 || !strings.Contains(rr.Body.String(), tc.code) || len(target.keys) != tc.keys {
				t.Fatalf("%d %s keys=%v", rr.Code, rr.Body.String(), target.keys)
			}
			if tc.code == "CLEAR_UNCONFIRMED" && !strings.Contains(rr.Body.String(), `"draft":"first"`) {
				t.Fatal("lost recovery text")
			}
		})
	}
}

func TestComposerTakeGuards(t *testing.T) {
	for _, name := range []string{"readonly", "disabled", "auth", "csrf", "rate", "identity"} {
		t.Run(name, func(t *testing.T) {
			srv, target := composerServer(t, "codex", composerPane("codex", "draft"))
			fingerprint := getComposer(t, srv).Fingerprint
			want := 403
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
			case "identity":
				fingerprint = "other-profile-or-session"
				want = 409
			}
			var rr *httptest.ResponseRecorder
			if name == "csrf" {
				rr = httptest.NewRecorder()
				req := newLocalRequest("POST", "/api/sessions/chat-session/composer/take", strings.NewReader(`{}`))
				req.Header.Set("Origin", "https://evil.example")
				srv.Handler().ServeHTTP(rr, req)
			} else {
				rr = takeComposer(srv, fingerprint)
			}
			if rr.Code != want || len(target.keys) != 0 {
				t.Fatalf("%d %s keys=%v", rr.Code, rr.Body.String(), target.keys)
			}
		})
	}
}
