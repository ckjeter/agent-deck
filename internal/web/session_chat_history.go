package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/asheshgoplani/agent-deck/internal/recall/query"
	"github.com/asheshgoplani/agent-deck/internal/session"
)

const chatHistoryPageSize = 60

type chatMessage struct {
	ID        string    `json:"id"`
	Role      string    `json:"role,omitempty"`
	Content   string    `json:"content,omitempty"`
	Timestamp string    `json:"timestamp,omitempty"`
	Tools     bool      `json:"tools,omitempty"`
	Tool      *chatTool `json:"tool,omitempty"`
	Queued    *bool     `json:"queued,omitempty"`
}

type chatTool struct {
	Kind     string `json:"kind,omitempty"`
	Title    string `json:"title,omitempty"`
	Target   string `json:"target,omitempty"`
	Result   string `json:"result,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Path     string `json:"path,omitempty"`
	Added    *int   `json:"added,omitempty"`
	Removed  *int   `json:"removed,omitempty"`
	Finished *bool  `json:"finished,omitempty"`
	IsError  *bool  `json:"is_error,omitempty"`
}

func compactChatField(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return value
}

func chatMetaString(meta map[string]any, key string) string {
	value, _ := meta[key].(string)
	return value
}

func chatMetaInt(meta map[string]any, key string) *int {
	value, present := meta[key]
	if !present {
		return nil
	}
	var number int
	switch value := value.(type) {
	case int:
		number = value
	case int64:
		number = int(value)
	case float64:
		number = int(value)
	case json.Number:
		parsed, err := value.Int64()
		if err != nil {
			return nil
		}
		number = int(parsed)
	default:
		return nil
	}
	return &number
}

func chatToolTitle(kind string) string {
	switch kind {
	case "bash":
		return "Run command"
	case "edit":
		return "Edit file"
	case "read":
		return "Read file"
	case "subagent":
		return "Subagent"
	case "todo":
		return "Update tasks"
	case "question":
		return "Question"
	case "skill":
		return "Skill"
	case "thinking":
		return "Thinking"
	default:
		return "Tool"
	}
}

func summarizeChatTool(row query.Row) *chatTool {
	tool := &chatTool{
		Kind: row.Kind, Title: compactChatField(row.Title, 120),
		Target: compactChatField(strings.SplitN(row.Detail, "\n", 2)[0], 200), Result: compactChatField(row.Summary, 200),
		Finished: row.Finished, IsError: row.IsError,
		Added: chatMetaInt(row.Meta, "added"), Removed: chatMetaInt(row.Meta, "removed"),
	}
	if tool.Title == "" && row.Kind != "" {
		tool.Title = chatToolTitle(row.Kind)
	}
	if tool.Result == "" {
		tool.Result = compactChatField(chatMetaString(row.Meta, "status"), 200)
	}
	if tool.Target == "" {
		tool.Target = compactChatField(chatMetaString(row.Meta, "path"), 200)
	}
	if row.Kind == "edit" {
		tool.Path = compactChatField(row.Detail, 240)
		if tool.Path == "" {
			tool.Path = compactChatField(chatMetaString(row.Meta, "path"), 240)
		}
	}
	if row.Kind == "thinking" {
		tool.Title = "Thinking"
		tool.Detail = compactChatField(row.Body, 1200)
	}
	return tool
}

func chatMessages(rows []query.Row) []chatMessage {
	messages := make([]chatMessage, 0, len(rows))
	for _, row := range rows {
		m := chatMessage{ID: row.ID, Timestamp: row.TS, Queued: row.Queued}
		switch row.Kind {
		case "user", "assistant":
			m.Role, m.Content = row.Kind, row.Body
		case "command":
			m.Role, m.Content = "user", row.Title
		case "tool", "bash", "edit", "read", "subagent", "todo", "question", "skill", "thinking":
			m.Role, m.Tools, m.Tool = "assistant", true, summarizeChatTool(row)
		case "":
			if row.Queued == nil && (row.Finished != nil || row.IsError != nil || row.Summary != "") {
				m.Role, m.Tools, m.Tool = "assistant", true, summarizeChatTool(row)
			} else if row.Queued == nil {
				continue
			}
		default:
			continue
		}
		messages = append(messages, m)
	}
	return messages
}

// handleChatHistory returns false only when the session has no native history.
func (s *Server) handleChatHistory(w http.ResponseWriter, r *http.Request, inst *session.Instance, peers []*session.Instance) bool {
	if !inst.TranscriptIsResolvableLocally() {
		return false
	}
	var src query.RowsSource
	var version string
	switch {
	case session.IsClaudeCompatible(inst.Tool):
		path, err := inst.GetJSONLPathChecked(peers)
		if err != nil {
			writeAPIError(w, http.StatusConflict, ErrCodeBadRequest, "session transcript is shared by live sessions")
			return true
		}
		src = query.RowsSource{Harness: "claude", Path: path}
		version = inst.ResponseContentVersion(peers)
	case session.IsCodexCompatible(inst.Tool):
		src = query.RowsSource{Harness: "codex", Path: session.CodexRolloutPathForInstance(inst)}
		version = inst.ResponseContentVersion(peers)
	case inst.Tool == "pi":
		path, fileVersion, err := session.PiChatTranscript(inst)
		if err != nil {
			if r.URL.Query().Get("since") != "" || r.URL.Query().Get("before") != "" {
				writeAPIError(w, http.StatusConflict, ErrCodeBadRequest, "conversation changed; reload history")
				return true
			}
			return false
		}
		src = query.RowsSource{Harness: "pi", Path: path}
		version = fileVersion
	default:
		return false
	}
	if src.Path == "" {
		return false
	}
	if version != "" {
		version += ":history"
	}
	if r.URL.Query().Get("before") == "" && version != "" && version == r.URL.Query().Get("if-version") {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	opts := query.RowsOptions{Since: r.URL.Query().Get("since"), Before: r.URL.Query().Get("before")}
	if opts.Before != "" {
		opts.Limit = chatHistoryPageSize
	} else if opts.Since == "" {
		opts.Tail = chatHistoryPageSize
	}
	timeline, err := query.ReadRows(r.Context(), src, opts)
	if err != nil {
		var resync *query.ResyncError
		if errors.As(err, &resync) {
			writeAPIError(w, http.StatusConflict, ErrCodeBadRequest, "conversation changed; reload history")
		} else {
			writeAPIError(w, http.StatusInternalServerError, ErrCodeInternalError, "failed to read conversation history")
		}
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
	}{chatMessages(timeline.Turns), chatMessages(timeline.Updates), timeline.Removed,
		timeline.BeforeCursor, timeline.ThroughCursor, len(timeline.Turns) >= chatHistoryPageSize, version})
	return true
}
