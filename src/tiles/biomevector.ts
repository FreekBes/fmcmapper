// Turn a labelled raster (biome id per cell) into simplified GeoJSON polygons,
// one MultiPolygon per biome. Dependency-free: boundary-edge stitching to trace
// rings, hole grouping by containment, and Ramer–Douglas–Peucker simplification.
//
// Coordinates produced here are in the Leaflet CRS.Simple space the viewer uses:
//   lng = (blockX - minX) / 2^maxZoom
//   lat = -(blockZ - minZ) / 2^maxZoom

type Pt = [number, number];
type Ring = Pt[]; // closed: first point repeated at the end

const NONE = 0xffff;

// --- geometry helpers -------------------------------------------------------

function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
}

function pointInRing(pt: Pt, r: Ring): boolean {
  let inside = false;
  const x = pt[0], y = pt[1];
  for (let i = 0, j = r.length - 2; i < r.length - 1; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// RDP on a closed ring. Anchors the first point and the point farthest from it
// so the loop doesn't collapse, then simplifies both arcs.
function simplifyRing(ring: Ring, tol: number): Ring {
  const n = ring.length - 1; // drop the repeated closing point
  if (n < 4) return ring;
  const open = ring.slice(0, n);

  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (open[i][0] - open[0][0]) ** 2 + (open[i][1] - open[0][1]) ** 2;
    if (d > farD) { farD = d; far = i; }
  }

  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const tol2 = tol * tol;
  const rdp = (s: number, e: number): void => {
    // walk indices s..e inclusive (wrapping handled by caller via index list)
    const stack: [number, number][] = [[s, e]];
    while (stack.length) {
      const seg = stack.pop()!;
      const a = open[seg[0] % n], b = open[seg[1] % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      let dmax = 0, idx = -1;
      for (let i = seg[0] + 1; i < seg[1]; i++) {
        const p = open[i % n];
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        const cx = a[0] + t * dx, cy = a[1] + t * dy;
        const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > tol2 && idx > 0) { keep[idx % n] = 1; stack.push([seg[0], idx], [idx, seg[1]]); }
    }
  };
  rdp(0, far);
  rdp(far, n); // arc from `far` back around to index n (== 0)

  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(open[i]);
  out.push(out[0]);
  return out;
}

// --- boundary tracing -------------------------------------------------------

// Trace closed boundary loops of cells where inside(x,y) is true, within the
// half-open box [x0,x1) x [y0,y1). Returns rings in cell-corner coordinates.
function traceLoops(
  inside: (x: number, y: number) => boolean,
  x0: number, y0: number, x1: number, y1: number,
): Ring[] {
  const cols = x1 - x0 + 1; // vertex columns
  const key = (vx: number, vy: number): number => (vy - y0) * cols + (vx - x0);
  const vx = (k: number): number => (k % cols) + x0;
  const vy = (k: number): number => Math.floor(k / cols) + y0;

  // Directed boundary edges, walked so the inside cell is on the right; this
  // keeps each cell's outside-facing sides consistent so loops stitch up.
  const edges = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const s = key(ax, ay);
    const arr = edges.get(s);
    if (arr) arr.push(key(bx, by));
    else edges.set(s, [key(bx, by)]);
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);         // top
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom
      if (!inside(x - 1, y)) add(x, y + 1, x, y);         // left
    }
  }

  const loops: Ring[] = [];
  for (const startKey of edges.keys()) {
    let arr = edges.get(startKey)!;
    while (arr.length) {
      const seq: number[] = [startKey];
      let v = arr.pop()!;
      seq.push(v);
      let guard = 0;
      while (v !== startKey) {
        const out = edges.get(v);
        if (!out || out.length === 0) break; // shouldn't happen on a closed boundary
        v = out.pop()!;
        seq.push(v);
        if (++guard > 50_000_000) break;
      }
      if (seq.length >= 4 && seq[seq.length - 1] === startKey) {
        loops.push(seq.map((k): Pt => [vx(k), vy(k)]));
      }
      arr = edges.get(startKey)!;
    }
  }
  return loops;
}

// Group rings of one label into polygons: outer rings + their contained holes.
function ringsToPolygons(rings: Ring[]): Ring[][] {
  if (rings.length === 0) return [];
  const areas = rings.map(signedArea);
  let maxAbs = -1, outerSign = 1;
  for (let i = 0; i < rings.length; i++) {
    if (Math.abs(areas[i]) > maxAbs) { maxAbs = Math.abs(areas[i]); outerSign = Math.sign(areas[i]) || 1; }
  }
  const polys: Ring[][] = [];
  const outerIdx: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    if (Math.sign(areas[i]) === outerSign) { outerIdx.push(i); polys.push([rings[i]]); }
  }
  for (let i = 0; i < rings.length; i++) {
    if (Math.sign(areas[i]) === outerSign) continue; // not a hole
    let best = -1, bestArea = Infinity;
    for (let o = 0; o < outerIdx.length; o++) {
      const oi = outerIdx[o];
      if (pointInRing(rings[i][0], rings[oi]) && Math.abs(areas[oi]) < bestArea) {
        bestArea = Math.abs(areas[oi]); best = o;
      }
    }
    if (best >= 0) polys[best].push(rings[i]);
  }
  return polys;
}

// --- public API -------------------------------------------------------------

export type BiomeField = {
  grid: Uint16Array; // width*height, biome id per cell, NONE for empty
  width: number;
  height: number;
  res: number;       // blocks per cell
  minBlockX: number; // world block X of cell column 0
  minBlockZ: number; // world block Z of cell row 0
  palette: string[]; // id -> biome name
};

export type GeoJSON = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { biome: string };
    geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  }[];
};

// Build the biome GeoJSON in the viewer's CRS.Simple coordinate space.
export function buildBiomeGeoJSON(
  field: BiomeField,
  minX: number, minZ: number, maxZoom: number,
  tolCells: number,
): GeoJSON {
  const { grid, width, height, res, minBlockX, minBlockZ, palette } = field;
  const scale = 2 ** maxZoom;
  // cell-corner (cx,cy) -> [lng, lat]
  const toCoord = (p: Pt): number[] => {
    const blockX = minBlockX + p[0] * res;
    const blockZ = minBlockZ + p[1] * res;
    return [(blockX - minX) / scale, -(blockZ - minZ) / scale];
  };

  // Bounding box per biome id so we only trace where it occurs.
  const bbox = new Map<number, [number, number, number, number]>(); // id -> [x0,y0,x1,y1]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = grid[y * width + x];
      if (id === NONE) continue;
      const b = bbox.get(id);
      if (!b) bbox.set(id, [x, y, x + 1, y + 1]);
      else { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x + 1 > b[2]) b[2] = x + 1; if (y + 1 > b[3]) b[3] = y + 1; }
    }
  }

  const features: GeoJSON['features'] = [];
  for (const [id, b] of bbox) {
    const inside = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < width && y < height && grid[y * width + x] === id;
    const rings = traceLoops(inside, b[0], b[1], b[2], b[3]).map(r => simplifyRing(r, tolCells));
    const polys = ringsToPolygons(rings);
    if (polys.length === 0) continue;
    features.push({
      type: 'Feature',
      properties: { biome: palette[id] },
      geometry: { type: 'MultiPolygon', coordinates: polys.map(poly => poly.map(ring => ring.map(toCoord))) },
    });
  }
  return { type: 'FeatureCollection', features };
}

export const BIOME_NONE = NONE;
