#!/bin/sh
# Rotates application logs on the control node's local log directory.
find ./logs -name '*.log' -mtime +14 -exec gzip {} \;
