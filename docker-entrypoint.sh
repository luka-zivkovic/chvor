#!/bin/sh
# Fix volume permissions: bind-mounted dirs may be owned by root/host-user.
# Runs as root, fixes ownership, then drops to 'node' for the app process.
mkdir -p /home/node/.chvor/data
chown -R node:node /home/node/.chvor
exec runuser -u node -- "$@"
