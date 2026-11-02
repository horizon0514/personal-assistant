package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// ─── Sessions persistence (JSONL under config dir) ─────────────────────────────
type transcriptLine struct {
	Type      string `json:"type"` // "user" | "assistant"
	Text      string `json:"text"`
	Timestamp int64  `json:"ts"`
}

type sessionMeta struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	File         string `json:"file"` // absolute path to transcript .jsonl
	WorkspaceDir string `json:"workspaceDir,omitempty"`
	UpdatedAt    int64  `json:"updatedAt"`
	Primary      bool   `json:"primary,omitempty"`
}

type sessionIndex struct {
	Sessions []sessionMeta `json:"sessions"`
}

func appDataDir() string {
	if v := os.Getenv("CHATGO_DATA_DIR"); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		if home == "" {
			return "./chatgo-data"
		}
		return filepath.Join(home, ".config", "chatgo")
	}
	return filepath.Join(base, "chatgo")
}

func ensureDirs() (root, sessionsDir, indexPath string, err error) {
	root = appDataDir()
	sessionsDir = filepath.Join(root, "sessions")
	indexPath = filepath.Join(root, "sessions.json")
	if err = os.MkdirAll(sessionsDir, 0o755); err != nil {
		return
	}
	return
}

func loadSessionIndex() (sessionIndex, error) {
	root, _, indexPath, err := ensureDirs()
	if err != nil {
		return sessionIndex{}, err
	}
	f, err := os.Open(indexPath)
	if err != nil {
		if os.IsNotExist(err) {
			return sessionIndex{Sessions: []sessionMeta{}}, nil
		}
		return sessionIndex{}, err
	}
	defer f.Close()
	var idx sessionIndex
	if err := json.NewDecoder(f).Decode(&idx); err != nil && err != io.EOF {
		_ = os.Rename(indexPath, indexPath+".corrupt")
		return sessionIndex{Sessions: []sessionMeta{}}, nil
	}
	for i := range idx.Sessions {
		if !filepath.IsAbs(idx.Sessions[i].File) {
			idx.Sessions[i].File = filepath.Join(root, idx.Sessions[i].File)
		}
	}
	return idx, nil
}

func saveSessionIndex(idx sessionIndex) error {
	_, _, indexPath, err := ensureDirs()
	if err != nil {
		return err
	}
	tmp := indexPath + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&idx); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, indexPath)
}

func newSessionMeta(title string) (sessionMeta, error) {
	_, sessionsDir, _, err := ensureDirs()
	if err != nil {
		return sessionMeta{}, err
	}
	id := fmt.Sprintf("s-%d", time.Now().UnixNano())
	path := filepath.Join(sessionsDir, id+".jsonl")
	return sessionMeta{
		ID:        id,
		Title:     title,
		File:      path,
		UpdatedAt: time.Now().Unix(),
	}, nil
}

func appendTranscriptLine(sm *sessionMeta, line transcriptLine) error {
	f, err := os.OpenFile(sm.File, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(&line); err != nil {
		return err
	}
	sm.UpdatedAt = time.Now().Unix()
	return nil
}

func readTranscript(sm sessionMeta) ([]chatMsg, error) {
	f, err := os.Open(sm.File)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []chatMsg
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var tl transcriptLine
		if err := json.Unmarshal([]byte(sc.Text()), &tl); err != nil {
			continue
		}
		if tl.Type == "user" {
			out = append(out, chatMsg{you: true, text: tl.Text})
		} else if tl.Type == "assistant" {
			out = append(out, chatMsg{you: false, text: tl.Text})
		}
	}
	return out, nil
}

type ndjsonEvent struct {
	Type      string   `json:"type"`
	ID        string   `json:"id,omitempty"`
	Text      string   `json:"text,omitempty"`
	Message   string   `json:"message,omitempty"`
	RequestID string   `json:"requestId,omitempty"`
	Question  string   `json:"question,omitempty"`
	Options   []string `json:"options,omitempty"`
	Provider  string   `json:"provider,omitempty"`
	Model     string   `json:"model,omitempty"`
}

