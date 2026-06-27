package es.freekb.mapcolordump;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.FoliageColor;
import net.minecraft.world.level.GrassColor;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.MapColor;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Dumps two tables to the run directory when the server starts:
 *
 *   map_colors.json   - the vanilla map color of every block (default state).
 *   biome_colors.json - the resolved grass / foliage / water color per biome.
 *
 * Grass & foliage colors are looked up from the colormap textures. Rather than
 * requiring the client, drop the two PNGs in the run directory:
 *
 *   run/grass.png    (extract from YOUR OWN client jar:
 *   run/foliage.png   assets/minecraft/textures/colormap/*.png)
 *
 * and the mod seeds vanilla's GrassColor/FoliageColor from them, so it resolves
 * correctly even headless (./gradlew runServer). If the PNGs are missing, grass
 * and foliage come out as -1 (water still works). Do not commit these PNGs;
 * they're Mojang game files (run/ is gitignored).
 *
 * biome_colors.json entries look like:
 *   "minecraft:plains": {
 *     "grass":   { "RGB": 9551193, "hex": "#91BD59" },
 *     "foliage": { "RGB": 7842607, "hex": "#77AB2F" },
 *     "water":   { "RGB": 4159204, "hex": "#3F76E4" }
 *   }
 */
public class MapColorDump implements ModInitializer {

    // The four brightness multipliers the map item applies (then / 255).
    private static final int[] MULTIPLIERS = { 180, 220, 255, 135 };

    // Where the JSON tables are written. Defaults to the run directory (cwd);
    // set MAPCOLOR_OUTPUT_DIR to redirect them elsewhere — e.g. a small mounted
    // volume, so you don't have to persist the whole run/ folder.
    private static final Path OUTPUT_DIR = resolveOutputDir();

    private static Path resolveOutputDir() {
        String dir = System.getenv("MAPCOLOR_OUTPUT_DIR");
        return Path.of(dir == null || dir.isBlank() ? "." : dir);
    }

    @Override
    public void onInitialize() {
        // Fabric invokes "main" entrypoints at the very start of the server's
        // Main, before vanilla reads eula.txt. Writing it here means the dump
        // server starts unattended (no manual "echo eula=true").
        acceptEula();
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            dumpBlocks();
            dumpBiomes(server);
        });
    }

    // Write eula.txt=true in the run directory so the dedicated server doesn't
    // halt on first launch. Skips the write if it already agrees.
    private void acceptEula() {
        Path p = Path.of("eula.txt");
        try {
            if (Files.exists(p) && Files.readString(p).contains("eula=true")) return;
            Files.writeString(p,
                "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n"
                    + "eula=true\n");
            System.out.println("[map-color-dump] accepted Minecraft EULA -> " + p.toAbsolutePath());
        } catch (Exception e) {
            System.err.println("[map-color-dump] failed to write eula.txt: " + e);
        }
    }

    // -- blocks ---------------------------------------------------------------

    private void dumpBlocks() {
        Map<String, Object> out = new LinkedHashMap<>();

        for (Block block : BuiltInRegistries.BLOCK) {
            Identifier key = BuiltInRegistries.BLOCK.getKey(block);
            BlockState state = block.defaultBlockState();

            MapColor mc;
            try {
                mc = state.getMapColor(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
            } catch (Exception e) {
                mc = null;
            }

            Map<String, Object> entry = new LinkedHashMap<>();
            if (mc == null || mc == MapColor.NONE) {
                entry.put("mapColorId", 0);
                entry.put("baseRGB", 0);
                entry.put("baseHex", "#000000");
                entry.put("shades", new int[] { 0, 0, 0, 0 });
            } else {
                int rgb = mc.col & 0xFFFFFF;
                int[] shades = new int[4];
                for (int i = 0; i < 4; i++) shades[i] = shade(rgb, MULTIPLIERS[i]);
                entry.put("mapColorId", mc.id);
                entry.put("baseRGB", rgb);
                entry.put("baseHex", String.format("#%06X", rgb));
                entry.put("shades", shades);
            }
            out.put(key.toString(), entry);
        }
        write("map_colors.json", out, "blocks");
    }

    // -- biomes ---------------------------------------------------------------

    @FunctionalInterface
    private interface IntCall { int get(); }

    // Returns 0xRRGGBB, or -1 if the accessor failed (e.g. colormap not loaded).
    private static int safe(IntCall c) {
        try { return c.get() & 0xFFFFFF; } catch (Throwable t) { return -1; }
    }

    private void dumpBiomes(MinecraftServer server) {
        // Seed vanilla's colormaps from PNGs in the run dir so grass/foliage
        // resolve headlessly (no client needed).
        boolean haveColormaps = seedColormaps();

        Map<String, Object> out = new LinkedHashMap<>();

        // 26.x: registryOrThrow was renamed to lookupOrThrow; on RegistryAccess
        // it still returns the full Registry (iterable, with getKey).
        Registry<Biome> biomes = server.registryAccess().lookupOrThrow(Registries.BIOME);

        int missing = 0;
        for (Biome b : biomes) {
            Identifier id = biomes.getKey(b); // same call that worked for blocks
            if (id == null) continue;

            int grass = safe(() -> b.getGrassColor(0.0, 0.0));
            int foliage = safe(() -> b.getFoliageColor());
            int water = safe(() -> b.getSpecialEffects().waterColor());
            if (grass < 0 || foliage < 0) missing++;

            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("grass", colorObj(grass));
            entry.put("foliage", colorObj(foliage));
            entry.put("water", colorObj(water));
            out.put(id.toString(), entry);
        }

        write("biome_colors.json", out, "biomes");
        if (missing > 0) {
            System.err.println("[map-color-dump] WARNING: " + missing
                + " biomes had no grass/foliage color (-1). Put grass.png and "
                + "foliage.png (256x256) in the run directory ("
                + (haveColormaps ? "loaded, but lookup still failed" : "not found")
                + ").");
        }
    }

    // Load run/grass.png and run/foliage.png into vanilla's static colormaps.
    private boolean seedColormaps() {
        int[] grass = loadColormap("grass.png");
        int[] foliage = loadColormap("foliage.png");
        boolean ok = false;
        if (grass != null) {
            try { GrassColor.init(grass); ok = true; } catch (Throwable t) {
                System.err.println("[map-color-dump] GrassColor.init failed: " + t);
            }
        }
        if (foliage != null) {
            try { FoliageColor.init(foliage); ok = true; } catch (Throwable t) {
                System.err.println("[map-color-dump] FoliageColor.init failed: " + t);
            }
        }
        return ok;
    }

    // { "RGB": 9551193, "hex": "#91BD59" }  (RGB -1 / hex "?" if unresolved)
    private static Map<String, Object> colorObj(int rgb) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("RGB", rgb);
        m.put("hex", rgb < 0 ? "?" : String.format("#%06X", rgb));
        return m;
    }

    // Reads a 256x256 colormap PNG (placed in the run directory) into the flat
    // int[] GrassColor/FoliageColor expect: index = y*256 + x, value = 0xRRGGBB.
    private int[] loadColormap(String name) {
        File f = new File(name);
        if (!f.isFile()) return null;
        try {
            BufferedImage img = ImageIO.read(f);
            if (img == null || img.getWidth() < 256 || img.getHeight() < 256) {
                System.err.println("[map-color-dump] " + name + " must be at least 256x256");
                return null;
            }
            int[] px = new int[256 * 256];
            for (int y = 0; y < 256; y++)
                for (int x = 0; x < 256; x++)
                    px[y * 256 + x] = img.getRGB(x, y) & 0xFFFFFF;
            System.out.println("[map-color-dump] loaded colormap " + f.getAbsolutePath());
            return px;
        } catch (Exception e) {
            System.err.println("[map-color-dump] failed to read " + name + ": " + e);
            return null;
        }
    }

    // -- shared ---------------------------------------------------------------

    private void write(String file, Map<String, Object> out, String what) {
        try {
            Files.createDirectories(OUTPUT_DIR);
            Path p = OUTPUT_DIR.resolve(file);
            Gson gson = new GsonBuilder().setPrettyPrinting().create();
            Files.writeString(p, gson.toJson(out));
            System.out.println("[map-color-dump] wrote " + p.toAbsolutePath()
                    + " (" + out.size() + " " + what + ")");
        } catch (Exception e) {
            System.err.println("[map-color-dump] failed to write " + file);
            e.printStackTrace();
        }
    }

    private static int shade(int rgb, int mul) {
        int r = ((rgb >> 16) & 0xFF) * mul / 255;
        int g = ((rgb >> 8) & 0xFF) * mul / 255;
        int b = (rgb & 0xFF) * mul / 255;
        return (r << 16) | (g << 8) | b;
    }
}
