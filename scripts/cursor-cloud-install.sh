#!/usr/bin/env bash
# Cursor Cloud Agent: install deps + syntax-check server entrypoint.
set -euo pipefail

npm ci
node --check server.js
