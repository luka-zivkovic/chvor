#!/bin/sh
# When running with bind-mounted volumes, the host directory ownership may
# not match the container's 'node' user. This entrypoint fixes permissions
# when running as root, then drops to 'node'. When already running as 'node'
# (e.g. Kubernetes with securityContext), it just execs directly.

if [ "$(id -u)" = "0" ]; then
  mkdir -p /home/node/.chvor/data
  chown -R node:node /home/node/.chvor
  exec su -s /bin/sh node -- -c 'exec "$@"' -- "$@"
fi

exec "$@"
