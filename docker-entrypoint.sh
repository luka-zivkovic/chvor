#!/bin/sh
# Simple passthrough entrypoint.
# The container runs as 'node' user with data stored in /data (chmod 777).
# No permission fixup needed — Docker named volumes handle ownership correctly.
exec "$@"
