package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
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

func (b *bridge) init(provider, model string) error {
	return b.writeJSON(ndjsonMsg{Type: "init", Provider: provider, Model: model})
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

	// ask_user modal
	askOpen     bool
	askQuestion string
	askOptions  []string
	askReqID    string
	askDraft    string

	br *bridge
}

func (s *appState) view(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Fill().Padding(12).Gap(8).Children(func() {
		// Title + status
		ui.Row(c).Justify(ui.SpaceBetween).Children(func() {
			ui.Text(c, "chatgo").FontSize(18).Bold()
			ui.Text(c, s.status).TextColor(t.TextMuted)
		})
		// Chat area
		ui.Scroll(c).Grow(1).Padding(8).Gap(8).Children(func() {
			for _, m := range s.msgs {
				if m.you {
					ui.RichText(c,
						ui.Span{Text: "You:", Weight: 600},
					).Children(func() {
						ui.Text(c, " "+m.text)
					})
				} else {
					ui.RichText(c,
						ui.Span{Text: "chatgo:", Weight: 600, Color: t.Accent},
					).Children(func() {
						ui.Text(c, " "+m.text)
					})
				}
			}
			// streaming line
			if s.streaming.Len() > 0 {
				ui.RichText(c,
					ui.Span{Text: "chatgo:", Weight: 600, Color: t.Accent},
				).Children(func() {
					ui.Text(c, " "+s.streaming.String())
				})
			}
		})
		// Composer
		ui.Column(c).Gap(8).Children(func() {
			ta := ui.TextArea(c, &s.draft).Lines(1, 8).Placeholder("Type a message…")
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
		status: "Starting pi bridge…",
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
		// Start Node bridge
		br, err := newBridge()
		if err != nil {
			win.Update(func() {
				state.status = "Bridge error: " + err.Error()
			})
			return
		}
		state.br = br
		_ = br.init("deepseek", "deepseek-v4-flash")
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
						state.streaming.WriteString(ev.Text)
					})
				case "assistant_done":
					win.Update(func() {
						if state.streaming.Len() > 0 {
							state.msgs = append(state.msgs, chatMsg{you: false, text: state.streaming.String()})
						}
						state.streaming.Reset()
						state.currentRun = ""
						state.busy = false
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
