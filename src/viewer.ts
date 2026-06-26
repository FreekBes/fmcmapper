import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Everything the viewer needs that the tile build computed. Persisted as
// meta.json next to the tiles so index.html can be regenerated on its own.
export type MapMeta = {
  maxZoom: number; // highest native zoom level (one native pixel == one block)
  minX: number; // world block X of native pixel column 0
  minZ: number; // world block Z of native pixel row 0
  tileSize: number; // Leaflet tileSize (px); one base tile == one region (512)
  spawn: { x: number; z: number } | null;
  dimension?: string;
  // Minecraft version the world reports (from level.dat), and the version this
  // renderer's block list / color tables were built for. A mismatch means the
  // colors may be stale.
  version?: { name: string | null; dataVersion: number | null } | null;
  targetVersion?: { name: string; dataVersion: number };
};

export function indexHtml(meta: MapMeta): string {
  const { maxZoom, minX, minZ, tileSize, spawn } = meta;
  const initialZoom = Math.max(0, maxZoom - 2);
  const title = meta.dimension ? `${meta.dimension} map` : 'Dimension map';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{height:100%;margin:0;background:#0b0b0b}
  /* keep block-pixels crisp when zoomed past native zoom (no smoothing) */
  .leaflet-tile{image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges}
  .coord{background:rgba(0,0,0,.6);color:#eee;font:12px/1.4 monospace;padding:4px 8px;border-radius:4px}
</style>
</head>
<body>
<div id="map"></div>
<script>
  var MAXZOOM = ${maxZoom};
  var MINX = ${minX};     // world block X of native pixel column 0
  var MINZ = ${minZ};     // world block Z of native pixel row 0
  var SPAWN = ${spawn ? JSON.stringify(spawn) : 'null'};

  var map = L.map('map', { crs: L.CRS.Simple, minZoom: 0, maxZoom: MAXZOOM + 2 });

  L.tileLayer('tiles/{z}/{x}/{y}.png', {
    tileSize: ${tileSize},
    minZoom: 0,
    maxZoom: MAXZOOM + 2,    // a couple of upscaled over-zoom steps
    maxNativeZoom: MAXZOOM,
    minNativeZoom: 0,
    noWrap: true
  }).addTo(map);

  // latlng -> Minecraft block coords (native pixel == world block at MAXZOOM)
  function toBlock(latlng) {
    var p = map.project(latlng, MAXZOOM);
    return { x: Math.floor(MINX + p.x), z: Math.floor(MINZ + p.y) };
  }
  // Minecraft block coords -> latlng
  function fromBlock(x, z) {
    return map.unproject(L.point(x - MINX, z - MINZ), MAXZOOM);
  }

  var Coords = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      var d = L.DomUtil.create('div', 'coord');
      d.textContent = 'move the cursor';
      this._d = d;
      return d;
    },
    set: function (x, z) { this._d.textContent = 'X ' + x + '   Z ' + z; }
  });
  var coords = new Coords();
  map.addControl(coords);
  map.on('mousemove', function (e) { var b = toBlock(e.latlng); coords.set(b.x, b.z); });

  if (SPAWN) {
    var c = fromBlock(SPAWN.x, SPAWN.z);
    map.setView(c, ${initialZoom});
    L.circleMarker(c, { radius: 5, weight: 2, color: '#fff', fillColor: '#e33', fillOpacity: 1 })
      .addTo(map)
      .bindTooltip('Spawn (' + SPAWN.x + ', ' + SPAWN.z + ')');
  } else {
    map.setView([0, 0], 0);
  }
</script>
</body>
</html>
`;
}

// Write index.html into outDir. Uses the passed meta, or reads outDir/meta.json.
export function writeViewer(outDir: string, meta?: MapMeta): void {
  const m = meta ?? (JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8')) as MapMeta);
  writeFileSync(join(outDir, 'index.html'), indexHtml(m));
}

// Standalone CLI: regenerate index.html from an existing tile build's meta.json.
//   node dist/viewer.js [outDir]
if (require.main === module) {
  const [outDir = 'tiles_out'] = process.argv.slice(2);
  writeViewer(outDir);
  console.error(`wrote ${join(outDir, 'index.html')} from ${join(outDir, 'meta.json')}`);
}
