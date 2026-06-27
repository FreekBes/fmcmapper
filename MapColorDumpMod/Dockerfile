# map-color-dump — Fabric mod for Minecraft 26.2.
# Builds the mod and launches loom's dev server (`gradlew runServer`), which
# writes map_colors.json + biome_colors.json (to /out) once the world loads.
#
# Minecraft 26.2 needs a full JDK 25 (javac), not just a JRE — loom checks the
# JVM Gradle runs on. eclipse-temurin:25-jdk provides it.
FROM eclipse-temurin:25-jdk

# Tools run-dump.sh uses to fetch the colormap textures from Mojang's CDN.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /mod

# Step 1: pull in only the Gradle wrapper + build scripts and pre-download the
# Gradle distribution and project dependencies. Kept in its own layer so source
# edits don't re-trigger the (slow) dependency fetch.
COPY gradlew gradlew.bat settings.gradle build.gradle gradle.properties ./
COPY gradle ./gradle
RUN chmod +x gradlew && ./gradlew --no-daemon help

# Step 2: copy the source and build the mod jar (compiles against MC 26.2).
COPY src ./src
RUN ./gradlew --no-daemon build

# The mod writes the JSON tables here instead of into run/, so you only need to
# mount this small dir to collect the output (not the whole run/ working dir):
#   docker run -v "$PWD/out:/out" <image>
ENV MAPCOLOR_OUTPUT_DIR=/out

# Step 3: just the entrypoint. The run directory isn't shipped — loom creates
# it, the server generates its config with defaults, the mod writes eula.txt,
# and run-dump.sh fetches the colormaps from Mojang's CDN.
COPY run-dump.sh ./
RUN chmod +x run-dump.sh

# runServer downloads the MC server + Fabric on first launch, loads the world,
# and the mod dumps the color tables. run-dump.sh stops the server once the
# tables are written so the container exits on its own.
CMD ["./run-dump.sh"]
