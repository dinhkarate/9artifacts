# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /glasshelf ./cmd/glasshelf \
 && mkdir -p /data

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /glasshelf /glasshelf
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
ENV GLASSHELF_DATA=/data GLASSHELF_ADDR=:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/glasshelf"]
CMD ["serve"]
