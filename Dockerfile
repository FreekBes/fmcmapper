FROM node:24-bullseye AS deps
# RUN apt-get update && apt-get install -y
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:24-bullseye AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY assets ./assets
RUN npm install -g typescript
RUN tsc

FROM node:24-bullseye AS runner
WORKDIR /app
ENV NODE_ENV production
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/assets ./assets

# Provide WORLD_PATH (default ./world), DIMENSION (default minecraft:overworld),
# and OUTPUT_PATH (default ./output)  at runtime,
# e.g. docker run -e WORLD_PATH=./world -v $PWD/world:/app/world:ro -v $PWD/output:/app/output fmcmapper

# Healthy once the viewer page exists (written at the start of the first render).
# Honors OUTPUT_PATH; resolved relative to WORKDIR when it's a relative path.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD test -f "${OUTPUT_PATH:-./output}/index.html"

CMD ["node", "build/buildtiles.js"]
