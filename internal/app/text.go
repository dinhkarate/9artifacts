package app

import (
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// The text form of an artifact is what an agent reads instead of rendering
// the page: Markdown-like text with the markup, styles and scripts removed.
// A diagram drawn with the kit (diagram.css) becomes a list of nodes and
// links with their states. cloudflare/src/text.ts is the same code in
// TypeScript; change both.

var (
	reTextDrop  = regexp.MustCompile(`(?is)<!--.*?-->|<![^>]*>|<(script|style|title|template)\b.*?</(script|style|title|template)\s*>`)
	reTextToken = regexp.MustCompile(`(?s)<(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>`)
	reTextAttr  = regexp.MustCompile(`(?s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	reTextSpace = regexp.MustCompile(`\s+`)
	reTextBlank = regexp.MustCompile(`\n{3,}`)

	textVoid    = set("br", "hr", "img", "input", "meta", "link", "source", "wbr", "col", "area", "base", "embed", "track")
	textImplied = set("li", "p", "tr", "td", "th", "option", "dt", "dd")
	textPara    = set("p", "ul", "ol", "table", "section", "article", "blockquote", "figure", "details", "dl", "main", "header", "footer", "nav", "aside", "form")
	textBlock   = set("div", "thead", "tbody", "tfoot", "figcaption", "summary", "dt", "dd", "caption", "address", "fieldset", "body", "html")
)

func set(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, n := range names {
		m[n] = true
	}
	return m
}

type htmlNode struct {
	tag  string // empty for text
	text string
	attr map[string]string
	kids []*htmlNode
}

func (n *htmlNode) has(class string) bool {
	return slices.Contains(strings.Fields(n.attr["class"]), class)
}

// first returns the first descendant with the class, depth first.
func (n *htmlNode) first(class string) *htmlNode {
	for _, k := range n.kids {
		if k.tag == "" {
			continue
		}
		if k.has(class) {
			return k
		}
		if x := k.first(class); x != nil {
			return x
		}
	}
	return nil
}

// plain is the text of the subtree on one line.
func (n *htmlNode) plain() string {
	var b strings.Builder
	var walk func(*htmlNode)
	walk = func(x *htmlNode) {
		if x.tag == "br" {
			b.WriteString(" ")
		}
		b.WriteString(x.text)
		for _, k := range x.kids {
			walk(k)
		}
	}
	walk(n)
	return strings.TrimSpace(reTextSpace.ReplaceAllString(b.String(), " "))
}

func parseHTML(src string) *htmlNode {
	src = reTextDrop.ReplaceAllString(src, " ")
	root := &htmlNode{tag: "#root"}
	stack := []*htmlNode{root}
	add := func(n *htmlNode) {
		top := stack[len(stack)-1]
		top.kids = append(top.kids, n)
	}
	pos := 0
	for _, m := range reTextToken.FindAllStringSubmatchIndex(src, -1) {
		if m[0] > pos {
			add(&htmlNode{text: html.UnescapeString(src[pos:m[0]])})
		}
		pos = m[1]
		tag, rest := strings.ToLower(src[m[4]:m[5]]), src[m[6]:m[7]]
		if m[3] > m[2] { // closing tag: unwind to the nearest open one
			for i := len(stack) - 1; i > 0; i-- {
				if stack[i].tag == tag {
					stack = stack[:i]
					break
				}
			}
			continue
		}
		if top := stack[len(stack)-1].tag; textImplied[tag] && (top == tag || (tag == "td" && top == "th") || (tag == "th" && top == "td")) {
			stack = stack[:len(stack)-1]
		}
		n := &htmlNode{tag: tag, attr: map[string]string{}}
		for _, a := range reTextAttr.FindAllStringSubmatch(rest, -1) {
			n.attr[strings.ToLower(a[1])] = html.UnescapeString(a[2] + a[3] + a[4])
		}
		add(n)
		if !textVoid[tag] && !strings.HasSuffix(strings.TrimSpace(rest), "/") {
			stack = append(stack, n)
		}
	}
	if pos < len(src) {
		add(&htmlNode{text: html.UnescapeString(src[pos:])})
	}
	return root
}

type texter struct {
	b     strings.Builder
	pre   []string
	slide int
}

// htmlText renders a page as text for agents.
func htmlText(src string) string {
	t := &texter{}
	t.walk(parseHTML(src))
	var lines []string
	for _, l := range strings.Split(t.b.String(), "\n") {
		l = strings.TrimSuffix(strings.TrimSpace(reTextSpace.ReplaceAllString(l, " ")), " |")
		lines = append(lines, l)
	}
	out := strings.TrimSpace(reTextBlank.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
	for i, p := range t.pre {
		out = strings.Replace(out, fmt.Sprintf("\x00%d\x00", i), "```\n"+p+"\n```", 1)
	}
	return out
}

func (t *texter) kids(n *htmlNode) {
	for _, k := range n.kids {
		t.walk(k)
	}
}

func (t *texter) walk(n *htmlNode) {
	if n.tag == "" {
		t.b.WriteString(reTextSpace.ReplaceAllString(n.text, " "))
		return
	}
	if _, hidden := n.attr["hidden"]; hidden || n.tag == "head" {
		return
	}
	if n.has("d") && n.first("flow") != nil {
		t.diagram(n)
		return
	}
	if n.has("slide") {
		t.slide++
		fmt.Fprintf(&t.b, "\n\n[Slide %d]\n", t.slide)
	}
	switch tag := n.tag; {
	case tag == "br":
		t.b.WriteString("\n")
	case tag == "hr":
		t.b.WriteString("\n\n---\n\n")
	case tag == "img":
		if alt := strings.TrimSpace(n.attr["alt"]); alt != "" {
			t.b.WriteString("[image: " + alt + "]")
		}
	case tag == "pre":
		var raw strings.Builder
		var walk func(*htmlNode)
		walk = func(x *htmlNode) {
			raw.WriteString(x.text)
			for _, k := range x.kids {
				walk(k)
			}
		}
		walk(n)
		fmt.Fprintf(&t.b, "\n\n\x00%d\x00\n\n", len(t.pre))
		t.pre = append(t.pre, strings.Trim(raw.String(), "\n"))
	case tag == "code":
		t.b.WriteString("`" + n.plain() + "`")
	case len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6':
		t.b.WriteString("\n\n" + strings.Repeat("#", int(tag[1]-'0')) + " " + n.plain() + "\n\n")
	case tag == "li":
		t.b.WriteString("\n- ")
		t.kids(n)
	case tag == "tr":
		t.b.WriteString("\n")
		t.kids(n)
	case tag == "td" || tag == "th":
		t.kids(n)
		t.b.WriteString(" | ")
	case tag == "a":
		t.kids(n)
		if href := n.attr["href"]; strings.HasPrefix(href, "http") && href != n.plain() {
			t.b.WriteString(" (" + href + ")")
		}
	case textPara[tag]:
		t.b.WriteString("\n\n")
		t.kids(n)
		t.b.WriteString("\n\n")
	case textBlock[tag]:
		t.b.WriteString("\n")
		t.kids(n)
		t.b.WriteString("\n")
	default:
		t.kids(n)
	}
}

// diagram lists the nodes and links of a diagram-kit figure. A link joins
// the nodes on either side of it in its row; a drop joins the last node of
// the row above to the last node of the row below.
func (t *texter) diagram(d *htmlNode) {
	var rows []*htmlNode
	var collect func(*htmlNode)
	collect = func(n *htmlNode) {
		for _, k := range n.kids {
			if k.tag == "" {
				continue
			}
			if k.has("flow") || k.has("drop") {
				rows = append(rows, k)
			} else {
				collect(k)
			}
		}
	}
	collect(d)

	var nodes, links []string
	edge := func(from, to string, l *htmlNode) {
		if from == "" {
			from = "?"
		}
		if to == "" {
			to = "?"
		}
		s := "- " + from + " → " + to
		switch {
		case l.has("down"):
			s += " [down]"
		case l.has("live"):
			s += " [live]"
		case l.has("tunnel"):
			s += " [tunnel]"
		}
		if lbl := l.first("lbl"); lbl != nil && lbl.plain() != "" {
			s += ` "` + lbl.plain() + `"`
		}
		if tip := tipText(l); tip != "" {
			s += ": " + tip
		}
		links = append(links, s)
	}
	var drop *htmlNode
	prevLast := ""
	for _, row := range rows {
		if row.has("drop") {
			drop = row
			continue
		}
		last := ""
		var open *htmlNode
		for _, it := range row.kids {
			switch {
			case it.tag == "":
			case it.has("node"):
				name := nodeName(it)
				nodes = append(nodes, describeNode(it, name))
				if open != nil {
					edge(last, name, open)
					open = nil
				}
				last = name
			case it.has("link"):
				open = it
			}
		}
		if open != nil {
			edge(last, "", open)
		}
		if drop != nil {
			edge(prevLast, last, drop)
			drop = nil
		}
		prevLast = last
	}
	t.b.WriteString("\n\nDiagram nodes:\n" + strings.Join(nodes, "\n") + "\n\nDiagram links:\n" + strings.Join(links, "\n") + "\n\n")
}

func nodeName(n *htmlNode) string {
	if x := n.first("n"); x != nil {
		return x.plain()
	}
	return n.plain()
}

func describeNode(n *htmlNode, name string) string {
	s := "- " + name
	var sub []string
	for _, c := range []string{"a", "p"} {
		if x := n.first(c); x != nil && x.plain() != "" {
			sub = append(sub, x.plain())
		}
	}
	if len(sub) > 0 {
		s += " (" + strings.Join(sub, "; ") + ")"
	}
	var state []string
	led := n.first("led")
	switch {
	case n.has("bad") || (led != nil && led.has("bad")):
		state = append(state, "down")
	case n.has("warn") || (led != nil && led.has("warn")):
		state = append(state, "degraded")
	case led != nil:
		state = append(state, "up")
	}
	if n.has("mark") {
		state = append(state, "focus")
	}
	if len(state) > 0 {
		s += " [" + strings.Join(state, ", ") + "]"
	}
	if tip := tipText(n); tip != "" {
		s += ": " + tip
	}
	return s
}

// tipText reads a .tip: its <b> is a title and its <code> sits on its own line.
func tipText(n *htmlNode) string {
	tip := n.first("tip")
	if tip == nil {
		return ""
	}
	var b strings.Builder
	for _, k := range tip.kids {
		switch k.tag {
		case "":
			b.WriteString(k.text)
		case "b", "strong":
			b.WriteString(k.plain() + ": ")
		case "code":
			b.WriteString(" `" + k.plain() + "`")
		default:
			b.WriteString(k.plain())
		}
	}
	return strings.TrimSpace(reTextSpace.ReplaceAllString(b.String(), " "))
}

// artifactText is the text form of one version: a short header, then the
// entry file as text. Only the first searchRead bytes of the file are read.
func (s *Server) artifactText(id, title string, v *Version, meta []string) string {
	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	head := fmt.Sprintf("- Version: %d (%s)", v.N, v.CreatedAt.UTC().Format("2006-01-02 15:04 UTC"))
	if v.Message != "" {
		head += ", " + v.Message
	}
	b.WriteString(head + "\n")
	var files []string
	for _, f := range v.Files {
		files = append(files, fmt.Sprintf("%s (%s)", f.Name, humanBytes(f.Size)))
	}
	b.WriteString("- Files: " + strings.Join(files, ", ") + "\n")
	for _, m := range meta {
		b.WriteString("- " + m + "\n")
	}
	b.WriteString("\n---\n\n")
	ext := strings.ToLower(path.Ext(v.Entry))
	if !searchable[ext] {
		b.WriteString("(" + v.Entry + " is not text; download it to read it.)\n")
		return b.String()
	}
	f, err := os.Open(filepath.Join(s.store.VersionDir(id, v.N), filepath.FromSlash(v.Entry)))
	if err != nil {
		b.WriteString("(" + v.Entry + " is missing from storage.)\n")
		return b.String()
	}
	defer f.Close()
	raw, _ := io.ReadAll(io.LimitReader(f, searchRead+1))
	cut := len(raw) > searchRead
	if cut {
		raw = raw[:searchRead]
	}
	body := strings.ToValidUTF8(string(raw), "")
	if ext == ".html" || ext == ".htm" || ext == ".svg" {
		body = htmlText(body)
	}
	b.WriteString(strings.TrimSpace(body) + "\n")
	if cut {
		b.WriteString("\n(Cut after the first 512 kB.)\n")
	}
	return b.String()
}

// wantsText: an agent asked for the text form, with ?format=md or an
// Accept header no browser sends.
func wantsText(r *http.Request) bool {
	f := r.URL.Query().Get("format")
	return f == "md" || f == "text" || strings.Contains(r.Header.Get("Accept"), "text/markdown")
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// handleText serves GET /api/artifacts/{id}/text, and /a/{id} for agents.
func (s *Server) handleText(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, _ := strconv.Atoi(r.URL.Query().Get("v"))
	var v *Version
	var title string
	var meta []string
	s.store.Read(func(st *State) {
		a := st.Artifacts[id]
		if a == nil {
			return
		}
		if x := a.Version(n); x != nil {
			c := *x
			v, title = &c, a.Title
			meta = append(meta, "Page: "+s.cfg.PublicURL+"/a/"+id)
			if len(a.Tags) > 0 {
				meta = append(meta, "Tags: "+strings.Join(a.Tags, ", "))
			}
			if c.N != a.Latest().N {
				meta = append(meta, fmt.Sprintf("Latest version: %d", a.Latest().N))
			}
		}
	})
	if v == nil {
		writeText(w, 404, "Artifact or version not found.\n")
		return
	}
	writeText(w, 200, s.artifactText(id, title, v, meta))
}

// shareText is the text form of a share page, with the status the page has.
func (s *Server) shareText(w http.ResponseWriter, status int, id, title string, v *Version, sh Share) {
	switch status {
	case 200:
		meta := []string{"Shared link, expires " + sh.ExpiresAt.UTC().Format("2006-01-02 15:04 UTC")}
		if sh.Note != "" {
			meta = append(meta, "Note: "+sh.Note)
		}
		writeText(w, 200, s.artifactText(id, title, v, meta))
	case http.StatusUnauthorized, http.StatusTooManyRequests:
		writeText(w, status, "This link is protected by a password. Ask the person who shared it to open it in a browser, or to send the text.\n")
	case http.StatusGone:
		writeText(w, status, "This link has expired or has no views left.\n")
	default:
		writeText(w, status, "Link not found.\n")
	}
}

func (s *Server) handleLLMs(w http.ResponseWriter, r *http.Request) {
	u := s.cfg.PublicURL
	auth := "Send `Authorization: Bearer <token>`; the owner creates tokens in Settings."
	what := "a private gallery where AI agents publish HTML, Markdown, SVG, images and PDFs for their owner to review, comment on and share"
	if s.cfg.Demo {
		auth = "This is a read-only public demo: reading needs no token, publishing is off."
		what = "a read-only public demo of a gallery where AI agents publish HTML, Markdown, SVG, images and PDFs for their owner to review, comment on and share"
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintf(w, `# %[1]s

> This is a 9artifacts server (%[4]s): %[3]s. %[5]s

## Read an artifact as text

Pages here are HTML made for people. Agents should read the text form instead: Markdown with the markup, styles and scripts removed. Diagrams become a list of nodes and links with their states; slide decks are split by slide.

- %[2]s/api/artifacts/{id}/text (add ?v=N for an older version), or the page URL %[2]s/a/{id} with the header "Accept: text/markdown"
- A share link (%[6]s/s/...): add ?format=md, or send "Accept: text/markdown". A password-protected link has no text form.
- %[2]s/api/artifacts?q=words lists artifacts as JSON; q matches titles, tags and page text
- The raw files: MCP tool read_artifact, or %[2]s/api/artifacts/{id}/download/{file}

## Publish

- MCP endpoint: %[2]s/mcp (bearer token, or OAuth for remote connectors). Tools: get_design_guide, publish_artifact, list_artifacts, read_artifact, share_artifact, revoke_share, restore_version, list_comments, resolve_comment, delete_artifact
- CLI: 9artifacts login %[2]s, then 9artifacts publish FILE|DIR
- Before writing a page, read the owner's house style: [design guide](%[2]s/design.md), [diagram kit](%[2]s/diagram.css), starter templates for a [page](%[2]s/template.html), [slides](%[2]s/template.html?kind=slides) and an [A4 document](%[2]s/template.html?kind=document)

## Optional

- [Agent skill](https://github.com/dinhkarate/9artifacts/blob/main/skills/9artifacts/SKILL.md)
- [REST API](https://github.com/dinhkarate/9artifacts/blob/main/docs/api.md)
- [Run your own](https://9artifacts.com/install.md)
`, s.cfg.Name, u, what, s.cfg.Version, auth, strings.TrimSuffix(s.shareURL(""), "/s/"))
}
