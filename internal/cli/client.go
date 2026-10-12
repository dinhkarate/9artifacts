package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"
)

type clientConfig struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "vitrine", "client.json")
}

func loadClient() (clientConfig, error) {
	var c clientConfig
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if v := os.Getenv("VITRINE_URL"); v != "" {
		c.URL = v
	}
	if v := os.Getenv("VITRINE_TOKEN"); v != "" {
		c.Token = v
	}
	c.URL = strings.TrimRight(c.URL, "/")
	if c.URL == "" || c.Token == "" {
		return c, errors.New("not configured: run `vitrine login URL` or set VITRINE_URL and VITRINE_TOKEN")
	}
	return c, nil
}

var httpClient = &http.Client{Timeout: 5 * time.Minute}

func (c clientConfig) do(method, path, ctype string, body io.Reader, out any) error {
	req, err := http.NewRequest(method, c.URL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return decodeResp(resp, out)
}

func (c clientConfig) json(method, path string, in, out any) error {
	var rd io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		rd = bytes.NewReader(b)
	}
	return c.do(method, path, "application/json", rd, out)
}

func decodeResp(resp *http.Response, out any) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode >= 300 {
		var e struct{ Error string }
		if json.Unmarshal(b, &e) == nil && e.Error != "" {
			return fmt.Errorf("%s (HTTP %d)", e.Error, resp.StatusCode)
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && len(b) > 0 {
		return json.Unmarshal(b, out)
	}
	return nil
}

// Login stores the server URL and an API token in the user config dir.
func Login(args []string) error {
	if len(args) < 1 {
		return errors.New("usage: vitrine login https://art.example.com   (token is read from stdin)")
	}
	u := strings.TrimRight(args[0], "/")
	tok, err := readSecret("API token (create one in Settings or with `vitrine token` on the server): ")
	if err != nil {
		return err
	}
	c := clientConfig{URL: u, Token: strings.TrimSpace(tok)}
	if err := c.json("GET", "/api/artifacts?limit=1", nil, nil); err != nil {
		return fmt.Errorf("token check failed: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(configPath()), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(configPath(), b, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Logged in to %s (saved to %s)\n", u, configPath())
	return nil
}

type artifact struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Tags     []string  `json:"tags"`
	URL      string    `json:"url"`
	Version  int       `json:"version"`
	Entry    string    `json:"entry"`
	Size     int64     `json:"size"`
	Updated  time.Time `json:"updatedAt"`
	Active   int       `json:"activeShares"`
	ViewBase string    `json:"viewBase"`
}

type share struct {
	Token     string    `json:"token"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Publish uploads files or directories as a new artifact or a new version.
func Publish(args []string) error {
	fset := flag.NewFlagSet("publish", flag.ExitOnError)
	title := fset.String("title", "", "title (default: <title> of the HTML or first # heading)")
	tags := fset.String("tags", "", "comma-separated tags")
	note := fset.String("note", "", "private note")
	update := fset.String("update", "", "artifact id to publish a new version of (keeps the URL)")
	message := fset.String("message", "", "what changed in this version")
	keep := fset.Bool("keep", false, "with --update: keep files of the previous version that you do not re-upload")
	entry := fset.String("entry", "", "entry file (default: index.html, else first .html/.md)")
	shareTTL := fset.String("share", "", "also create a public link with this TTL (1h, 24h, 7d, 30d)")
	asJSON := fset.Bool("json", false, "print the result as JSON")
	paths := parseInterleaved(fset, args)
	if len(paths) == 0 {
		return errors.New("usage: vitrine publish [--title T] [--tags a,b] [--update ID] FILE|DIR...")
	}
	c, err := loadClient()
	if err != nil {
		return err
	}
	type item struct{ name, path string }
	var items []item
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			return err
		}
		if !st.IsDir() {
			items = append(items, item{filepath.Base(p), p})
			continue
		}
		err = filepath.WalkDir(p, func(fp string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if strings.HasPrefix(d.Name(), ".") && fp != p {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(p, fp)
			items = append(items, item{filepath.ToSlash(rel), fp})
			return nil
		})
		if err != nil {
			return err
		}
	}
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		fields := map[string]string{"title": *title, "tags": *tags, "message": *message, "entry": *entry}
		if *keep {
			fields["keep"] = "1"
		}
		if *note != "" {
			fields["note"] = *note
		}
		for k, v := range fields {
			if v != "" {
				_ = mw.WriteField(k, v)
			}
		}
		for _, it := range items {
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files"; filename=%q`, it.name))
			h.Set("Content-Type", "application/octet-stream")
			w, err := mw.CreatePart(h)
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			f, err := os.Open(it.path)
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			_, err = io.Copy(w, f)
			f.Close()
			if err != nil {
				pw.CloseWithError(err)
				return
			}
		}
		pw.CloseWithError(mw.Close())
	}()
	path := "/api/artifacts"
	if *update != "" {
		path += "/" + *update + "/versions"
	}
	var a artifact
	if err := c.do("POST", path, mw.FormDataContentType(), pr, &a); err != nil {
		return err
	}
	var sh *share
	if *shareTTL != "" {
		sh = &share{}
		if err := c.json("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": *shareTTL}, sh); err != nil {
			return fmt.Errorf("published %s but sharing failed: %w", a.URL, err)
		}
	}
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"artifact": a, "share": sh})
	}
	fmt.Fprintf(os.Stderr, "Published %q v%d (%d file(s))\n", a.Title, a.Version, len(items))
	fmt.Println(a.URL)
	if sh != nil {
		fmt.Fprintf(os.Stderr, "Public link, expires %s:\n", sh.ExpiresAt.Local().Format("2006-01-02 15:04"))
		fmt.Println(sh.URL)
	}
	return nil
}

