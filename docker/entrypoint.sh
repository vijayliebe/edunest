#!/bin/sh
# Drops root to PUID:PGID (like other NAS apps) so files in /data are owned by your NAS user.
#   docker run --rm -it edunest hash-password   → prints a password hash for EDUNEST_USERS
set -e

if [ "$1" = "hash-password" ]; then
  shift
  exec python -m app.auth "$@"
fi

# Only trust X-Forwarded-For/-Proto from reverse proxies on private networks (Docker, LAN),
# so a client on the internet cannot fake its IP address in the security log.
TRUSTED="${EDUNEST_TRUSTED_PROXIES:-127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
set -- uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8080}" --proxy-headers --forwarded-allow-ips "$TRUSTED"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "${EDUNEST_DATA_DIR:-/data}"
  chown -R "${PUID}:${PGID}" "${EDUNEST_DATA_DIR:-/data}" 2>/dev/null || true
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --clear-groups "$@"
fi
exec "$@"
