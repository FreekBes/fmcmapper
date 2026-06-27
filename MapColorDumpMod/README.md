# map-color-dump

A tiny Fabric mod that writes every block's **vanilla map color** to
`map_colors.json`, plus the resolved grass/foliage/water color per biome to
`biome_colors.json`. Run it once to get authoritative color tables you can
feed into the map tiler.

The mod is designed to run headless on a server, so you don't need a client.
It was written for **Minecraft version 26.2** but may work on future versions with
minor changes to the build configuration.

## Output

Two files in the run directory. First, `map_colors.json`, e.g.:

```json
{
  "minecraft:stone": {
    "mapColorId": 11,
    "baseRGB": 9474192,
    "baseHex": "#909090",
    "shades": [6697932, 8158332, 9474192, 5000268]
  },
  "minecraft:air": { "mapColorId": 0, "baseRGB": 0, "baseHex": "#000000", "shades": [0,0,0,0] }
}
```

- `baseRGB` / `baseHex` — the block's base map color.
- `shades` — that base x [180, 220, 255, 135] / 255. On a real map the shade is
  picked per column from the height difference with the block to the **north**
  (lower -> 0, same -> 1, higher -> 2). Index 3 only appears via external tools.
- A `mapColorId` of 0 means the block isn't drawn on the map (air, glass, etc.).

Second, `biome_colors.json` — the resolved grass, foliage, and water color per
biome, used to tint the map by biome for a Bedrock-style look:

```json
{
  "minecraft:plains": {
    "grass":   { "RGB": 9551193, "hex": "#91BD59" },
    "foliage": { "RGB": 7842607, "hex": "#77AB2F" },
    "water":   { "RGB": 4159204, "hex": "#3F76E4" }
  }
}
```

- `RGB` is a packed `0xRRGGBB` int (`-1` = not resolved); `hex` is for eyeballing.
- Grass and foliage come from the colormap PNGs you supply when running (see
  step 3 of Build & run); a `-1` value means the PNGs weren't found in `run/`
  (or weren't 256x256). Water is server-side and is correct regardless.

## Running the mod

### Run with Docker (recommended)

The bundled `Dockerfile` does all of the above unattended — no local JDK needed.
It builds the mod, runs the dev server, fetches the colormap textures from
Mojang's CDN, dumps the tables, and stops the server on its own.

```
docker build -t mapcolor-dump .
docker run --rm -v "$PWD/out:/out" mapcolor-dump
```

`map_colors.json` and `biome_colors.json` land in `./out`. Only that small
directory needs to be a volume — the server's `run/` working dir stays inside
the container. (The mod writes to `MAPCOLOR_OUTPUT_DIR`, which the image sets to
`/out`.)


### Build & run locally (manual)

#### Requirements

- A full **JDK 25** (not just a JRE — the build needs `javac`). Modern Minecraft
  requires Java 25, and loom checks the JVM Gradle runs on.
- No Gradle install needed; the Gradle wrapper (`./gradlew`, Gradle 9.5.0) is
  bundled. Versions for the targeted Minecraft version are already filled
  in `gradle.properties`.

Verify you have a JDK (this must print a version, not error):

```
javac --version
```

#### Build & run

1. **Point Gradle at the JDK.** If `gradlew` picks up a JRE you'll get
   "Toolchain ... does not provide ... JAVA_COMPILER". Set `JAVA_HOME` to the
   JDK (the directory whose `bin/` contains `javac`):

   ```
   # auto-detect from javac on PATH:
   export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
   echo "$JAVA_HOME"   # e.g. /usr/lib/jvm/java-25-openjdk-amd64

   # stop any stale daemon that started on the wrong JVM:
   ./gradlew --stop
   ```

   `./gradlew -version` should now show a JDK on the `JVM:` line.

   (Persistent alternative: add `org.gradle.java.home=/path/to/jdk-25` to
   `gradle.properties` instead of exporting `JAVA_HOME`.)

2. **Build:**

   ```
   ./gradlew build
   ```

   The mod jar lands in `build/libs/` (use `mapcolor-dump-1.0.0.jar`, not the
   `-sources` jar).

3. **(Optional, for biome grass/foliage tints) provide the colormap textures.**
   Grass and foliage colors are looked up from the client's colormap PNGs. Drop
   `grass.png` and `foliage.png` into the **run directory** and the mod seeds
   vanilla's colormaps from them, so they resolve even headless. The colormaps
   live inside the client jar (not in `.minecraft/assets`, which is a hash-named
   blob store), so extract them from a jar you own:

   ```
   JAR=~/.minecraft/versions/26.2/26.2.jar               # adjust to your path
   unzip -l "$JAR" | grep colormap                       # confirm the paths
   unzip -j "$JAR" assets/minecraft/textures/colormap/grass.png \
                   assets/minecraft/textures/colormap/foliage.png -d run/
   ```

   > Note: `grass.png` / `foliage.png` are Mojang game files. Extract them from
   > your **own** client jar and keep them only in `run/` (which is gitignored) —
   > do not commit or redistribute them. See Minecraft's usage guidelines. (The
   > Docker image fetches them from Mojang's CDN automatically, skipping this.)

   Skip this if you only need `map_colors.json`; grass/foliage will then come out
   as `-1` (water is server-side and resolves regardless).

4. **Run it once to produce the color tables.** Loom's dev server wires in the
   mod + Fabric API automatically:

   ```
   ./gradlew runServer
   ```

   Wait for these lines, then stop the server (type `stop`, or Ctrl-C):

   ```
   [map-color-dump] loaded colormap .../run/grass.png      # only if you did step 3
   [map-color-dump] loaded colormap .../run/foliage.png    # only if you did step 3
   [map-color-dump] wrote .../run/map_colors.json (N blocks)
   [map-color-dump] wrote .../run/biome_colors.json (M biomes)
   ```

   Both files land in `run/`: `map_colors.json` and `biome_colors.json`.

   **Alternative — your own server:** drop `build/libs/mapcolor-dump-1.0.0.jar`
   plus the Fabric API jar into a Fabric server's `mods/`, start once,
   and collect both JSON files from the server folder. (Running only needs a
   JRE 25; compiling needs the JDK.)
