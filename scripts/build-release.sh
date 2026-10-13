#!/bin/sh
# Build release archives into dist/: vitryn_<os>_<arch>.tar.gz (+ .zip for
# Windows) and checksums.txt.  Usage: scripts/build-release.sh v0.1.0
set -eu
VERSION="${1:?usage: build-release.sh VERSION}"
rm -rf dist && mkdir -p dist
for target in linux/amd64 linux/arm64 linux/armv7 darwin/amd64 darwin/arm64 windows/amd64 freebsd/amd64; do
  os=${target%/*}; arch=${target#*/}; goarch=$arch; goarm=""
  if [ "$arch" = armv7 ]; then goarch=arm; goarm=7; fi
  out="dist/vitryn_${os}_${arch}"
  mkdir -p "$out"
  bin=vitryn; [ "$os" = windows ] && bin=vitryn.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$goarch GOARM=$goarm go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$out/$bin" ./cmd/vitryn
  cp README.md LICENSE "$out/"
  if [ "$os" = windows ]; then
    (cd "$out" && zip -q "../vitryn_${os}_${arch}.zip" $bin README.md LICENSE)
  else
    tar -czf "$out.tar.gz" -C "$out" $bin README.md LICENSE
  fi
  rm -rf "$out"
done
# vitryn-ts: Tailscale built in (separate module, ~16 MB larger).
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}
  out="dist/vitryn-ts_${os}_${arch}"
  mkdir -p "$out"
  bin=vitryn-ts; [ "$os" = windows ] && bin=vitryn-ts.exe
  (cd tailscale && CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "../$out/$bin" .)
  cp README.md LICENSE "$out/"
  if [ "$os" = windows ]; then
    (cd "$out" && zip -q "../vitryn-ts_${os}_${arch}.zip" $bin README.md LICENSE)
  else
    tar -czf "$out.tar.gz" -C "$out" $bin README.md LICENSE
  fi
  rm -rf "$out"
done
(cd dist && (command -v sha256sum >/dev/null && sha256sum vitryn_* vitryn-ts_* || shasum -a 256 vitryn_* vitryn-ts_*) > checksums.txt)
ls -lh dist
