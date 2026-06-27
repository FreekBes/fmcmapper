# map-color-dump

A tiny Fabric mod that writes every block's **vanilla map color** to
`map_colors.json`, plus the resolved grass/foliage/water color per biome to
`biome_colors.json`. Run it once on your Minecraft version (26.2) to get
authoritative color tables you can feed into the map tiler.

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

And `biome_colors.json`, the per-biome grass/foliage/water tints — see
[Biome colors](#biome-colors-grass--foliage--water) below for its format and the
colormap PNGs it needs.

## Requirements

- A full **JDK 25** (not just a JRE — the build needs `javac`). Minecraft 26.2
  requires Java 25, and loom checks the JVM Gradle runs on.
- No Gradle install needed; the Gradle wrapper (`./gradlew`, Gradle 9.5.0) is
  bundled. Versions for 26.2 are already filled in `gradle.properties`.

Verify you have a JDK (this must print a version, not error):

```
javac --version
```

## Build & run

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

3. **Run it once to produce the color tables.** Easiest is loom's dev server,
   which wires in the mod + Fabric API automatically:

   ```
   ./gradlew runServer
   ```

   Wait for these lines, then stop the server (type `stop`, or Ctrl-C):

   ```
   [map-color-dump] wrote .../run/map_colors.json (N blocks)
   [map-color-dump] wrote .../run/biome_colors.json (N biomes)
   ```

   The files are at `run/map_colors.json` and `run/biome_colors.json`.

   **Alternative — your own server:** drop `build/libs/mapcolor-dump-1.0.0.jar`
   plus the Fabric API jar into a 26.2 Fabric server's `mods/`, start once,
   and collect both JSON files from the server folder. (Running only needs a
   JRE 25; compiling needs the JDK.)

## Run with Docker

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

## Notes

- 26.x has no official Mojang mappings and no Yarn; loom uses its built-in
  default mapping set, so `build.gradle` has **no `mappings` line**. Do not add
  `loom.officialMojangMappings()` — it fails with "Failed to find official
  mojang mappings".
- Biome-tinted blocks (grass, foliage, water, ...) report their **base** map
  color here, since there's no biome context at dump time. That's the right
  value to shade yourself; in-game those get an extra biome tint.
- This dumps the **default block state** of each block, which matches a
  top-down map keyed by block name. For per-state colors (e.g.
  `grass_block[snowy=true]`), iterate the block's possible states instead of
  its default state.

## Biome colors (grass / foliage / water)

This mod also writes `biome_colors.json` (resolved grass, foliage, and water
color per biome), used to tint the map by biome for a Bedrock-style look.

Grass and foliage colors are looked up from the colormap textures. Instead of
needing the client, drop the two PNGs into the **run directory** and the mod
seeds vanilla's colormaps from them, so it resolves correctly even headless.

> Note: `grass.png` / `foliage.png` are Mojang game files. Extract them from
> your **own** client jar and keep them only in `run/` (which is gitignored) —
> do not commit or redistribute them. See Minecraft's usage guidelines.

The colormaps live inside the client jar, not in `.minecraft/assets` (that is a
hash-named blob store). Extract them from a jar you own:

```
JAR=~/.minecraft/versions/26.2/26.2.jar               # adjust to your path
unzip -l "$JAR" | grep colormap                       # confirm the paths
unzip -j "$JAR" assets/minecraft/textures/colormap/grass.png \
                assets/minecraft/textures/colormap/foliage.png -d run/
```

Then build and run headless:

```
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
./gradlew runServer
```

You should see:

```
[map-color-dump] loaded colormap .../run/grass.png
[map-color-dump] loaded colormap .../run/foliage.png
[map-color-dump] wrote .../run/map_colors.json (N blocks)
[map-color-dump] wrote .../run/biome_colors.json (M biomes)
```

A `-1` grass/foliage warning means the PNGs weren't found in `run/` (or weren't
256x256). Water color is server-side and is correct regardless.

Format:

```json
{
  "minecraft:plains": {
    "grass":   { "RGB": 9551193, "hex": "#91BD59" },
    "foliage": { "RGB": 7842607, "hex": "#77AB2F" },
    "water":   { "RGB": 4159204, "hex": "#3F76E4" }
  }
}
```

`RGB` is a packed `0xRRGGBB` int (`-1` = not resolved); `hex` is for eyeballing.
