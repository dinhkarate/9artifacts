package app

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const maxComments = 500

type commentInput struct {
	Body    string `json:"body"`
	Quote   string `json:"quote"`
	Version int    `json:"version"`
	File    string `json:"file"`
}

// AddComment records feedback on a version (0 = latest).
func (s *Server) AddComment(id, author string, in commentInput) (Comment, int, error) {
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return Comment{}, 400, errors.New("comment is empty")
	}
	c := Comment{ID: newID(6), Body: truncate(body, 4000), Quote: truncate(strings.TrimSpace(in.Quote), 500),
		Author: author, CreatedAt: time.Now().UTC()}
	status := 201
	err := s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			status = 404
			return errors.New("artifact not found")
		}
		v := a.Version(in.Version)
		if v == nil {
			status = 400
			return errors.New("no such version")
		}
		c.Version = v.N
		c.File = v.Entry
		if in.File != "" {
			name, err := cleanName(in.File)
			if err != nil {
				status = 400
				return err
			}
			c.File = name
		}
		open := 0
		for _, x := range a.Comments {
			if x.ResolvedAt == nil {
				open++
			}
		}
		if len(a.Comments) >= maxComments {
			// Drop the oldest resolved comment to stay bounded.
			for i, x := range a.Comments {
				if x.ResolvedAt != nil {
					a.Comments = append(a.Comments[:i], a.Comments[i+1:]...)
					break
				}
			}
			if len(a.Comments) >= maxComments {
				status = 409
				return fmt.Errorf("too many open comments (%d)", open)
			}
		}
		a.Comments = append(a.Comments, c)
		return nil
	})
	if err != nil {
		return Comment{}, status, err
	}
	return c, 201, nil
}

// ResolveComment marks a comment done, with an optional note for the owner.
func (s *Server) ResolveComment(id, cid, note string) (Comment, error) {
	var out Comment
	err := s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			return errors.New("artifact not found")
		}
		for i := range a.Comments {
			if a.Comments[i].ID == cid {
				now := time.Now().UTC()
				a.Comments[i].ResolvedAt = &now
				a.Comments[i].Resolution = truncate(strings.TrimSpace(note), 2000)
				out = a.Comments[i]
				return nil
			}
		}
		return errors.New("comment not found")
	})
	return out, err
}

func (s *Server) DeleteComment(id, cid string) error {
	return s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			return errors.New("artifact not found")
		}
		for i := range a.Comments {
			if a.Comments[i].ID == cid {
				a.Comments = append(a.Comments[:i], a.Comments[i+1:]...)
				return nil
			}
		}
		return errors.New("comment not found")
	})
}

// commentAuthor names who is writing: the owner's browser, or an agent token.
func (s *Server) commentAuthor(r *http.Request) string {
	if name := s.tokenName(r); name != "" {
		return "agent: " + name
	}
	return "owner"
}

func (s *Server) handleCommentCreate(w http.ResponseWriter, r *http.Request) {
	var in commentInput
	if err := readJSON(r, &in); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	c, status, err := s.AddComment(r.PathValue("id"), s.commentAuthor(r), in)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 201, c)
}

func (s *Server) handleCommentResolve(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Note string `json:"note"`
	}
	_ = readJSON(r, &in)
	c, err := s.ResolveComment(r.PathValue("id"), r.PathValue("cid"), in.Note)
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, c)
}

func (s *Server) handleCommentDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.DeleteComment(r.PathValue("id"), r.PathValue("cid")); err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// formatComments renders comments for an agent.
func formatComments(a *Artifact, includeResolved bool) string {
	var b strings.Builder
	n := 0
	for _, c := range a.Comments {
		if c.ResolvedAt != nil && !includeResolved {
			continue
		}
		n++
		state := "open"
		if c.ResolvedAt != nil {
			state = "resolved"
			if c.Resolution != "" {
				state += ": " + c.Resolution
			}
		}
		fmt.Fprintf(&b, "- [%s] v%d %s (%s, by %s)\n", c.ID, c.Version, c.File, state, c.Author)
		if c.Quote != "" {
			fmt.Fprintf(&b, "  on: %q\n", c.Quote)
		}
		fmt.Fprintf(&b, "  %s\n", strings.ReplaceAll(c.Body, "\n", "\n  "))
	}
	if n == 0 {
		return fmt.Sprintf("No open comments on %q (latest v%d).", a.Title, a.Latest().N)
	}
	return fmt.Sprintf("Comments on %q (latest v%d):\n%s\nFix them with publish_artifact (same id), then resolve_comment each one with a short note.", a.Title, a.Latest().N, b.String())
}
