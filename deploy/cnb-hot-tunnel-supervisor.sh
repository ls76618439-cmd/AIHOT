#!/usr/bin/env bash
# CNB hot-only Chisel supervisor. Existing tunnel connections are left untouched.
set -u

TUNNEL_DIR=/srv/chatgpt/aihot-runtime/tunnel
CHISEL="$TUNNEL_DIR/chisel"
AUTH_FILE="$TUNNEL_DIR/chisel-auth.env"
REVERSE="R:127.0.0.1:13000:127.0.0.1:3000"
child=""

mkdir -p "$TUNNEL_DIR"
exec 9>"$TUNNEL_DIR/.chisel-supervisor.lock"
if ! flock -n 9; then
  echo "vhot tunnel supervisor already running"
  exit 0
fi

client_running() {
  local proc exe args
  for proc in /proc/[0-9]*; do
    exe=$(readlink "$proc/exe" 2>/dev/null || :)
    [[ "$exe" == "$CHISEL" ]] || continue
    args=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || :)
    [[ "$args" == *" client "* && "$args" == *"$REVERSE"* ]] && return 0
  done
  return 1
}

shutdown() {
  trap - INT TERM
  if [[ -n "$child" ]]; then
    kill "$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
  exit 0
}
trap shutdown INT TERM

while :; do
  if client_running; then
    sleep 10
    continue
  fi
  if [[ ! -x "$CHISEL" || ! -r "$AUTH_FILE" || -z "${HTTPS_PROXY:-}" ]]; then
    echo "vhot tunnel prerequisites missing; retrying in 30s"
    sleep 30
    continue
  fi
  (
    cd "$TUNNEL_DIR" || exit 1
    set -a
    . "$AUTH_FILE"
    set +a
    exec ./chisel client --proxy "$HTTPS_PROXY" --keepalive 25s --max-retry-interval 5s https://vhot.zhiai.fun "$REVERSE"
  ) &
  child=$!
  wait "$child"
  rc=$?
  child=""
  echo "vhot tunnel client exited (status=$rc); retrying in 8s"
  sleep 8
done