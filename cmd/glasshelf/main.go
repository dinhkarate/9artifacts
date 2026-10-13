// Command glasshelf is a self-hosted, passkey-protected home for the HTML,
// Markdown and PDF artifacts your AI agents produce — one small binary.
package main

import (
	"fmt"
	"os"

	"github.com/dinhkarate/glasshelf/internal/cli"
)

var version = "dev"

const usage = `glasshelf — self-hosted artifacts for your AI agents

Server:
  glasshelf serve [flags]            run the server (see glasshelf serve -h)
  glasshelf token [--name NAME]      create an API token (on the server host)
  glasshelf passwd                   set the owner password (on the server host)
  glasshelf status                   show server status (on the server host)
  glasshelf theme init DIR           export the theme so you (or your AI) can restyle it

Client (needs GLASSHELF_URL and GLASSHELF_TOKEN, or glasshelf login):
  glasshelf login URL                save the server URL and an API token
  glasshelf publish FILE|DIR...      publish files; prints the private URL
  glasshelf list                     list artifacts
  glasshelf share ID --ttl 7d        create an expiring public link
  glasshelf revoke ID TOKEN          revoke a public link
  glasshelf rm ID                    delete an artifact
  glasshelf design                   print the owner's design guide for agents
  glasshelf version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "serve":
		err = cli.Serve(args, version)
	case "token":
		err = cli.Token(args)
	case "passwd":
		err = cli.Passwd(args)
	case "status":
		err = cli.Status(args)
	case "theme":
		err = cli.Theme(args)
	case "login":
		err = cli.Login(args)
	case "publish", "push":
		err = cli.Publish(args)
	case "list", "ls":
		err = cli.List(args)
	case "share":
		err = cli.Share(args)
	case "revoke":
		err = cli.Revoke(args)
	case "rm", "delete":
		err = cli.Remove(args)
	case "design":
		err = cli.Design(args)
	case "version", "--version", "-v":
		fmt.Println("glasshelf", version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "glasshelf:", err)
		os.Exit(1)
	}
}
