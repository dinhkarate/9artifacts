#!/bin/sh
# vitrine installer — downloads the release binary and (on Linux with
# systemd) installs a hardened service.
#
#   curl -fsSL https://raw.githubusercontent.com/dinhkarate/vitrine/main/install.sh | sudo sh -s -- --domain art.example.com
#
# Options:
#   --domain D           serve HTTPS for D with automatic Let's Encrypt certificates (ports 80/443)
#   --content-domain C   second domain for artifact content (recommended isolation)
#   --email E            contact email for Let's Encrypt
#   --url U              public URL when running behind your own reverse proxy (listens on 127.0.0.1:8080)
#   --version V          release tag to install (default: latest)
#   --no-service         only install the binary
set -eu

REPO="dinhkarate/vitrine"
VERSION="latest"
DOMAIN=""
CONTENT_DOMAIN=""
EMAIL=""
URL=""
SERVICE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --content-domain) CONTENT_DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7l|armv7) arch=armv7 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
case "$os" in linux|darwin) ;; *) echo "unsupported OS: $os (build from source: go install github.com/$REPO/cmd/vitrine@latest)" >&2; exit 1 ;; esac

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
asset="vitrine_${os}_${arch}.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "→ downloading $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"
(cd "$tmp" && grep " $asset\$" checksums.txt | { if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi; }) >/dev/null
tar -xzf "$tmp/$asset" -C "$tmp" vitrine

bindir=/usr/local/bin
if [ ! -w "$bindir" ]; then
  if [ "$(id -u)" -ne 0 ]; then bindir="$HOME/.local/bin"; mkdir -p "$bindir"; fi
fi
install -m 0755 "$tmp/vitrine" "$bindir/vitrine"
echo "→ installed $("$bindir/vitrine" version) to $bindir/vitrine"

if [ "$SERVICE" -eq 0 ] || [ "$os" != "linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "Run it with: vitrine serve --url http://localhost:8080"
  exit 0
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Re-run with sudo to install the systemd service." >&2
  exit 1
fi

args=""
if [ -n "$DOMAIN" ]; then
  args="--domain $DOMAIN"
  [ -n "$CONTENT_DOMAIN" ] && args="$args --content-domain $CONTENT_DOMAIN"
  [ -n "$EMAIL" ] && args="$args --email $EMAIL"
else
  [ -n "$URL" ] || URL="http://localhost:8080"
  args="--addr 127.0.0.1:8080 --url $URL --trust-proxy"
fi

cat > /etc/systemd/system/vitrine.service <<EOF
[Unit]
Description=vitrine — self-hosted AI artifacts
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$bindir/vitrine serve --data /var/lib/vitrine $args
DynamicUser=yes
StateDirectory=vitrine
StateDirectoryMode=0700
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
MemoryMax=256M
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now vitrine.service
sleep 2
echo
echo "vitrine is running. Open the first-run link below to set your password:"
journalctl -u vitrine.service -n 20 --no-pager -o cat | grep -m1 "first run" || echo "(already set up — run: sudo vitrine status --data /var/lib/vitrine)"
echo
echo "Create an agent token on this server with: sudo vitrine token --data /var/lib/vitrine --name my-agent"
