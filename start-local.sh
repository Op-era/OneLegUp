#!/usr/bin/env bash
# Starts the OneLegUp RSVP server + Cloudflare tunnel
# Install as a launchd service with com.onelegup.tunnel.plist for auto-start on boot

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=3002

echo "==> Starting RSVP server on port $PORT..."
pkill -f "node.*server.js" 2>/dev/null; sleep 1
node "$SCRIPT_DIR/server.js" > /tmp/onelegup-server.log 2>&1 &
SERVER_PID=$!
sleep 1

echo ""
echo "==> Starting Cloudflare tunnel..."
pkill -f cloudflared 2>/dev/null; sleep 1
cloudflared tunnel --url http://localhost:$PORT --no-autoupdate > /tmp/onelegup-cf.log 2>&1 &
CF_PID=$!

echo "    Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 20); do
  sleep 1
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*.trycloudflare.com' /tmp/onelegup-cf.log 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then break; fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Could not get Cloudflare tunnel URL. Check /tmp/onelegup-cf.log"
  exit 1
fi

echo "    Tunnel URL: $TUNNEL_URL"

echo ""
echo "==> Updating HTML files with live tunnel URL..."
for f in signup.html register.html login.html dashboard.html set-password.html; do
  sed -i '' "s|const API = '.*'|const API = '$TUNNEL_URL'|" "$SCRIPT_DIR/$f" 2>/dev/null || true
done
sed -i '' "s|const RSVP_URL = '.*'|const RSVP_URL = '$TUNNEL_URL/rsvp'|" "$SCRIPT_DIR/signup.html"
sed -i '' "s|const RSVP_API = '.*'|const RSVP_API = '$TUNNEL_URL'|" "$SCRIPT_DIR/admin.html"

echo ""
echo "=========================================="
echo "  OneLegUp RSVP Backend is LIVE"
echo "=========================================="
echo "  Public URL : $TUNNEL_URL"
echo "  Local port : http://localhost:$PORT"
echo "  RSVPs file : $SCRIPT_DIR/rsvps.json"
echo "=========================================="
echo ""
echo "Press Ctrl+C to stop everything."

trap "kill $SERVER_PID $CF_PID 2>/dev/null" EXIT
wait $CF_PID