type ndjsonMsg struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	Text      string `json:"text,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Answer    string `json:"answer,omitempty"`
	Provider  string `json:"provider,omitempty"`
	Model     string `json:"model,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
}

type bridge struct {
	cmd     *exec.Cmd
	stdin   *bufio.Writer
	stdout  *bufio.Scanner
	mu      sync.Mutex
	running bool
}

func newBridge() (*bridge, error) {
	// Resolve Node bridge path relative to repo root (apps/pi-bridge/index.mjs).
	workdir, err := findWorkspaceRoot()
	if err != nil {
		return nil, err
	}
	script := filepath.Join(workdir, "apps", "pi-bridge", "index.mjs")
	if _, err := os.Stat(script); err != nil {
		return nil, fmt.Errorf("pi bridge not found at %s; run `pnpm install` and ensure workspace is checked out", script)
	}
	node := "node"
	if runtime.GOOS == "windows" {
		node += ".exe"
	}
	cmd := exec.Command(node, script)
	cmd.Dir = workdir
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b := &bridge{
		cmd:    cmd,
		stdin:  bufio.NewWriter(stdin),
		stdout: bufio.NewScanner(stdout),
	}
	return b, nil
}

func (b *bridge) writeJSON(v any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = b.stdin.Write(data)
	if err != nil {
		return err
	}
	return b.stdin.Flush()
}

func (b *bridge) init(provider, model, cwd string) error {
	return b.writeJSON(ndjsonMsg{Type: "init", Provider: provider, Model: model, Cwd: cwd})
}

func (b *bridge) send(id, text string) error {
	b.running = true
	return b.writeJSON(ndjsonMsg{Type: "send", ID: id, Text: text})
}

func (b *bridge) stop() error {
	return b.writeJSON(ndjsonMsg{Type: "stop"})
}

func (b *bridge) askAnswer(reqID, answer string) error {
	return b.writeJSON(ndjsonMsg{Type: "ask_answer", RequestID: reqID, Answer: answer})
}

func (b *bridge) close() {
	_ = b.stop()
	_ = b.cmd.Process.Kill()
}

func findWorkspaceRoot() (string, error) {
	// Walk up to find pnpm-workspace.yaml as a simple repo root heuristic.
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("could not find pnpm-workspace.yaml up the tree")
}

type chatMsg struct {
	you  bool
	text string
}

type appState struct {
	win *mygo.Window

	status string

	msgs       []chatMsg
	streaming  bytes.Buffer
	currentRun string

	draft string
	busy  bool
	assignOpen bool

	// ask_user modal
	askOpen     bool
	askQuestion string
	askOptions  []string
	askReqID    string
	askDraft    string

	br *bridge

	// sessions
	sessions []sessionMeta
	selected string // session id

	// background dispatch
	activeRunSession string
	bgStreaming      map[string]*bytes.Buffer // sessionID -> buffer
}

