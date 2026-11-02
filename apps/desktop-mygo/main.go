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

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
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
	cmd    *exec.Cmd
	stdin  *bufio.Writer
	stdout *bufio.Scanner
	mu     sync.Mutex
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
	// Best-effort wait; process exits when stdin closes.
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

func main() {
	akari := app.NewWithID("akari.desktop.mygo")
	akari.Settings().SetTheme(theme.DarkTheme())
	w := akari.NewWindow("Akari — MyGo")
	w.Resize(fyne.NewSize(900, 640))

	chatView := widget.NewMultiLineEntry()
	chatView.SetPlaceHolder("Akari chat will appear here…")
	chatView.Disable()

	input := widget.NewMultiLineEntry()
	input.SetPlaceHolder("Type a message…")
	sendBtn := widget.NewButton("Send", nil)
	stopBtn := widget.NewButtonWithIcon("Stop", theme.MediaStopIcon(), nil)
	stopBtn.Disable()

	status := widget.NewLabel("Starting pi bridge…")

	// Bridge
	var br *bridge
	var err error
	appendLine := func(line string) {
		chatView.SetText(chatView.Text + line + "\n")
		chatView.CursorRow = strings.Count(chatView.Text, "\n")
	}
	var assistantBuf bytes.Buffer
	var currentMsgID string
	var once sync.Once
	initBridge := func() {
		var initErr error
		br, initErr = newBridge()
		if initErr != nil {
			status.SetText("Bridge error: " + initErr.Error())
			return
		}
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
					status.SetText(fmt.Sprintf("pi ready: %s · %s", ev.Provider, ev.Model))
				case "assistant_delta":
					if currentMsgID != ev.ID {
						currentMsgID = ev.ID
						assistantBuf.Reset()
						appendLine("Akari:")
					}
					assistantBuf.WriteString(ev.Text)
					chatView.SetText(strings.TrimRight(chatView.Text, "\n") + "\n" + assistantBuf.String())
				case "assistant_done":
					currentMsgID = ""
					assistantBuf.WriteString("\n")
					chatView.SetText(strings.TrimRight(chatView.Text, "\n") + "\n" + assistantBuf.String())
					assistantBuf.Reset()
					stopBtn.Disable()
					sendBtn.Enable()
					if br != nil {
						br.running = false
					}
				case "error":
					appendLine("⚠ " + ev.Message)
					stopBtn.Disable()
					sendBtn.Enable()
					if br != nil {
						br.running = false
					}
				case "ask_request":
					// Simple approval/ask stub: show a dialog with options or free text.
					once.Do(func() {}) // placeholder to avoid import errors if not used
					showAskDialog(w, ev, func(answer string) {
						if br != nil {
							_ = br.askAnswer(ev.RequestID, answer)
						}
					})
				default:
					// ignore
				}
			}
		}()
	}
	initBridge()

	send := func() {
		text := strings.TrimSpace(input.Text)
		if text == "" || br == nil {
			return
		}
		if os.Getenv("DEEPSEEK_API_KEY") == "" &&
			os.Getenv("OPENAI_API_KEY") == "" &&
			os.Getenv("MAIN_VITE_API_KEY") == "" {
			dialog.ShowInformation("Missing API key", "No API key found in environment (DEEPSEEK_API_KEY / OPENAI_API_KEY).\nThe agent will likely fail to reply. Set a key and restart.", w)
		}
		id := fmt.Sprintf("m-%d", time.Now().UnixNano())
		appendLine("You: " + text)
		input.SetText("")
		sendBtn.Disable()
		stopBtn.Enable()
		if err := br.send(id, text); err != nil {
			appendLine("⚠ send failed: " + err.Error())
			stopBtn.Disable()
			sendBtn.Enable()
		}
	}
	sendBtn.OnTapped = send
	stopBtn.OnTapped = func() {
		if br != nil {
			_ = br.stop()
		}
	}

	inputScroll := container.NewVScroll(input)
	inputScroll.SetMinSize(fyne.NewSize(0, 120))
	controls := container.NewBorder(nil, nil, nil, container.NewHBox(stopBtn, sendBtn), status)
	body := container.NewBorder(nil, inputScroll, nil, nil, chatView)
	w.SetContent(container.NewBorder(nil, controls, nil, nil, body))
	w.SetOnClosed(func() {
		if br != nil {
			br.close()
		}
	})
	w.ShowAndRun()
}

func showAskDialog(win fyne.Window, ev ndjsonEvent, onAnswer func(string)) {
	q := widget.NewLabel(ev.Question)
	var selected string
	form := &widget.Form{}
	if len(ev.Options) > 0 {
		// radio group for options
		radio := widget.NewRadioGroup(ev.Options, func(s string) { selected = s })
		radio.Required = false
		form.Append("Options", radio)
	}
	entry := widget.NewEntry()
	entry.SetPlaceHolder("Type your answer…")
	form.Append("Answer", entry)
	d := dialog.NewCustomConfirm("Assistant asks", "Submit", "Cancel",
		container.NewVBox(q, form),
		func(ok bool) {
			if !ok {
				return
			}
			answer := strings.TrimSpace(selected)
			if answer == "" {
				answer = strings.TrimSpace(entry.Text)
			}
			if answer == "" {
				answer = "(no answer)"
			}
			onAnswer(answer)
		}, win)
	d.Show()
}
