import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Everything the viewer needs that drawing the tiles computed. Persisted as
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
  biomeSuper?: number; // regions per biome super-tile side (GridLayer tile size)
};

export function indexHtml(meta: MapMeta): string {
  const { maxZoom, minX, minZ, tileSize, spawn } = meta;
  const biomeTile = tileSize * (meta.biomeSuper ?? 1); // GridLayer tile = 1 biome super-tile
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
  @font-face {
    font-family: 'Monocraft';
    src: url('https://cdn.jsdelivr.net/gh/IdreesInc/Monocraft@main/dist/Monocraft-ttf/Monocraft.ttf') format('truetype');
    font-weight: normal;
    font-style: normal;
  }
  html,body,#map{height:100%;margin:0;background:#0b0b0b}
  /* Leaflet sets its own font-family on .leaflet-container, so override both */
  body,.leaflet-container{font-family:'Monocraft',monospace}
  .leaflet-container .leaflet-control-attribution{font-size:smaller;}
  /* keep block-pixels crisp when zoomed past native zoom (no smoothing) */
  .leaflet-tile{image-rendering:pixelated;image-rendering:-moz-crisp-edges;image-rendering:crisp-edges}
  .coord{background:rgba(0,0,0,.6);color:#eee;font-size:12px;line-height:1.4;padding:4px 8px;border-radius:4px}
  /* biome polygons are invisible but must still catch the cursor, though not with a pointer cursor (inherit cursor instead) */
  .biome-region{pointer-events:all;cursor:inherit;}
  /* live player name + coords labels (shown on hover) */
  .player-label{background:rgba(0,0,0,.7);color:#fff;border:0;border-radius:1px;corner-shape:notch;box-shadow:none;font-size:11px;line-height:1.3;padding:2px 6px;white-space:nowrap;text-align:center}
  .player-label:before{display:none}
  .player-label .pl-pos{display:block;opacity:.7;font-size:10px}
  /* live player head icons (Minecraft face from a skin CDN) */
  .player-head{border:2px solid #fff;border-radius:1px;corner-shape:notch;box-shadow:0 0 3px rgba(0,0,0,.7);background:#222;image-rendering:pixelated;image-rendering:crisp-edges}
  .player-head-wrap{background:none;border:0} /* divIcon wrapper around the head <img> */
  /* pixelated spawn marker (inline SVG) — strip Leaflet's default divIcon box */
  .spawn-icon{background:none;border:0;filter:drop-shadow(0 0 1px rgba(0,0,0,.7))}
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
    attribution: 'Rendered with <a href="https://github.com/FreekBes/fmcmapper" target="_blank">fmcmapper</a>',
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
      this._x = null; this._z = null; this._b = '';
      return d;
    },
    pos: function (x, z) { this._x = x; this._z = z; this._render(); },
    biome: function (b) { this._b = b; this._render(); },
    _render: function () {
      if (this._x === null) return;
      var t = this._x + ', ' + this._z;
      if (this._b) t += '   •   ' + this._b;
      this._d.textContent = t;
    }
  });
  var coords = new Coords();
  map.addControl(coords);
  map.on('mousemove', function (e) { var b = toBlock(e.latlng); coords.pos(b.x, b.z); });

  // Biome overlay: invisible interactive polygons that report the biome on hover.
  // Regions are grouped into super-tiles, one GeoJSON each (biomes/<sx>_<sy>.geojson).
  // Pinning a GridLayer to the native zoom with a super-tile-sized tile makes each
  // tile coordinate equal a super-tile, so Leaflet's own tile lifecycle loads the
  // ones in view and unloads (frees) them as you pan. index.json lists which exist.
  function prettyBiome(id) {
    return id.replace(/^[^:]*:/, '').replace(/_/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  }
  var biomeStyle = { stroke: false, fill: true, fillOpacity: 0, fillColor: '#ffffff', className: 'biome-region' };
  function onEachBiome(f, lyr) {
    var name = prettyBiome(f.properties.biome);
    lyr.on('mouseover', function () { coords.biome(name); });
    lyr.on('mouseout', function () { coords.biome(''); });
  }

  var biomeGroup = L.layerGroup().addTo(map);
  var biomeAvail = null; // "tx_ty" -> true (exists on disk)
  var biomeCache = {};   // "tx_ty" -> L.geoJSON (parsed once, re-shown on revisit)
  function showRegion(id) {
    if (biomeCache[id]) {
      if (!biomeGroup.hasLayer(biomeCache[id])) biomeGroup.addLayer(biomeCache[id]);
      return;
    }
    var layer = L.geoJSON(null, { style: biomeStyle, onEachFeature: onEachBiome });
    biomeCache[id] = layer;
    biomeGroup.addLayer(layer);
    fetch('biomes/' + id + '.geojson').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (gj) { if (gj && gj.features) layer.addData(gj); }).catch(function () { /* skip */ });
  }
  function hideRegion(id) {
    if (biomeCache[id] && biomeGroup.hasLayer(biomeCache[id])) biomeGroup.removeLayer(biomeCache[id]);
  }

  // Which biome is at a given map point. A player head sits above the biome
  // polygons and blocks their hover, so the head looks the biome up by position
  // instead — that also works on touch, where there's no hover at all. Coords are
  // the GeoJSON [lng, lat] the loaded features already use (= a LatLng's lng/lat).
  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function biomeAt(latlng) {
    var x = latlng.lng, y = latlng.lat, hit = null;
    for (var id in biomeCache) {
      if (!biomeGroup.hasLayer(biomeCache[id])) continue;
      biomeCache[id].eachLayer(function (sub) {
        if (hit || !sub.feature || sub.feature.geometry.type !== 'MultiPolygon') return;
        var polys = sub.feature.geometry.coordinates; // [ [outer, hole...], ... ]
        for (var p = 0; p < polys.length; p++) {
          if (!pointInRing(x, y, polys[p][0])) continue;
          var inHole = false;
          for (var h = 1; h < polys[p].length; h++) if (pointInRing(x, y, polys[p][h])) { inHole = true; break; }
          if (!inHole) { hit = sub.feature.properties.biome; return; }
        }
      });
      if (hit) break;
    }
    return hit;
  }

  var BiomeGrid = L.GridLayer.extend({
    createTile: function (coords, done) {
      var tile = document.createElement('div'); // invisible placeholder; data lives in biomeGroup
      var id = coords.x + '_' + coords.y;
      if (biomeAvail && biomeAvail[id]) showRegion(id);
      setTimeout(function () { done(null, tile); }, 0);
      return tile;
    }
  });
  // Pinned to the native zoom -> each tile coord is one biome super-tile.
  var biomeGrid = new BiomeGrid({ tileSize: ${biomeTile}, minNativeZoom: MAXZOOM, maxNativeZoom: MAXZOOM, noWrap: true });
  biomeGrid.on('tileunload', function (e) { hideRegion(e.coords.x + '_' + e.coords.y); });
  fetch('biomes/index.json').then(function (r) { return r.ok ? r.json() : []; }).then(function (ids) {
    biomeAvail = {};
    ids.forEach(function (id) { biomeAvail[id] = true; });
    biomeGrid.addTo(map); // start the tile lifecycle once we know what exists
  }).catch(function () { /* no biome data */ });

  // Pixelated disc for the spawn marker, to match the blocky theme. Built from a
  // grid of square cells: cells within rIn are filled, the ring out to rOut is the
  // outline. shape-rendering=crispEdges keeps the steps hard instead of smoothed.
  function pixelDisc(cells, cell, rIn, rOut, fill, edge) {
    var size = cells * cell, mid = cells / 2, rects = '';
    for (var gy = 0; gy < cells; gy++) {
      for (var gx = 0; gx < cells; gx++) {
        var dx = gx + 0.5 - mid, dy = gy + 0.5 - mid, d = Math.sqrt(dx * dx + dy * dy);
        var col = d <= rIn ? fill : (d <= rOut ? edge : null);
        if (col) rects += '<rect x="' + gx * cell + '" y="' + gy * cell + '" width="' + cell + '" height="' + cell + '" fill="' + col + '"/>';
      }
    }
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" shape-rendering="crispEdges">' + rects + '</svg>', size: size };
  }

  if (SPAWN) {
    var c = fromBlock(SPAWN.x, SPAWN.z);
    map.setView(c, ${initialZoom});
    var disc = pixelDisc(5, 3, 1.5, 2.3, '#e33', '#fff'); // 5x5 circle, ~15px
    var spawnIcon = L.divIcon({
      className: 'spawn-icon',
      html: disc.svg,
      iconSize: [disc.size, disc.size],
      iconAnchor: [disc.size / 2, disc.size / 2] // centre on the spawn point
    });
    // Tooltip styled like the player labels: name on top, coords below.
    L.marker(c, { icon: spawnIcon, keyboard: false })
      .addTo(map)
      .bindTooltip('Spawn<span class="pl-pos">' + Math.floor(SPAWN.x) + ', ' + Math.floor(SPAWN.z) + '</span>',
        { direction: 'top', offset: [0, -disc.size / 2], className: 'player-label' });
  } else {
    map.setView([0, 0], 0);
  }

  // ---- live players (optional) --------------------------------------------
  // Connect to the player-tracker WebSocket and show whoever is online. Fully
  // decoupled from the renderer: if no tracker is running, the socket just
  // retries quietly and no markers appear. Defaults to the same origin at
  // /players (the viewer's web server reverse-proxies it to the tracker, so only
  // this one port is exposed); override with ?players=ws://host:port.
  var PLAYERS_WS = new URLSearchParams(location.search).get('players')
    || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/players');

  // Player marker = the player's face from a Minecraft head-avatar CDN (resolved
  // by name, with the hat/overlay layer), used as a Leaflet icon. Swap SKIN_HEAD
  // for a different service; the player name and pixel size are appended.
  var SKIN_HEAD = 'https://minotar.net/helm/';
  // Heads shrink as you zoom out so they don't swamp the map. SKIN_PX is the
  // source resolution requested from the CDN (fixed, so it isn't refetched per
  // zoom); the displayed size scales between HEAD_MIN and HEAD_MAX across the
  // map's zoom range.
  var SKIN_PX = 32;
  var HEAD_MIN = 14, HEAD_MAX = 32;
  function headPx() {
    var lo = map.getMinZoom(), hi = map.getMaxZoom();
    var t = hi > lo ? (map.getZoom() - lo) / (hi - lo) : 1;
    return Math.round(HEAD_MIN + (HEAD_MAX - HEAD_MIN) * Math.max(0, Math.min(1, t)));
  }
  // Minotar serves the default Steve/Alex skin for accounts that haven't set one,
  // so those heads still load. But a name it can't resolve (offline-mode / cracked
  // servers, renamed accounts) 404s — so render the head as an <img> that falls
  // back on error to an inline default Steve face (embedded so it works even if
  // the CDN is unreachable) instead of a broken icon.
  var SKIN_FALLBACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAwUlEQVR4nGIxVhFkYGDgYWNhgIEvv/78+PWHmZuNgYON9dfff2zMTBBRHjaWfwwMLOxsrBn2FhJioixcvH++ff7+8/fHjx9mHjrJODvZk59fgJOdlYGB4fvP3xDTPn78wMTPLxDau2z+EW2I2hWnDUJ7l/HzC0B1MDAwHDh3nYGBwcFIE6KD2VlD+tPPT2v3HpUTEGVnZN50+LCkOO+bz99YWNj/v/38++ePX5ce3/754xc7B9unr7/5uFkBAQAA///NJ08WAN0x1gAAAABJRU5ErkJggg==';
  function headIcon(name) {
    var px = headPx();
    var url = SKIN_HEAD + encodeURIComponent(name) + '/' + SKIN_PX + '.png';
    var html = '<img class="player-head" width="' + px + '" height="' + px + '" src="' + url
      + '" onerror="this.onerror=null;this.src=&quot;' + SKIN_FALLBACK + '&quot;">';
    return L.divIcon({
      className: 'player-head-wrap',
      html: html,
      iconSize: [px, px],
      iconAnchor: [px / 2, px / 2] // centre the head on the position
    });
  }

  // Glide a marker to its new spot. Leaflet's setLatLng is instant, and a CSS
  // transform transition would also animate Leaflet's zoom repositioning (markers
  // would "swim" on zoom), so tween the LatLng with requestAnimationFrame — each
  // frame's setLatLng stays correct under zoom/pan. ~0.8s easeInOutQuad.
  var SLIDE_MS = 400;
  function slideMarker(marker, to) {
    var from = marker.getLatLng();
    var dLat = to.lat - from.lat, dLng = to.lng - from.lng;
    if (!dLat && !dLng) return;
    if (marker._slideRAF) cancelAnimationFrame(marker._slideRAF);
    var t0 = null;
    function step(ts) {
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / SLIDE_MS);
      var e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
      marker.setLatLng([from.lat + dLat * e, from.lng + dLng * e]);
      marker._slideRAF = t < 1 ? requestAnimationFrame(step) : null;
    }
    marker._slideRAF = requestAnimationFrame(step);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // Hover tooltip: the player's name with their coordinates below it.
  function playerLabel(p) {
    return esc(p.name) + '<span class="pl-pos">' + Math.floor(p.x)
      + ', ' + Math.floor(p.y) + ', ' + Math.floor(p.z) + '</span>';
  }

  var playerGroup = L.layerGroup().addTo(map);
  var playerMarkers = {}; // name -> L.marker
  function renderPlayers(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (typeof p.x !== 'number' || typeof p.z !== 'number') continue;
      seen[p.name] = true;
      var ll = fromBlock(p.x, p.z);
      if (playerMarkers[p.name]) {
        slideMarker(playerMarkers[p.name], ll);
        playerMarkers[p.name].setTooltipContent(playerLabel(p));
      } else {
        var m = L.marker(ll, { icon: headIcon(p.name), keyboard: false });
        // Hover the head to reveal the name + coords (tooltip is not permanent).
        m.bindTooltip(playerLabel(p), { direction: 'top', offset: [0, -headPx() / 2], className: 'player-label' });
        // The head covers the biome polygons, so report the biome at its own
        // position. 'click' covers touch, where there's no hover.
        var showBiome = function () { var bn = biomeAt(this.getLatLng()); coords.biome(bn ? prettyBiome(bn) : ''); };
        m.on('mouseover', showBiome);
        m.on('click', showBiome);
        m.on('mouseout', function () { coords.biome(''); });
        m.addTo(playerGroup);
        playerMarkers[p.name] = m;
      }
    }
    for (var name in playerMarkers) {
      if (!seen[name]) { playerGroup.removeLayer(playerMarkers[name]); delete playerMarkers[name]; }
    }
  }

  // Resize every head when the zoom changes (smaller when zoomed out), and keep
  // the hover tooltip sitting just above the now-smaller head.
  map.on('zoomend', function () {
    var off = [0, -headPx() / 2];
    for (var name in playerMarkers) {
      var m = playerMarkers[name];
      m.setIcon(headIcon(name));
      var tt = m.getTooltip();
      if (tt) tt.options.offset = off;
    }
  });

  (function connectPlayers() {
    var ws, opened = false;
    try { ws = new WebSocket(PLAYERS_WS); }
    catch (e) { return; }
    ws.onopen = function () { opened = true; };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg && msg.type === 'players') renderPlayers(msg.players || []);
      } catch (e) { /* ignore malformed */ }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
    ws.onclose = function () {
      // Reconnect only after a connection that actually opened (a transient drop,
      // e.g. the server restarting). If it never opened, there's no tracker —
      // RCON isn't configured — so stop instead of attempting to connect forever.
      if (opened) setTimeout(connectPlayers, 5000);
    };
  })();
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

// Standalone CLI: regenerate index.html from an existing map's meta.json.
//   node build/viewer.js [outDir]   (or OUTPUT_PATH=... node build/viewer.js)
// outDir comes from the positional arg, falling back to env, then a default —
// matching buildtiles.js so both tools take the same inputs.
if (require.main === module) {
  const outDir = process.argv[2] ?? process.env.OUTPUT_PATH ?? './output';
  writeViewer(outDir);
  console.log(`wrote ${join(outDir, 'index.html')} from ${join(outDir, 'meta.json')}`);
}
