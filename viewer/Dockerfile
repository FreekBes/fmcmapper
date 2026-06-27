FROM nginx:alpine

LABEL org.opencontainers.image.source=https://github.com/FreekBes/fmcmapper
LABEL org.opencontainers.image.description="Serves an fmcmapper output directory over HTTP with sensible caching (revalidate + ETag 304s) and gzip. Mount the render output read-only at /usr/share/nginx/html. Docs: github.com/FreekBes/fmcmapper"
LABEL org.opencontainers.image.licenses=MIT

# The image is just nginx + this serving config; the actual map (index.html,
# tiles, biome GeoJSON) is the renderer's output, mounted at the web root.
COPY default.conf /etc/nginx/conf.d/default.conf
