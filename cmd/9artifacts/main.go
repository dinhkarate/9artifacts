// Command 9artifacts is a self-hosted, passkey-protected home for the HTML,
// Markdown and PDF artifacts your AI agents produce — one small binary.
package main

import (
	"fmt"
	"os"

	"github.com/dinhkarate/9artifacts/internal/cli"
)

var version = "dev"

const usage = `9artifacts — self-hosted artifacts for your AI agents

Server:
  9artifacts serve [flags]            run the server (see 9artifacts serve -h)
  9artifacts token [--name NAME]      create an API token (on the server host)
  9artifacts passwd                   set the owner password (on the server host)
  9artifacts status                   show server status (on the server host)
  9artifacts theme init DIR           export the theme so you (or your AI) can restyle it

Client (needs NINEARTIFACTS_URL and NINEARTIFACTS_TOKEN, or 9artifacts login):
  9artifacts login URL                save the server URL and an API token
  9artifacts publish FILE|DIR...      publish files; prints the private URL
  9artifacts list                     list artifacts
  9artifacts share ID --ttl 7d        create an expiring public link
  9artifacts revoke ID TOKEN          revoke a public link
  9artifacts rm ID                    delete an artifact
  9artifacts design                   print the owner's design guide for agents
  9artifacts version
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
		fmt.Println("9artifacts", version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "9artifacts:", err)
		os.Exit(1)
	}
}