func (s *appState) view(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Fill().Children(func() {
		// Sidebar (softer, light)
		ui.Column(c).Width(260).Padding(14).Gap(10).Background(t.Surface).Children(func() {
			ui.Row(c).Justify(ui.SpaceBetween).Children(func() {
				ui.Text(c, "chatgo").FontSize(18).Bold()
			})
			// New chat / Bind
			if ui.PrimaryButton(c, "New chat").Clicked() {
				s.newChat()
			}
			if ui.Button(c, "Bind workspace…").Clicked() {
				s.bindWorkspace()
			}
			ui.Text(c, "Sessions").TextColor(t.TextMuted)
			for _, sm := range s.sessions {
				itemID := sm.ID
				row := ui.Column(c.Key(itemID)).Padding(10).Radius(10)
				if itemID == s.selected {
					row.Background(ui.RGBA(238, 238, 240, 1))
				}
				row.Children(func() {
					title := sm.Title
					if sm.Primary {
						// subtle star
						title = "★ " + title
					}
					ui.Text(c, title).SingleLine()
					if sm.WorkspaceDir != "" {
						ui.Text(c, sm.WorkspaceDir).TextColor(t.TextMuted).FontSize(10).SingleLine()
					}
				})
				if row.Clicked() {
					_ = s.openSession(itemID)
				}
			}
			ui.Spacer(c)
			ui.Text(c, s.status).FontSize(11).TextColor(t.TextMuted)
		})
		// Main pane
		ui.Column(c).Grow(1).Padding(16).Gap(12).Children(func() {
			// Chat area
			ui.Scroll(c).Grow(1).Padding(8).Gap(12).Children(func() {
				for _, m := range s.msgs {
					if m.you {
						// user bubble
						ui.Column(c).Children(func() {
							ui.Text(c, "You").FontSize(12).TextColor(t.TextMuted)
							ui.Column(c).Padding(10).Radius(12).Background(ui.RGBA(236, 243, 255, 1)).Children(func() {
								ui.Text(c, m.text)
							})
						})
					} else {
						// assistant bubble
						ui.Column(c).Children(func() {
							ui.Text(c, "chatgo").FontSize(12).TextColor(t.TextMuted)
							ui.Column(c).Padding(10).Radius(12).Background(ui.RGBA(245, 245, 247, 1)).Children(func() {
								ui.Text(c, m.text)
								// very quiet tool stub
								ui.Text(c, "(tools: not wired)").FontSize(10).TextColor(t.TextMuted)
							})
						})
					}
				}
				// streaming line
				if s.streaming.Len() > 0 {
					ui.Column(c).Children(func() {
						ui.Text(c, "chatgo").FontSize(12).TextColor(t.TextMuted)
						ui.Column(c).Padding(10).Radius(12).Background(ui.RGBA(245, 245, 247, 1)).Children(func() {
							ui.Text(c, s.streaming.String())
						})
					})
				}
			})
			// Composer bar
			ui.Column(c).Gap(8).Children(func() {
				// Styled input area
				ui.Column(c).Padding(10).Radius(12).Background(ui.RGBA(250, 250, 252, 1)).Children(func() {
					ta := ui.TextArea(c, &s.draft).Lines(1, 6).Placeholder("Type a message…")
					ta.OnTextKey(func(k ui.TextKey) bool {
						switch {
						case k.Key == ui.KeyEnter && k.Mods == 0:
							s.send()
							k.SetText("")
							return true
						}
						return false
					})
					ui.Row(c).Justify(ui.End).Gap(8).Children(func() {
						// Assign (secondary), Stop (secondary), Send (primary)
						if sm := s.currentSession(); sm != nil && sm.Primary {
							if ui.Button(c, "Assign…").Disabled(s.busy || strings.TrimSpace(s.draft) == "").Clicked() {
								s.assignOpen = !s.assignOpen
							}
						}
						if ui.Button(c, "Stop").Disabled(!s.busy).Clicked() {
							if s.br != nil {
								_ = s.br.stop()
							}
						}
						if ui.PrimaryButton(c, "Send").Disabled(s.busy || strings.TrimSpace(s.draft) == "").Clicked() {
							s.send()
						}
					})
				})
				// Assign overlay (light, non-modal)
				if s.assignOpen {
					ui.Column(c).Padding(12).Radius(12).Background(ui.RGBA(255, 255, 255, 1)).Gap(6).Children(func() {
						ui.Text(c, "Assign to session").Bold()
						for _, sm := range s.sessions {
							if sm.ID == s.selected {
								continue
							}
							lbl := sm.Title
							if sm.WorkspaceDir != "" {
								lbl = fmt.Sprintf("%s  ·  %s", lbl, sm.WorkspaceDir)
							}
							if ui.Button(c, lbl).Clicked() {
								s.dispatchTo(sm.ID, strings.TrimSpace(s.draft))
								s.draft = ""
								s.assignOpen = false
							}
						}
						if ui.Button(c, "New worker…").Clicked() {
							// optional workspace
							var ws string
							paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
								Parent:    s.win,
								Title:     "Choose workspace folder (optional)",
								Directory: true,
							})
							if err == nil && len(paths) > 0 {
								ws = paths[0]
							}
							newID := s.newWorkerWithOptionalFolder(ws)
							if newID != "" {
								s.dispatchTo(newID, strings.TrimSpace(s.draft))
								s.draft = ""
								s.assignOpen = false
							}
						}
					})
				}
			})
		})
	})

	// ask_user dialog
	ui.Modal(c, &s.askOpen, func() {
		ui.Column(c).Width(420).Padding(16).Gap(12).Background(t.Background).Radius(12).Children(func() {
			ui.Text(c, "Assistant asks").FontSize(16).Bold()
			ui.Text(c, s.askQuestion)
			if len(s.askOptions) > 0 {
				ui.Row(c).Wrap().Gap(8).Children(func() {
					for _, opt := range s.askOptions {
						o := opt
						if ui.Button(c, o).Clicked() {
							s.answerAsk(o)
							s.askOpen = false
						}
					}
				})
				ui.Text(c, "Or type your answer:").TextColor(t.TextMuted)
			}
			ui.TextInput(c, &s.askDraft).Placeholder("Type your answer…").AutoFocus()
			ui.Row(c).Justify(ui.End).Gap(8).Children(func() {
				if ui.Button(c, "Cancel").Clicked() {
					s.askOpen = false
					s.askDraft = ""
				}
				if ui.PrimaryButton(c, "Submit").Clicked() {
					s.answerAsk(strings.TrimSpace(s.askDraft))
					s.askOpen = false
					s.askDraft = ""
				}
			})
		})
	})
}

