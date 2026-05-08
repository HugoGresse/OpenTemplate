#!/bin/sh
# Container entrypoint.
#
# Why this exists:
# - Our app runs as pptruser (uid 1000).
# - Hosting platforms (Coolify, Portainer, plain `docker volume create`) often
#   pre-create the named volume on the host and mount it into the container
#   owned by root:root. The mount overlays whatever perms the image baked at
#   /data/* during build, so pptruser cannot write — saves silently fail.
# - Container therefore boots as root, this script chown's the data dirs to
#   pptruser, then drops privileges via runuser before exec'ing the app.
#
# Idempotent: chown is a no-op when ownership is already correct.

set -e

DATA_DIRS="${TEMPLATES_DIR:-/data/templates} ${FILES_DIR:-/data/files}"

if [ "$(id -u)" = "0" ]; then
  for dir in $DATA_DIRS; do
    if [ -d "$dir" ]; then
      chown -R pptruser:pptruser "$dir" 2>/dev/null || true
      # Ensure the directory itself is writable for the user even if a host
      # ACL / SELinux policy got in the way.
      chmod u+rwx "$dir" 2>/dev/null || true
    fi
  done
  # exec keeps PID 1 = the app, so SIGTERM from Docker reaches Node directly
  # and triggers graceful shutdown / pino flush.
  exec runuser -u pptruser -- "$@"
fi

# Already non-root (e.g. local docker run with --user). Just hand off.
exec "$@"
