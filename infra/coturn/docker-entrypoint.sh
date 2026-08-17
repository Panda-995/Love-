#!/bin/sh
set -eu

secret_file=/data/turn-secret
external_ip_file=/data/turn-external-ip
wait_seconds=0
while [ ! -s "$secret_file" ] && [ "$wait_seconds" -lt 60 ]; do
  sleep 1
  wait_seconds=$((wait_seconds + 1))
done
if [ ! -s "$secret_file" ]; then
  echo "TURN secret was not created by the app" >&2
  exit 1
fi

config_file=/tmp/turnserver.conf
{
  echo "listening-port=3478"
  echo "fingerprint"
  echo "use-auth-secret"
  printf 'static-auth-secret=%s\n' "$(cat "$secret_file")"
  echo "realm=love-home.local"
  echo "server-name=love-home.local"
  echo "min-port=49160"
  echo "max-port=49200"
  echo "no-cli"
  echo "no-tls"
  echo "no-dtls"
  echo "stale-nonce=600"
  echo "no-multicast-peers"
  if [ -s "$external_ip_file" ]; then
    printf 'external-ip=%s\n' "$(tr -d '\r\n ' < "$external_ip_file")"
  fi
} > "$config_file"

exec turnserver -c "$config_file" --log-file=stdout