// parseInterleaved lets flags appear before or after positional args.
func parseInterleaved(fset *flag.FlagSet, args []string) []string {
	var pos []string
	for {
		_ = fset.Parse(args)
		args = fset.Args()
		if len(args) == 0 {
			return pos
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

// List prints artifacts.
func List(args []string) error {
	fset := flag.NewFlagSet("list", flag.ExitOnError)
	q := fset.String("q", "", "search text")
	tag := fset.String("tag", "", "filter by tag")
	asJSON := fset.Bool("json", false, "print JSON")
	_ = fset.Parse(args)
	c, err := loadClient()
	if err != nil {
		return err
	}
	var out struct{ Artifacts []artifact }
	path := "/api/artifacts?q=" + url.QueryEscape(*q) + "&tag=" + url.QueryEscape(*tag)
	if err := c.json("GET", path, nil, &out); err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(out.Artifacts)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tTITLE\tVER\tTAGS\tUPDATED\tSHARED")
	for _, a := range out.Artifacts {
		fmt.Fprintf(tw, "%s\t%s\tv%d\t%s\t%s\t%d\n", a.ID, clip(a.Title, 48), a.Version, strings.Join(a.Tags, ","), a.Updated.Local().Format("2006-01-02 15:04"), a.Active)
	}
	return tw.Flush()
}

// Share creates a public link.
func Share(args []string) error {
	fset := flag.NewFlagSet("share", flag.ExitOnError)
	ttl := fset.String("ttl", "7d", "link lifetime: 1h, 24h, 7d, 30d")
	note := fset.String("note", "", "public note shown on the share page")
	pos := parseInterleaved(fset, args)
	if len(pos) != 1 {
		return errors.New("usage: vitrine share ID --ttl 7d")
	}
	c, err := loadClient()
	if err != nil {
		return err
	}
	var sh share
	if err := c.json("POST", "/api/artifacts/"+pos[0]+"/shares", map[string]any{"ttl": *ttl, "note": *note}, &sh); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Public link, expires %s (revoke: vitrine revoke %s %s)\n", sh.ExpiresAt.Local().Format("2006-01-02 15:04"), pos[0], sh.Token)
	fmt.Println(sh.URL)
	return nil
}

// Revoke kills a public link.
func Revoke(args []string) error {
	if len(args) != 2 {
		return errors.New("usage: vitrine revoke ID TOKEN")
	}
	c, err := loadClient()
	if err != nil {
		return err
	}
	return c.json("DELETE", "/api/artifacts/"+args[0]+"/shares/"+args[1], nil, nil)
}

// Remove deletes an artifact.
func Remove(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: vitrine rm ID")
	}
	c, err := loadClient()
	if err != nil {
		return err
	}
	if err := c.json("DELETE", "/api/artifacts/"+args[0], nil, nil); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Deleted", args[0])
	return nil
}

// Design prints the server's design guide so agents match the owner's style.
func Design(args []string) error {
	c, err := loadClient()
	if err != nil {
		return err
	}
	for _, p := range []string{"/design.md", "/template.html"} {
		resp, err := httpClient.Get(c.URL + p)
		if err != nil {
			return err
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if p == "/template.html" {
			fmt.Print("\n\n# Starter template\n\n```html\n" + string(b) + "\n```\n")
		} else {
			fmt.Print(string(b))
		}
	}
	return nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
