#!/bin/sh
# Build release archives into dist/: vitrine_<os>_<arch>.tar.gz (+ .zip for
# Windows) and checksums.txt.  Usage: scripts/build-release.sh v0.1.0
set -eu
VERSION="${1:?usage: build-release.sh VERSION}"
rm -rf dist && mkdir -p dist
for target in linux/amd64 linux/arm64 linux/armv7 darwin/amd64 darwin/arm64 windows/amd64 freebsd/amd64; do
  os=${target%/*}; arch=${target#*/}; goarch=$arch; goarm=""
  if [ "$arch" = armv7 ]; then goarch=arm; goarm=7; fi
  out="dist/vitrine_${os}_${arch}"
  mkdir -p "$out"
  bin=vitrine; [ "$os" = windows ] && bin=vitrine.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$goarch GOARM=$goarm go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$out/$bin" ./cmd/vitrine
  cp README.md LICENSE "$out/"
  if [ "$os" = windows ]; then
    (cd "$out" && zip -q "../vitrine_${os}_${arch}.zip" $bin README.md LICENSE)
  else
    tar -czf "$out.tar.gz" -C "$out" $bin README.md LICENSE
  fi
  rm -rf "$out"
done
(cd dist && (command -v sha256sum >/dev/null && sha256sum vitrine_* || shasum -a 256 vitrine_*) > checksums.txt)
ls -lh dist
