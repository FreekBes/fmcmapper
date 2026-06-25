# map-color-dump

A tiny Fabric mod that writes every block's **vanilla map color** to
`map_colors.json`. Run it once on your Minecraft version (26.1.2) to get an
authoritative `block -> color` table you can feed into the map tiler.

## Output

`map_colors.json` in the run directory, e.g.:

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

## Requirements

- A full **JDK 25** (not just a JRE — the build needs `javac`). Minecraft 26.1.2
  requires Java 25, and loom checks the JVM Gradle runs on.
- No Gradle install needed; the Gradle wrapper (`./gradlew`, Gradle 9.5.0) is
  bundled. Versions for 26.1.2 are already filled in `gradle.properties`.

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

3. **Run it once to produce `map_colors.json`.** Easiest is loom's dev server,
   which wires in the mod + Fabric API automatically:

   ```
   ./gradlew runServer
   ```

   The first run stops on the Minecraft EULA. Accept it and re-run:

   ```
   echo "eula=true" > run/eula.txt
   ./gradlew runServer
   ```

   Wait for this line, then stop the server (type `stop`, or Ctrl-C):

   ```
   [map-color-dump] wrote .../run/map_colors.json (N blocks)
   ```

   The file is at `run/map_colors.json`.

   **Alternative — your own server:** drop `build/libs/mapcolor-dump-1.0.0.jar`
   plus the Fabric API jar into a 26.1.2 Fabric server's `mods/`, start once,
   and collect `map_colors.json` from the server folder. (Running only needs a
   JRE 25; compiling needs the JDK.)

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
