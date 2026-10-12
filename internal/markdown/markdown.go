// Package markdown renders the everyday subset of Markdown that agents write
// (headings, lists, tables, code, quotes, links, images) into safe HTML.
// Raw HTML in the source is escaped, never passed through.
package markdown

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

var (
	reFence     = regexp.MustCompile("^\\s*```")
	reHeading   = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	reRule      = regexp.MustCompile(`^\s*(?:-{3,}|\*\s*\*\s*\*[\s*]*|_{3,})\s*$`)
	reQuote     = regexp.MustCompile(`^\s*>\s?`)
	reUL        = regexp.MustCompile(`^\s*[-*+]\s+(.*)$`)
	reOL        = regexp.MustCompile(`^\s*\d+[.)]\s+(.*)$`)
	reTask      = regexp.MustCompile(`^\[([ xX])\]\s+`)
	reTableSep  = regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$`)
	reParaBreak = regexp.MustCompile("^\\s*(?:```|#{1,6}\\s|>|[-*+]\\s+|\\d+[.)]\\s+)")
	reCode      = regexp.MustCompile("`([^`\n]+)`")
	reImage     = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s\x00]+)(?:\s+&quot;[^&]*&quot;)?\)`)
	reLink      = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s\x00]+)(?:\s+&quot;[^&]*&quot;)?\)`)
	reAuto      = regexp.MustCompile(`(^|[\s(])(https?://[^\s<)\x00]+)`)
	reStrong    = regexp.MustCompile(`\*\*([^*\n]+)\*\*|__([^_\n]+)__`)
	reEm        = regexp.MustCompile(`(^|[^*\w])\*([^*\n]+)\*|(^|[^_\w])_([^_\n]+)_`)
	reStrike    = regexp.MustCompile(`~~([^~\n]+)~~`)
	reScheme    = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
	reLang      = regexp.MustCompile(`^[A-Za-z0-9_+-]+$`)
)

// safeURL allows http(s), mailto, fragments and relative paths. Relative
// paths resolve next to the document, so sibling images just work.
func safeURL(escaped string) string {
	u := html.UnescapeString(strings.TrimSpace(escaped))
	if reScheme.MatchString(u) {
		lower := strings.ToLower(u)
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") && !strings.HasPrefix(lower, "mailto:") {
			return ""
		}
	}
	return html.EscapeString(u)
}

// inline formats one line. Every generated tag is stashed behind a
// placeholder before the next pass runs, so later passes (autolinks,
// emphasis) only ever see escaped text, never markup.
func inline(s string) string {
	var stash []string
	hide := func(html string) string {
		stash = append(stash, html)
		return "\x00" + strconv.Itoa(len(stash)-1) + "\x00"
	}
	s = html.EscapeString(strings.ReplaceAll(s, "\x00", ""))
	s = reCode.ReplaceAllStringFunc(s, func(m string) string {
		return hide("<code>" + m[1:len(m)-1] + "</code>")
	})
	s = reImage.ReplaceAllStringFunc(s, func(m string) string {
		p := reImage.FindStringSubmatch(m)
		if u := safeURL(p[2]); u != "" {
			return hide(`<img src="` + u + `" alt="` + p[1] + `" loading="lazy">`)
		}
		return p[1]
	})
	s = reLink.ReplaceAllStringFunc(s, func(m string) string {
		p := reLink.FindStringSubmatch(m)
		if u := safeURL(p[2]); u != "" {
			return hide(`<a href="` + u + `" target="_blank" rel="noopener noreferrer">` + emphasis(p[1]) + `</a>`)
		}
		return p[1]
	})
	s = reAuto.ReplaceAllStringFunc(s, func(m string) string {
		p := reAuto.FindStringSubmatch(m)
		return p[1] + hide(`<a href="`+p[2]+`" target="_blank" rel="noopener noreferrer">`+p[2]+`</a>`)
	})
	s = emphasis(s)
	for i := len(stash) - 1; i >= 0; i-- {
		s = strings.Replace(s, "\x00"+strconv.Itoa(i)+"\x00", stash[i], 1)
	}
	return s
}

