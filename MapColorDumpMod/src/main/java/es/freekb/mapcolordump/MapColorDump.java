package es.freekb.mapcolordump;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.MapColor;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Dumps the vanilla map color of every block (default block state) to
 * map_colors.json in the run directory. Runs once when the server starts
 * (works for both a dedicated server and an opened single-player world).
 *
 * Output per block:
 *   "minecraft:stone": {
 *     "mapColorId": 11,        // index into the map-color palette
 *     "baseRGB": 9474192,      // packed 0xRRGGBB of the base color
 *     "baseHex": "#909090",
 *     "shades": [6697932, 8158332, 9474192, 5000268]  // x180/220/255/135 /255
 *   }
 */
public class MapColorDump implements ModInitializer {

    // The four brightness multipliers the map item applies (then / 255).
    // Index meaning on real maps: 0 = block is lower than the one to its
    // north, 1 = same height, 2 = higher, 3 = (only via external tools).
    private static final int[] MULTIPLIERS = { 180, 220, 255, 135 };

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> dump());
    }

    private void dump() {
        Map<String, Object> out = new LinkedHashMap<>();

        for (Block block : BuiltInRegistries.BLOCK) {
            Identifier key = BuiltInRegistries.BLOCK.getKey(block);
            BlockState state = block.defaultBlockState();

            MapColor mc;
            try {
                // Most blocks ignore the level/pos; EmptyBlockGetter is enough.
                mc = state.getMapColor(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
            } catch (Exception e) {
                mc = null;
            }

            Map<String, Object> entry = new LinkedHashMap<>();
            if (mc == null || mc == MapColor.NONE) {
                // NONE => block isn't drawn on the map (e.g. air, glass, foliage cutouts)
                entry.put("mapColorId", 0);
                entry.put("baseRGB", 0);
                entry.put("baseHex", "#000000");
                entry.put("shades", new int[] { 0, 0, 0, 0 });
            } else {
                int rgb = mc.col & 0xFFFFFF; // packed base color
                int[] shades = new int[4];
                for (int i = 0; i < 4; i++) shades[i] = shade(rgb, MULTIPLIERS[i]);
                entry.put("mapColorId", mc.id);
                entry.put("baseRGB", rgb);
                entry.put("baseHex", String.format("#%06X", rgb));
                entry.put("shades", shades);
            }
            out.put(key.toString(), entry);
        }

        try {
            Path p = Path.of("map_colors.json");
            Gson gson = new GsonBuilder().setPrettyPrinting().create();
            Files.writeString(p, gson.toJson(out));
            System.out.println("[map-color-dump] wrote " + p.toAbsolutePath()
                    + " (" + out.size() + " blocks)");
        } catch (Exception e) {
            System.err.println("[map-color-dump] failed to write map_colors.json");
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
