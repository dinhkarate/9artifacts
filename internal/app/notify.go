package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Webhook events.
const (
	EventPublished  = "artifact.published"
	EventVersion    = "artifact.version"
	EventShared     = "share.created"
	EventShareVisit = "share.visited"
)

// event is the JSON body sent to webhooks. "text" and "content" carry a
// readable message so Slack and Discord incoming webhooks work as-is.
type event struct {
	Event    string    `json:"event"`
	Text     string    `json:"text"`
	Content  string    `json:"content"`
	Artifact eventItem `json:"artifact"`
	At       time.Time `json:"at"`
}

type eventItem struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Version int    `json:"version"`
}

var webhookClient = &http.Client{Timeout: 10 * time.Second}

// notify posts an event to every configured webhook in the background.
// Share tokens are never included: only the private artifact URL.
func (s *Server) notify(kind string, it eventItem, detail string) {
	if len(s.cfg.Webhooks) == 0 {
		return
	}
	msg := fmt.Sprintf("%s: %q v%d", describe(kind), it.Title, it.Version)
	if detail != "" {
		msg += " (" + detail + ")"
	}
	ev := event{Event: kind, Text: msg + "\n" + it.URL, Content: msg + "\n" + it.URL, Artifact: it, At: time.Now().UTC()}
	for _, hook := range s.cfg.Webhooks {
		go s.deliver(hook, ev, msg)
	}
}

func describe(kind string) string {
	switch kind {
	case EventPublished:
		return "New artifact"
	case EventVersion:
		return "New version"
	case EventShared:
		return "Public link created"
	case EventShareVisit:
		return "Public link opened"
	}
	return kind
}

func (s *Server) deliver(hook string, ev event, msg string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var req *http.Request
	var err error
	if target, ok := strings.CutPrefix(hook, "ntfy+"); ok {
		// ntfy: plain-text message, title and click-through link as headers.
		req, err = http.NewRequestWithContext(ctx, "POST", target, strings.NewReader(msg))
		if err == nil {
			req.Header.Set("Title", s.cfg.Name)
			req.Header.Set("Click", ev.Artifact.URL)
			req.Header.Set("Tags", "framed_picture")
		}
	} else {
		b, _ := json.Marshal(ev)
		req, err = http.NewRequestWithContext(ctx, "POST", hook, bytes.NewReader(b))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
		}
	}
	if err != nil {
		log.Printf("webhook %s: %v", hookHost(hook), err)
		return
	}
	req.Header.Set("User-Agent", "9artifacts/"+s.cfg.Version)
	resp, err := webhookClient.Do(req)
	if err != nil {
		log.Printf("webhook %s: %v", hookHost(hook), err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("webhook %s: HTTP %d", hookHost(hook), resp.StatusCode)
	}
}

// hookHost keeps webhook secrets (paths, query strings) out of the log.
func hookHost(hook string) string {
	u, err := url.Parse(strings.TrimPrefix(hook, "ntfy+"))
	if err != nil {
		return "?"
	}
	return u.Host
}
