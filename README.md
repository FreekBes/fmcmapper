# fmcmapper

**fmcmapper** turns your Minecraft world into a zoomable, lightweight
Google-Maps-style web map you can open in any browser. It reads the world
straight from disk, renders a top-down image of every explored area, and keeps
it up to date as your world grows.

![The fmcmapper web viewer showing a rendered Minecraft world](assets/fmcmapper.png)

- 🗺️ Pan and zoom around your whole world in the browser, like Google Maps
- 🎨 Styled after Minecraft's **in-game map item** — same top-down view, block colours, and height shading
- 🌳 Biome-accurate grass, foliage, leaf-litter, and water tints
- ⚡ **Incremental** — only re-renders the parts of the world that changed
- 🔄 Runs continuously, refreshing the map every few minutes
- 🐳 Ships as a ready-to-run Docker image

The map is just static files (images + a web page), so it's cheap to host and
works behind any web server.

**▶ [Try the live demo](https://freekbes.github.io/fmcmapper/)** — a rendered
example world you can pan and zoom, no setup required.

---

## Contents

- [Beginner: run the whole thing with Docker](#beginner-run-the-whole-thing-with-docker)
- [Advanced: configuration & existing servers](#advanced-configuration--existing-servers)
- [Development: building from source](#development-building-from-source)

---

## Beginner: run the whole thing with Docker

This is the easiest path. You'll get **three things running together**:

1. **A Minecraft server** (your game world).
2. **fmcmapper** — watches the world and renders the map.
3. **A small web server** — shows the map in your browser at `http://<your-server>:8080`.

You don't need to know any code. You just need Docker.

### What is Docker?

Docker runs software in self-contained "containers" so you don't have to install
Node.js, Java, or anything else by hand — everything the program needs comes
bundled. **Docker Compose** lets you describe several containers in one file and
start them all with a single command. That file is already written for you.

### Step 1 — Install Docker

Install **Docker Desktop** (Windows/macOS) or **Docker Engine** (Linux) by
following the official guide: <https://docs.docker.com/get-docker/>. When it's
working, this command prints a version number:

```
docker --version
```

### Step 2 — Create the compose file

Make a fresh, empty folder and, inside it, create a file named
`docker-compose.yml` with this content:

```yaml
services:
  # The Minecraft server itself (provided by itzg/minecraft-server).
  mcserver:
    image: itzg/minecraft-server
    container_name: mcserver
    restart: "unless-stopped"
    ports:
      - "25565:25565"
    environment:
      EULA: "TRUE"
      TYPE: "VANILLA"
      VERSION: "26.2"          # keep this matching the fmcmapper tag below
    volumes:
      - ./mcserver:/data

  # The map renderer (this project).
  fmcmapper:
    image: ghcr.io/freekbes/fmcmapper:26.2
    pull_policy: always
    container_name: fmcmapper
    restart: "unless-stopped"
    environment:
      RENDER_INTERVAL: "5"     # re-render every 5 minutes
    volumes:
      - ./mcserver/world:/app/world:ro
      - ./mcserver/fmcmapper:/app/output
    depends_on:
      mcserver:
        condition: service_healthy

  # A tiny web server that serves the map to web browsers.
  mapserver:
    image: ghcr.io/freekbes/fmcmapper-viewer:latest
    pull_policy: always
    container_name: fmcmapper-server
    restart: "unless-stopped"
    ports:
      - "8080:80"
    volumes:
      - ./mcserver/fmcmapper:/usr/share/nginx/html:ro
    depends_on:
      fmcmapper:
        condition: service_healthy
```

The Minecraft version is set to `26.2` in **two** places above — keep them the
same so the map's colours match your server's blocks.

You can bump both to a newer Minecraft version when one releases, **but
fmcmapper may not support it yet**: if no `fmcmapper` image has been built for
that version, the pull will fail. In that case you can use
`ghcr.io/freekbes/fmcmapper:latest` for the renderer — just be aware `latest` is
the newest build and may be untested against your version (colours could be off
or it may misbehave).

### Step 3 — Start everything

Within the same folder as your `docker-compose.yml`, run:

```
docker compose up -d
```

`-d` means "run in the background". The first start downloads the images and
generates a fresh Minecraft world, so give it a minute.

### Step 4 — Open the map

Go to **`http://localhost:8080`** in your browser (or `http://<server-ip>:8080`
if it's running on another machine). You'll see your world; it fills in as the
server generates and saves chunks.

The map refreshes automatically **every 5 minutes**. To stop everything (run in the same folder as the compose file):

```
docker compose down
```

### What this sets up

| Service     | What it is                          | Port    |
|-------------|-------------------------------------|---------|
| `mcserver`  | A vanilla Minecraft server          | `25565` |
| `fmcmapper` | The map renderer (this project)     | —       |
| `mapserver` | A web server that shows the map     | `8080`  |

A `mcserver/` folder appears next to your compose file — that's your world and
server files. By using this compose file you accept the
[Minecraft EULA](https://aka.ms/MinecraftEULA) (it's set to `TRUE` in the file).

The Minecraft server part isn't ours — it's the excellent
[**itzg/minecraft-server**](https://github.com/itzg/docker-minecraft-server)
image. It handles running the server, EULA, version, mods, and much more. If you
want to change the Minecraft version, switch to Paper/Fabric/Forge, add plugins,
or tune the server, see its [documentation](https://docker-minecraft-server.readthedocs.io/).
fmcmapper only reads the world it produces.

> **That's all a beginner needs.** The sections below are optional.

---

## Advanced: configuration & existing servers

### Use fmcmapper with a server you already run

You don't have to use the bundled Minecraft server. Point fmcmapper at any
world folder on disk. The minimal piece is the `fmcmapper` service:

```yaml
services:
  fmcmapper:
    image: ghcr.io/freekbes/fmcmapper:26.2
    pull_policy: always
    environment:
      RENDER_INTERVAL: "5"          # re-render every 5 minutes
    volumes:
      - /path/to/your/world:/app/world:ro   # your world (read-only)
      - /path/to/output:/app/output         # where the map is written
```

Then serve the `output` folder. The simplest option is the companion
**`ghcr.io/freekbes/fmcmapper-viewer`** image — nginx preconfigured to revalidate
caches (so the map refreshes as the world changes) and gzip the GeoJSON; just
mount the output at `/usr/share/nginx/html`. It's version-independent, so pin
`:latest`. Any other static web server (Caddy, Apache, even `python -m
http.server`) works too — it's just static files. Open `index.html`.

> 💡 With a plain static server, set `Cache-Control: no-cache` on the output so
> browsers revalidate changed tiles instead of serving stale ones. The viewer
> image does this for you; see [`viewer/default.conf`](viewer/default.conf).

> ⚠️ **Match the Minecraft version.** The image tag (`:26.2`) is the Minecraft
> version its colours were built for. If your world is a *different* version,
> fmcmapper still renders, but some block/biome colours may be slightly off and
> it prints a warning on startup. Use the image tag that matches your server,
> or regenerate the colour tables (see [Custom colour tables](#custom-colour-tables)).

### Environment variables

| Variable          | Default                | What it does                                                        |
|-------------------|------------------------|---------------------------------------------------------------------|
| `WORLD_PATH`      | `./world`              | Path to the world folder to render.                                 |
| `OUTPUT_PATH`     | `./output`             | Where the map (tiles + `index.html`) is written.                    |
| `DIMENSION`       | `minecraft:overworld`  | Which dimension to map (`minecraft:the_nether`, `minecraft:the_end`, or a modded id). |
| `RENDER_INTERVAL` | *(unset)*              | Minutes between renders. **Unset = render once and exit.** Set it to run as a service. |
| `TILER_JOBS`      | half your CPU cores    | How many regions to render in parallel.                             |
| `TILER_FULL`      | `0`                    | Set to `1` to force a full redraw instead of an incremental one.    |

The same values can be passed as command-line arguments instead of env vars:
`world` `dimension` `output`, e.g. `… /app/world minecraft:the_nether /app/out`.

**Render once instead of continuously** — add the `--once` flag (overrides
`RENDER_INTERVAL`). Handy for a manual one-off against the running service:

```
docker compose run --rm fmcmapper --once
```

### Map appearance (optional tuning)

These tweak how the map looks. All are optional.

| Variable                  | Default | Effect                                              |
|---------------------------|---------|-----------------------------------------------------|
| `MAP_BRIGHTNESS`          | `1`     | Overall brightness (1 = unchanged, <1 darker).      |
| `MAP_FOLIAGE_BRIGHTNESS`  | `0.55`  | Darkening applied to leaves.                        |
| `MAP_GRASS_BRIGHTNESS`    | `0.8`   | Darkening applied to grass.                         |
| `MAP_DRY_FOLIAGE_BRIGHTNESS` | `0.8`  | Darkening applied to leaf litter (dry-foliage tint).|
| `MAP_WATER_BRIGHTNESS`    | `0.7`   | Darkening applied to water.                         |
| `MAP_BIOME_BLEND`         | `2`     | Biome colour blend radius (like in-game Biome Blend); `0` disables. |

### Custom colour tables

fmcmapper colours blocks using bundled `map_colors.json` and `biome_colors.json`
tables generated for a specific Minecraft version. If you run a different
version (or want exact colours), you can regenerate them with the companion
**map-color-dump** mod and point fmcmapper at the results with `MAP_COLORS_PATH`
and `BIOME_COLORS_PATH`. See [`MapColorDumpMod/README.md`](MapColorDumpMod/README.md).

### Image tags

Images are published to the GitHub Container Registry and tagged by the
Minecraft version they target:

- `ghcr.io/freekbes/fmcmapper:26.2` — newest build for Minecraft 26.2 *(use this)*
- `ghcr.io/freekbes/fmcmapper:26.2-<n>` — a specific immutable build, for rollback
- `ghcr.io/freekbes/fmcmapper:latest` — newest build overall

With `pull_policy: always`, `docker compose up` re-pulls the moving `:26.2` tag,
so you always get the latest render code without editing anything.

### Health check

The container reports **healthy** once the viewer page exists, so other services
(like the web server above) can wait for it before starting.

---

## Development: building from source

### Run it locally with Node.js

Requires Node.js 24+.

```
npm install
npm run build          # compile TypeScript -> build/
npm start              # render: reads WORLD_PATH/OUTPUT_PATH or ./world -> ./output
```

Regenerate just the viewer page from an existing render:

```
npm run viewer         # uses OUTPUT_PATH or ./output
```

### Run from source with Docker Compose

Two compose files in the repo **build from your local checkout** instead of
pulling the published images — use them while developing:

- [`docker-compose.dev.yml`](docker-compose.dev.yml) — the full stack (Minecraft
  server + fmcmapper + web server), with `fmcmapper` built from this repo's
  `Dockerfile`. The same beginner setup, but local-built:

  ```
  docker compose -f docker-compose.dev.yml up --build
  ```

- [`docker-compose.dump.yml`](docker-compose.dump.yml) — builds the
  **map-color-dump** mod from `MapColorDumpMod/` and writes fresh
  `map_colors.json` / `biome_colors.json` into `assets/`. Run this to regenerate
  the colour tables (e.g. for a new Minecraft version):

  ```
  docker compose -f docker-compose.dump.yml up --build
  ```

  See [`MapColorDumpMod/README.md`](MapColorDumpMod/README.md) for details.

### Project layout

| Path                       | What it is                                              |
|----------------------------|---------------------------------------------------------|
| `src/buildtiles.ts`        | Entry point — region discovery, scheduling, tile pyramid. |
| `src/worker.ts`            | Renders one region to an image (runs in worker threads). |
| `src/chunkmap.ts`          | Block/biome → colour logic.                              |
| `src/viewer.ts`            | Generates the Leaflet `index.html`.                      |
| `assets/`                  | Bundled `map_colors.json` / `biome_colors.json`.         |
| `Dockerfile`               | Builds the fmcmapper image.                              |
| `MapColorDumpMod/`         | Companion Fabric mod that generates colour tables. [README](MapColorDumpMod/README.md). |

### Continuous integration

Two GitHub Actions workflows build and push images to GHCR on every push to
`master`:

- [`build-fmcmapper.yml`](.github/workflows/build-fmcmapper.yml) — the renderer image; runs when renderer files change.
- [`build-mapcolordump.yml`](.github/workflows/build-mapcolordump.yml) — the mod image; runs only when `MapColorDumpMod/` changes.

Each build tags images with the Minecraft version (from `TARGET_VERSION` in
`src/buildtiles.ts` / `minecraft_version` in the mod's `gradle.properties`) plus
a build number, and updates the moving `:<version>` and `:latest` tags. Commit
message wording doesn't affect the build (versions come from the build number,
not commit conventions) — only which files changed and the target branch matter.
