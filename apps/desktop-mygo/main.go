package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// Message is one chat turn message.
type Message struct {
	Role string
	Text string
}

// ChatClient calls DeepSeek (OpenAI-compatible) or falls back to a mocked stream.
type ChatClient struct {
	Endpoint string // default https://api.deepseek.com/chat/completions
	Model    string // e.g. deepseek-v4-flash or deepseek-chat
	APIKey   string // empty = mock
	Client   *http.Client
}

func (cc *ChatClient) endpoint() string {
	if cc.Endpoint != "" {
		return cc.Endpoint
	}
	return "https://api.deepseek.com/chat/completions"
}

// StreamChat sends history + prompt and streams assistant deltas via onDelta.
// Returns when done or on error/cancel.
func (cc *ChatClient) StreamChat(ctx context.Context, history []Message, prompt string, onDelta func(string)) error {
	if strings.TrimSpace(cc.APIKey) == "" {
		// Mock streaming: type out a placeholder reply.
		mock := "这是一个占位回复。未检测到 DEEPSEEK_API_KEY，当前以本地模拟流式输出代替。"
		ticker := time.NewTicker(80 * time.Millisecond)
		defer ticker.Stop()
		var i int
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
				if i >= len(mock) {
					return nil
				}
				onDelta(string(mock[i]))
				i++
			}
		}
	}

	// Build OpenAI-compatible request body
	type chatMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	reqBody := struct {
		Model    string    `json:"model"`
		Stream   bool      `json:"stream"`
		Messages []chatMsg `json:"messages"`
	}{
		Model:  cc.modelOrDefault(),
		Stream: true,
	}
	for _, m := range history {
		if m.Role != "user" && m.Role != "assistant" && m.Role != "system" {
			continue
		}
		reqBody.Messages = append(reqBody.Messages, chatMsg{Role: m.Role, Content: m.Text})
	}
	reqBody.Messages = append(reqBody.Messages, chatMsg{Role: "user", Content: prompt})
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(&reqBody); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cc.endpoint(), &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cc.APIKey)

	client := cc.Client
	if client == nil {
		client = &http.Client{
			Timeout: 0, // no global timeout; rely on ctx
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		if len(b) == 0 {
			return fmt.Errorf("deepseek http %d", resp.StatusCode)
		}
		return fmt.Errorf("deepseek http %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	reader := bufio.NewReader(resp.Body)
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trim := strings.TrimSpace(line)
			if strings.HasPrefix(trim, "data:") {
				data := strings.TrimSpace(strings.TrimPrefix(trim, "data:"))
				if data == "[DONE]" {
					return nil
				}
				var ev struct {
					Choices []struct {
						Delta struct {
							Content string `json:"content"`
						} `json:"delta"`
					} `json:"choices"`
				}
				if err := json.Unmarshal([]byte(data), &ev); err == nil {
					if len(ev.Choices) > 0 {
						onDelta(ev.Choices[0].Delta.Content)
					}
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func (cc *ChatClient) modelOrDefault() string {
	m := strings.TrimSpace(cc.Model)
	if m != "" {
		return m
	}
	// deepseek-v4-flash is used in the Electron app; deepseek-chat is widely compatible
	if v := os.Getenv("AKARI_MODEL"); strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return "deepseek-chat"
}

// --- App state and UI ---

type appState struct {
	mu            sync.Mutex
	messages      []Message
	input         string
	isStreaming   bool
	lastError     string
	cancelCurrent context.CancelFunc
	chat          *ChatClient
	win           *mygo.Window
}

func newApp() *appState {
	return &appState{
		messages: []Message{},
		chat: &ChatClient{
			APIKey:   os.Getenv("DEEPSEEK_API_KEY"),
			Model:    os.Getenv("AKARI_MODEL"),
			Endpoint: os.Getenv("AKARI_DEEPSEEK_ENDPOINT"),
		},
	}
}

func (a *appState) appendMessage(role, text string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.messages = append(a.messages, Message{Role: role, Text: text})
}

func (a *appState) setAssistantDelta(delta string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// Ensure last message is assistant; if not present, append one.
	if len(a.messages) == 0 || a.messages[len(a.messages)-1].Role != "assistant" {
		a.messages = append(a.messages, Message{Role: "assistant", Text: ""})
	}
	a.messages[len(a.messages)-1].Text += delta
}

func (a *appState) startSend() {
	if a.isStreaming {
		return
	}
	text := strings.TrimSpace(a.input)
	if text == "" {
		return
	}

	// Snapshot history excluding any ongoing assistant stub.
	a.mu.Lock()
	var history []Message
	for _, m := range a.messages {
		// only pass user and assistant history
		if m.Role == "user" || m.Role == "assistant" || m.Role == "system" {
			history = append(history, m)
		}
	}
	a.input = ""
	a.isStreaming = true
	a.lastError = ""
	a.mu.Unlock()

	a.appendMessage("user", text)
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.cancelCurrent = cancel
	a.mu.Unlock()

	go func() {
		err := a.chat.StreamChat(ctx, history, text, func(delta string) {
			// Update state on the main thread and redraw.
			if a.win != nil {
				a.win.Update(func() {
					a.setAssistantDelta(delta)
				})
			} else {
				a.setAssistantDelta(delta)
			}
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			if a.win != nil {
				a.win.Update(func() { a.lastError = err.Error() })
			} else {
				a.mu.Lock()
				a.lastError = err.Error()
				a.mu.Unlock()
			}
		}
		// Mark end of stream.
		if a.win != nil {
			a.win.Update(func() {
				a.isStreaming = false
				a.cancelCurrent = nil
			})
		} else {
			a.mu.Lock()
			a.isStreaming = false
			a.cancelCurrent = nil
			a.mu.Unlock()
		}
	}()
}

func (a *appState) stopStream() {
	a.mu.Lock()
	cancel := a.cancelCurrent
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (a *appState) hasAPIKey() bool {
	return strings.TrimSpace(a.chat.APIKey) != ""
}

// view renders the UI for each frame.
func (a *appState) view(c *ui.Context) {
	ui.Column(c).Fill().Gap(8).Children(func() {
		// Header
		ui.Row(c).Gap(8).Children(func() {
			ui.Text(c, "Akari").Bold().FontSize(16)
			status := "· DeepSeek 已配置"
			if !a.hasAPIKey() {
				status = "· 未检测到 DEEPSEEK_API_KEY，将用本地模拟回复"
			}
			ui.Text(c, status)
		})

		// Messages
		ui.Column(c).Fill().Grow(1).Padding(8).Children(func() {
			a.mu.Lock()
			msgs := make([]Message, len(a.messages))
			copy(msgs, a.messages)
			errText := a.lastError
			a.mu.Unlock()
			for _, m := range msgs {
				prefix := "助理"
				if m.Role == "user" {
					prefix = "我"
				} else if m.Role == "system" {
					prefix = "系统"
				}
				ui.Column(c).Gap(2).Children(func() {
					ui.Text(c, prefix).Bold()
					ui.Text(c, strings.TrimSpace(m.Text))
				})
			}
			if errText != "" {
				ui.Text(c, "错误: "+errText)
			}
		})

		// Input row
		ui.Row(c).Gap(8).Children(func() {
			ui.TextInput(c, &a.input).Placeholder("输入你的问题…").Grow(1)
			if a.isStreaming {
				if ui.Button(c, "停止").Clicked() {
					a.stopStream()
				}
			} else {
				if ui.PrimaryButton(c, "发送").Clicked() {
					a.startSend()
				}
			}
		})
	})
}

func main() {
	app := newApp()

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:   "Akari (MyGo)",
			Width:   960,
			Height:  720,
			Content: ui.View(app.view),
		})
		app.win = win
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

