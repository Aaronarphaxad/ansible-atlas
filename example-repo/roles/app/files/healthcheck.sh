#!/usr/bin/env bash
# Exits non-zero if the app isn't answering on its port.
PORT="${1:-3000}"
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null
