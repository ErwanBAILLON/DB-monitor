#!/bin/sh
set -e

# Migrations run in the Deployment's init container (helm/templates/deployment.yaml).

cleanup() {
  echo "Received SIGTERM — shutting down gracefully..."
  if [ -n "$NODE_PID" ]; then
    kill -TERM "$NODE_PID" 2>/dev/null
    wait "$NODE_PID"
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

echo "Starting server..."
node server.js &
NODE_PID=$!
wait "$NODE_PID"