func emphasis(s string) string {
	s = reStrong.ReplaceAllString(s, "<strong>$1$2</strong>")
	s = reEm.ReplaceAllString(s, "$1$3<em>$2$4</em>")
	return reStrike.ReplaceAllString(s, "<del>$1</del>")
}

func cells(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimSuffix(strings.TrimPrefix(line, "|"), "|")
	parts := strings.Split(line, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// Render converts Markdown to an HTML fragment.
func Render(src string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(src, "\r\n", "\n"), "\r", "\n"), "\n")
	var out strings.Builder
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case strings.TrimSpace(line) == "":
			i++
		case reFence.MatchString(line):
			lang := strings.Fields(strings.TrimSpace(line)[3:] + " ")
			i++
			var code []string
			for i < len(lines) && !reFence.MatchString(lines[i]) {
				code = append(code, lines[i])
				i++
			}
			i++
			class := ""
			if len(lang) > 0 && reLang.MatchString(lang[0]) {
				class = ` class="language-` + lang[0] + `"`
			}
			out.WriteString("<pre><code" + class + ">" + html.EscapeString(strings.Join(code, "\n")) + "</code></pre>\n")
		case reHeading.MatchString(line):
			m := reHeading.FindStringSubmatch(line)
			n := string(rune('0' + len(m[1])))
			out.WriteString("<h" + n + ">" + inline(m[2]) + "</h" + n + ">\n")
			i++
		case reRule.MatchString(line):
			out.WriteString("<hr>\n")
			i++
		case reQuote.MatchString(line):
			var q []string
			for i < len(lines) && reQuote.MatchString(lines[i]) {
				q = append(q, reQuote.ReplaceAllString(lines[i], ""))
				i++
			}
			out.WriteString("<blockquote>" + Render(strings.Join(q, "\n")) + "</blockquote>\n")
		case reUL.MatchString(line) || reOL.MatchString(line):
			re, tag := reUL, "ul"
			if reOL.MatchString(line) {
				re, tag = reOL, "ol"
			}
			out.WriteString("<" + tag + ">")
			for i < len(lines) && re.MatchString(lines[i]) {
				item := re.FindStringSubmatch(lines[i])[1]
				if t := reTask.FindStringSubmatch(item); t != nil {
					checked := ""
					if t[1] != " " {
						checked = " checked"
					}
					item = reTask.ReplaceAllString(item, "")
					out.WriteString(`<li class="task"><input type="checkbox" disabled` + checked + `> ` + inline(item) + "</li>")
				} else {
					out.WriteString("<li>" + inline(item) + "</li>")
				}
				i++
			}
			out.WriteString("</" + tag + ">\n")
		case strings.Contains(line, "|") && i+1 < len(lines) && reTableSep.MatchString(lines[i+1]):
			head := cells(line)
			i += 2
			out.WriteString(`<div class="table-wrap"><table><thead><tr>`)
			for _, c := range head {
				out.WriteString("<th>" + inline(c) + "</th>")
			}
			out.WriteString("</tr></thead><tbody>")
			for i < len(lines) && strings.Contains(lines[i], "|") && strings.TrimSpace(lines[i]) != "" {
				row := cells(lines[i])
				out.WriteString("<tr>")
				for j := range head {
					c := ""
					if j < len(row) {
						c = row[j]
					}
					out.WriteString("<td>" + inline(c) + "</td>")
				}
				out.WriteString("</tr>")
				i++
			}
			out.WriteString("</tbody></table></div>\n")
		default:
			para := []string{inline(line)}
			i++
			for i < len(lines) && strings.TrimSpace(lines[i]) != "" && !reParaBreak.MatchString(lines[i]) {
				para = append(para, inline(lines[i]))
				i++
			}
			out.WriteString("<p>" + strings.Join(para, "<br>") + "</p>\n")
		}
	}
	return out.String()
}

// Title returns the text of the first level-one heading, if any.
func Title(src string) string {
	for _, line := range strings.Split(src, "\n") {
		if m := reHeading.FindStringSubmatch(line); m != nil && len(m[1]) == 1 {
			return m[2]
		}
	}
	return ""
}
