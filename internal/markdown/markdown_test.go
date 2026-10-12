package markdown

import (
	"strings"
	"testing"
)

func TestRender(t *testing.T) {
	src := "# Title\n\nSome **bold**, *em* and `code <b>`.\n\n- [x] done\n- todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```go\nfmt.Println(\"<hi>\")\n```\n\n> quote\n\n![chart](assets/chart.png) [site](https://example.com)"
	out := Render(src)
	for _, want := range []string{
		"<h1>Title</h1>", "<strong>bold</strong>", "<em>em</em>", "<code>code &lt;b&gt;</code>",
		`<li class="task"><input type="checkbox" disabled checked> done</li>`, "<th>a</th>", "<td>2</td>",
		`<pre><code class="language-go">fmt.Println(&#34;&lt;hi&gt;&#34;)</code></pre>`, "<blockquote><p>quote</p>",
		`<img src="assets/chart.png" alt="chart" loading="lazy">`, `<a href="https://example.com"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestRenderEscapesHTMLAndSchemes(t *testing.T) {
	out := Render("<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](data:text/html,hi)")
	if strings.Contains(out, "<script>") || strings.Contains(out, "javascript:") || strings.Contains(out, "data:text") {
		t.Fatalf("unsafe output: %s", out)
	}
}

func TestTitle(t *testing.T) {
	if got := Title("intro\n# Weekly report\n## x"); got != "Weekly report" {
		t.Fatalf("got %q", got)
	}
}

func TestNoAttributeInjection(t *testing.T) {
	out := Render("![ http://x/onerror=alert(1)//](http://y/a.png) [**b** `c`](https://e.com) http://a.b/?q=\"x\"")
	if strings.Contains(out, `onerror="`) || strings.Count(out, "<a ") != 2 {
		t.Fatalf("unsafe or wrong output: %s", out)
	}
	if !strings.Contains(out, "<strong>b</strong> <code>c</code></a>") {
		t.Fatalf("link label formatting lost: %s", out)
	}
}

func TestAutolinkCannotSwallowPlaceholders(t *testing.T) {
	out := Render("http://x[t](http://y/onmouseover=alert(1)//)")
	if strings.Contains(out, "\x00") || strings.Contains(out, `onmouseover="`) || strings.Contains(out, `href="http://x<a`) {
		t.Fatalf("unsafe output: %q", out)
	}
}
