package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestModelOrDefault(t *testing.T) {
	cc := &ChatClient{}
	if got := cc.modelOrDefault(); got == "" {
		t.Fatalf("default model empty")
	}
	cc = &ChatClient{Model: "deepseek-v4-flash"}
	if got := cc.modelOrDefault(); got != "deepseek-v4-flash" {
		t.Fatalf("model override failed: %s", got)
	}
	_ = os.Setenv("AKARI_MODEL", "deepseek-chat")
	cc = &ChatClient{}
	if got := cc.modelOrDefault(); got != "deepseek-chat" {
		t.Fatalf("env model not respected: %s", got)
	}
}

func TestStreamChat_Mock(t *testing.T) {
	cc := &ChatClient{APIKey: ""} // no key -> mock
	var b strings.Builder
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := cc.StreamChat(ctx, nil, "hi", func(delta string) {
		b.WriteString(delta)
	})
	if err != nil && err != context.DeadlineExceeded && err != context.Canceled {
		t.Fatalf("mock stream error: %v", err)
	}
	if b.Len() == 0 {
		t.Fatalf("no mock output")
	}
}

