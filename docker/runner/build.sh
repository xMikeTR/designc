#!/usr/bin/env sh
# Builds the designc runner image with the Docker Engine CLI.
set -eu
cd "$(dirname "$0")"
docker build -t designc-runner:latest "$@" .
