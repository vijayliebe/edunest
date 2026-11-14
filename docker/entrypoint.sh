#!/bin/sh
# Drops root to PUID:PGID (like other NAS apps) so files in /data are owned by your NAS user.
set -e
CMD="uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips=*"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${EDUNEST_DATA_DIR:-/data}"
  chown -R "${PUID}:${PGID}" "${EDUNEST_DATA_DIR:-/data}" 2>/dev/null || true
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --clear-groups $CMD
fi
exec $CMD
