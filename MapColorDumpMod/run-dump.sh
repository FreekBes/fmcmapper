#!/usr/bin/env bash
# Launch loom's dev server, wait until the mod has written the color tables,
# then stop the server so the container exits on its own.
set -uo pipefail

# The mod needs run/grass.png and run/foliage.png (256x256 colormap textures) to
# resolve biome grass/foliage tints; without them those colors come out as -1.
# If they're absent (fresh image, or an empty mounted volume), fetch them from
# Mojang's official CDN: resolve this version's client jar via the version
# manifest, then extract just the two colormap entries. runServer's working dir
# is run/, so that's where the mod looks for them.
ensure_colormaps() {
  [ -f run/grass.png ] && [ -f run/foliage.png ] && return 0

  local ver manifest meta jar
  ver="$(grep -E '^minecraft_version=' gradle.properties | cut -d= -f2 | tr -d '[:space:]')"
  manifest=https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
  echo "[entrypoint] colormaps missing — fetching for Minecraft ${ver} from Mojang CDN"

  meta="$(curl -fsSL "$manifest" | jq -r --arg v "$ver" '.versions[]|select(.id==$v).url')"
  [ -n "$meta" ] && [ "$meta" != null ] || { echo "[entrypoint] version ${ver} not in manifest" >&2; return 1; }
  jar="$(curl -fsSL "$meta" | jq -r '.downloads.client.url')"
  [ -n "$jar" ] && [ "$jar" != null ] || { echo "[entrypoint] no client jar url for ${ver}" >&2; return 1; }

  curl -fsSL "$jar" -o /tmp/client.jar || return 1
  unzip -j -o /tmp/client.jar \
    assets/minecraft/textures/colormap/grass.png \
    assets/minecraft/textures/colormap/foliage.png -d run/ || return 1
  rm -f /tmp/client.jar
  echo "[entrypoint] colormaps written to run/"
}

ensure_colormaps || echo "[entrypoint] WARNING: colormap fetch failed; biome grass/foliage will be -1" >&2

# The server reads console commands from its stdin (loom forwards it), so we
# feed "stop" through a FIFO once the dump line appears. Open it read-write
# (<>): a write-only open would block until a reader appears, but the reader
# (gradlew, below) is the next command and would never get to run — deadlock.
# Holding it open via fd 3 also keeps the server's stdin from hitting EOF.
fifo="$(mktemp -u)"
mkfifo "$fifo"
exec 3<>"$fifo"

./gradlew --no-daemon runServer <"$fifo" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  # biome_colors.json is the last table the mod writes (after map_colors.json),
  # so its line means the dump is complete.
  # Matches: [map-color-dump] wrote /.../run/biome_colors.json (N biomes)
  case "$line" in
    *"] wrote "*biome_colors.json*)
      echo "[entrypoint] color tables written — stopping server"
      echo stop >&3
      ;;
  esac
done

exec 3>&-
rm -f "$fifo"