func (s *appState) send() {
	text := strings.TrimSpace(s.draft)
	if text == "" || s.br == nil {
		return
	}
	// Warn about missing key in status (non-blocking)
	if os.Getenv("DEEPSEEK_API_KEY") == "" &&
		os.Getenv("OPENAI_API_KEY") == "" &&
		os.Getenv("MAIN_VITE_API_KEY") == "" {
		s.status = "No API key set (DEEPSEEK_API_KEY/OPENAI_API_KEY)"
	}
	id := fmt.Sprintf("m-%d", time.Now().UnixNano())
	s.msgs = append(s.msgs, chatMsg{you: true, text: text})
	s.draft = ""
	s.busy = true
	// persist user message
	if sm := s.currentSession(); sm != nil {
		_ = appendTranscriptLine(sm, transcriptLine{Type: "user", Text: text, Timestamp: time.Now().Unix()})
		// auto-title if empty/default
		if strings.EqualFold(sm.Title, "New chat") && text != "" {
			sm.Title = truncateTitle(text)
			_ = s.saveIndex()
		}
	}
	if err := s.br.send(id, text); err != nil {
		s.msgs = append(s.msgs, chatMsg{you: false, text: "⚠ send failed: " + err.Error()})
		s.busy = false
	}
}

func (s *appState) answerAsk(ans string) {
	if s.br != nil && s.askReqID != "" {
		if ans == "" {
			ans = "(no answer)"
		}
		_ = s.br.askAnswer(s.askReqID, ans)
	}
}

