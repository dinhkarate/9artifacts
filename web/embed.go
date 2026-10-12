// Package web embeds the app shell and built-in themes into the binary.
package web

import "embed"

// FS holds index.html, share.html, app.js, app.css and themes/<name>/*.
//
//go:embed index.html share.html app.js app.css themes
var FS embed.FS
