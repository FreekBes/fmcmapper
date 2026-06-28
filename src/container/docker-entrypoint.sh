#!/bin/sh
set -e

# Serve-only mode: skip rendering and just serve the already-rendered map. Useful
# once a world is "finished" — you can delete the world files to save disk and
# keep serving the existing output. nginx becomes the container's main process;
# the renderer (and live player tracking) never start, so no world is read.
case "${SERVE_ONLY:-}" in
  1 | true | TRUE | yes | YES)
    echo "SERVE_ONLY set — serving the existing map without rendering"
    exec nginx -g 'daemon off;'
    ;;
esac

# Until the first render writes the real viewer, serve a "rendering in progress"
# placeholder so visitors get a friendly page instead of a 404. The renderer
# overwrites /app/output/index.html at the start of its first render. Only seed it
# when there's no map yet, so we never clobber an already-rendered one.
mkdir -p /app/output
[ -f /app/output/index.html ] || cp /app/loading.html /app/output/index.html

# Normal mode: nginx serves the map (and reverse-proxies the player WebSocket) in
# the background, then the renderer runs in the foreground as the container's main
# process — when it stops, the container stops. nginx access/error logs go to
# stdout/stderr via the symlinks set up in the image.
nginx

exec node build/buildtiles.js