func main() {
	state := &appState{
		status:      "Starting chatgo…",
		bgStreaming: make(map[string]*bytes.Buffer),
	}
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:  "chatgo",
			Width:  900,
			Height: 640,
			Content: ui.View(func(c *ui.Context) {
				state.view(c)
			}),
		})
		state.win = win
		// Load or create sessions
		_ = state.loadOrInitSessions()
		// Start Node bridge
		br, err := newBridge()
		if err != nil {
			win.Update(func() {
				state.status = "Bridge error: " + err.Error()
			})
			return
		}
		state.br = br
		// init with cwd of current session (if any)
		_ = br.init("deepseek", "deepseek-v4-flash", state.currentWorkspace())
		go func() {
			for br.stdout.Scan() {
				line := br.stdout.Text()
				var ev ndjsonEvent
				if err := json.Unmarshal([]byte(line), &ev); err != nil {
					log.Println("bad bridge line:", line)
					continue
				}
				switch ev.Type {
				case "ready":
					win.Update(func() {
						state.status = fmt.Sprintf("pi ready: %s · %s", ev.Provider, ev.Model)
					})
				case "assistant_delta":
					win.Update(func() {
						if state.currentRun != ev.ID {
							state.currentRun = ev.ID
							state.streaming.Reset()
						}
						// route streaming by run context
						if state.activeRunSession != "" && state.activeRunSession != state.selected {
							buf := state.bgStreaming[state.activeRunSession]
							if buf == nil {
								b := &bytes.Buffer{}
								state.bgStreaming[state.activeRunSession] = b
								buf = b
							}
							buf.WriteString(ev.Text)
						} else {
							state.streaming.WriteString(ev.Text)
						}
					})
				case "assistant_done":
					win.Update(func() {
						// background worker run?
						if state.activeRunSession != "" && state.activeRunSession != state.selected {
							buf := state.bgStreaming[state.activeRunSession]
							out := ""
							if buf != nil {
								out = buf.String()
								buf.Reset()
							}
							// append to worker transcript
							for i := range state.sessions {
								if state.sessions[i].ID == state.activeRunSession {
									_ = appendTranscriptLine(&state.sessions[i], transcriptLine{Type: "assistant", Text: out, Timestamp: time.Now().Unix()})
									break
								}
							}
							_ = state.saveIndex()
							// summary back to primary
							summary := summarize(out)
							state.msgs = append(state.msgs, chatMsg{you: false, text: fmt.Sprintf("Worker result: %s", summary)})
							if sm := state.currentSession(); sm != nil {
								_ = appendTranscriptLine(sm, transcriptLine{Type: "assistant", Text: fmt.Sprintf("Worker result: %s", summary), Timestamp: time.Now().Unix()})
								_ = state.saveIndex()
							}
							// re-init back to primary cwd
							if state.br != nil {
								_ = state.br.init("deepseek", "deepseek-v4-flash", state.currentWorkspace())
							}
							state.activeRunSession = ""
							state.currentRun = ""
							state.busy = false
						} else {
							if state.streaming.Len() > 0 {
								state.msgs = append(state.msgs, chatMsg{you: false, text: state.streaming.String()})
								// persist assistant message
								if sm := state.currentSession(); sm != nil {
									_ = appendTranscriptLine(sm, transcriptLine{Type: "assistant", Text: state.streaming.String(), Timestamp: time.Now().Unix()})
									_ = state.saveIndex()
								}
							}
							state.streaming.Reset()
							state.currentRun = ""
							state.busy = false
						}
					})
				case "error":
					win.Update(func() {
						state.msgs = append(state.msgs, chatMsg{you: false, text: "⚠ " + ev.Message})
						state.streaming.Reset()
						state.currentRun = ""
						state.busy = false
					})
				case "ask_request":
					win.Update(func() {
						state.askOpen = true
						state.askQuestion = ev.Question
						state.askOptions = append([]string(nil), ev.Options...)
						state.askReqID = ev.RequestID
						state.askDraft = ""
					})
				default:
					// ignore
				}
			}
		}()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// ─── Sessions helpers ───────────────────────────────────────────────────────────
func (s *appState) loadOrInitSessions() error {
	idx, err := loadSessionIndex()
	if err != nil {
		return err
	}
	s.sessions = idx.Sessions
	// ensure one primary (first marked if none)
	hasPrimary := false
	for _, sm := range s.sessions {
		if sm.Primary {
			hasPrimary = true
			break
		}
	}
	if !hasPrimary {
		if len(s.sessions) > 0 {
			s.sessions[0].Primary = true
			_ = s.saveIndex()
		}
	}
	// sort by UpdatedAt desc (simple stable selection by scanning)
	if len(s.sessions) == 0 {
		sm, err := newSessionMeta("New chat")
		if err != nil {
			return err
		}
		// create empty file
		_ = appendTranscriptLine(&sm, transcriptLine{Type: "assistant", Text: "Welcome to chatgo!", Timestamp: time.Now().Unix()})
		// remove the welcome from messages load later, keep file created
		// rewrite file empty
		_ = os.WriteFile(sm.File, []byte{}, 0o644)
		sm.Primary = true
		s.sessions = []sessionMeta{sm}
		s.selected = sm.ID
		_ = s.saveIndex()
	} else {
		// pick most recently updated
		best := s.sessions[0]
		for _, sm := range s.sessions {
			if sm.UpdatedAt > best.UpdatedAt {
				best = sm
			}
		}
		s.selected = best.ID
	}
	_ = s.openSession(s.selected)
	return nil
}

