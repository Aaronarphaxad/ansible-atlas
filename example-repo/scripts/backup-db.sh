#!/usr/bin/env bash
# Run from the control node: dumps MongoDB on the db host and copies it back.
set -euo pipefail
HOST="${1:-app-mongo01}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
ssh "$HOST" "mongodump --archive --gzip" > "$BACKUP_DIR/$(date +%F)-$HOST.archive.gz"
echo "Backup written to $BACKUP_DIR"
