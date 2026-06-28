FROM node:24-bullseye AS deps
# RUN apt-get update && apt-get install -y
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:24-bullseye AS builder
WORKDIR /app
COPY LICENSE ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY assets ./assets
RUN npm install -g typescript
RUN tsc

FROM node:24-bullseye AS runner
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.source=https://github.com/FreekBes/fmcmapper
LABEL org.opencontainers.image.description="Renders a Minecraft world into a zoomable, in-game-map-styled web map and serves it over HTTP (built-in nginx). Docs: github.com/FreekBes/fmcmapper"
LABEL org.opencontainers.image.licenses=MIT

# nginx serves the rendered map (and reverse-proxies the player WebSocket) from
# this same container, so one image and one port cover the whole viewer. Drop the
# packaged default site and send nginx's logs to the container's stdout/stderr.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx-light \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default \
  && ln -sf /dev/stdout /var/log/nginx/access.log \
  && ln -sf /dev/stderr /var/log/nginx/error.log

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/assets ./assets
COPY README.md ./
COPY src/container/nginx.conf /etc/nginx/conf.d/default.conf
COPY src/container/loading.html /app/loading.html
COPY src/container/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Provide WORLD_PATH (default ./world), DIMENSION (default minecraft:overworld),
# and OUTPUT_PATH (default ./output) at runtime. nginx serves /app/output, so keep
# OUTPUT_PATH at its default. e.g. docker run -p 8080:80 \
#   -v $PWD/world:/app/world:ro -v $PWD/output:/app/output fmcmapper
#
# The map is served on port 80. The player-tracking WebSocket runs on
# 127.0.0.1:8082 inside the container and is reverse-proxied at /players, so it
# isn't exposed separately.
EXPOSE 80

# Healthy once nginx is running and serves the viewer or the "rendering in progress" page.
# This lets other services wait for the viewer to come online.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s \
  CMD curl -f http://localhost/ || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