func (s *appState) saveIndex() error {
	return saveSessionIndex(sessionIndex{Sessions: s.sessions})
}

func (s *appState) currentSession() *sessionMeta {
	for i := range s.sessions {
		if s.sessions[i].ID == s.selected {
			return &s.sessions[i]
		}
	}
	return nil
}

func (s *appState) currentWorkspace() string {
	if sm := s.currentSession(); sm != nil {
		return sm.WorkspaceDir
	}
	return ""
}

func (s *appState) openSession(id string) error {
	var sm *sessionMeta
	for i := range s.sessions {
		if s.sessions[i].ID == id {
			sm = &s.sessions[i]
			break
		}
	}
	if sm == nil {
		return fmt.Errorf("session not found")
	}
	msgs, _ := readTranscript(*sm)
	s.selected = sm.ID
	s.msgs = msgs
	s.streaming.Reset()
	// re-init bridge with cwd
	if s.br != nil {
		_ = s.br.init("deepseek", "deepseek-v4-flash", s.currentWorkspace())
	}
	return nil
}

func (s *appState) newChat() {
	sm, err := newSessionMeta("New chat")
	if err != nil {
		s.status = "Failed to create session: " + err.Error()
		return
	}
	s.sessions = append([]sessionMeta{sm}, s.sessions...)
	s.selected = sm.ID
	s.msgs = nil
	s.streaming.Reset()
	_ = s.saveIndex()
	// re-init bridge (cwd may change)
	if s.br != nil {
		_ = s.br.init("deepseek", "deepseek-v4-flash", "")
	}
}

func (s *appState) newWorkerWithOptionalFolder(ws string) string {
	sm, err := newSessionMeta("New chat")
	if err != nil {
		s.status = "Failed to create session: " + err.Error()
		return ""
	}
	sm.WorkspaceDir = ws
	// never mark worker as primary
	s.sessions = append([]sessionMeta{sm}, s.sessions...)
	_ = s.saveIndex()
	return sm.ID
}

func (s *appState) bindWorkspace() {
	if s.win == nil {
		return
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:    s.win,
		Title:     "Choose workspace folder",
		Directory: true,
	})
	if err != nil || len(paths) == 0 {
		return
	}
	ws := paths[0]
	if sm := s.currentSession(); sm != nil {
		sm.WorkspaceDir = ws
		_ = s.saveIndex()
	}
	// re-init bridge with new cwd
	if s.br != nil {
		_ = s.br.init("deepseek", "deepseek-v4-flash", ws)
	}
}

func truncateTitle(s string) string {
	t := strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len([]rune(t)) > 24 {
		r := []rune(t)
		return string(r[:24])
	}
	return t
}

func summarize(s string) string {
	txt := strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len([]rune(txt)) > 200 {
		r := []rune(txt)
		return string(r[:200]) + "…"
	}
	return txt
}

func (s *appState) dispatchTo(sessionID string, prompt string) {
	if s.br == nil || prompt == "" {
		return
	}
	// find or create target
	var target *sessionMeta
	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			target = &s.sessions[i]
			break
		}
	}
	if target == nil {
		return
	}
	// persist user prompt in worker transcript
	_ = appendTranscriptLine(target, transcriptLine{Type: "user", Text: prompt, Timestamp: time.Now().Unix()})
	_ = s.saveIndex()
	// switch bridge to worker cwd and run in background
	s.busy = true
	s.activeRunSession = target.ID
	id := fmt.Sprintf("w-%d", time.Now().UnixNano())
	if s.br != nil {
		_ = s.br.init("deepseek", "deepseek-v4-flash", target.WorkspaceDir)
	}
	if err := s.br.send(id, prompt); err != nil {
		// report error into primary
		s.msgs = append(s.msgs, chatMsg{you: false, text: "⚠ dispatch failed: " + err.Error()})
		s.busy = false
		s.activeRunSession = ""
	}
}
