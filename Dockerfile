# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /9artifacts ./cmd/9artifacts \
 && mkdir -p /data /tmpdir

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /9artifacts /9artifacts
COPY --from=build --chown=65532:65532 /data /data
# uploads over 32 MB spill to a temp file; scratch has no /tmp
COPY --from=build --chown=65532:65532 /tmpdir /tmp
USER 65532:65532
ENV NINEARTIFACTS_DATA=/data NINEARTIFACTS_ADDR=:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/9artifacts"]
CMD ["serve"]
