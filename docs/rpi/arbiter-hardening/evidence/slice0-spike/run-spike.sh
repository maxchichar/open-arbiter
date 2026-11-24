#!/usr/bin/env bash
# Run the slice-0 spike on local D1 (workerd) and print its JSON. Usage: bash run-spike.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
state="$(mktemp -d)"; port=$((20000 + RANDOM % 20000))
"$repo/node_modules/.bin/wrangler" dev --config "$here/wrangler.toml" --local --port "$port" --ip 127.0.0.1 --persist-to "$state" --show-interactive-dev-session=false --log-level warn >"$state/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf "$state"' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 1; done
curl -s "http://127.0.0.1:$port/"
