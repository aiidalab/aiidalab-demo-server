const AIIDA_PALETTE = [
  "#0096DE", // blue
  "#FF7D17", // orange
  "#30B808", // green
];

const NODE_SIZE = {
  "#0096DE": { halo: 4.0, core: 3.0 },
  "#FF7D17": { halo: 5.0, core: 4.0 },
  "#30B808": { halo: 6.0, core: 5.0 },
};

const TAU = Math.PI * 2;

const EDGE_ALPHA = 0.2;
const CORE_ALPHA = 0.5;
const HALO_ALPHA = 0.3;

const MIN_DT = 8;
const MAX_DT = 24;
const PAD_EXTRA = 40;

const MAIN_COLUMN_PX = 1200;

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 30, g: 60, b: 120 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const RGB = Object.fromEntries(AIIDA_PALETTE.map((h) => [h, hexToRgb(h)]));
const rgba = (hex, a) => {
  const c = RGB[hex] || { r: 30, g: 60, b: 120 };
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
};

const clusterParams = (size) => {
  const clusterSize = size < 0.6 ? "small" : size < 0.9 ? "medium" : "large";
  switch (clusterSize) {
    case "small":
      return {
        r: rand(100, 150),
        n: randInt(4, 8),
        branches: randInt(2, 3),
        spread: 1.4,
        minSep: 14,
      };
    case "medium":
      return {
        r: rand(150, 200),
        n: randInt(8, 12),
        branches: randInt(3, 5),
        spread: 1.0,
        minSep: 16,
      };
    case "large":
      return {
        r: rand(200, 250),
        n: randInt(12, 16),
        branches: randInt(5, 7),
        spread: 0.7,
        minSep: 18,
      };
  }
};

function clusterFade(c, t) {
  const age = t - c.bornAt;
  if (age <= 0 || age >= c.lifeMs) return 0;
  if (age < c.fadeInMs) return age / c.fadeInMs;
  if (age > c.lifeMs - c.fadeOutMs) return (c.lifeMs - age) / c.fadeOutMs;
  return 1;
}

function pickColorDifferentFrom(excludeColor) {
  if (!excludeColor) return pick(AIIDA_PALETTE);
  const choices = AIIDA_PALETTE.filter((c) => c !== excludeColor);
  return choices.length ? pick(choices) : pick(AIIDA_PALETTE);
}

function pickPointOutsideMainColumn(w, h, mainWidthPx) {
  const x0 = (w - mainWidthPx) / 2;
  const x1 = x0 + mainWidthPx;

  // If the viewport is too narrow to have gutters, just spawn anywhere.
  if (x0 <= 0 || x1 >= w) {
    return { x: rand(0, w), y: rand(0, h) };
  }

  const leftW = x0;
  const rightW = w - x1;
  const inLeft = Math.random() < leftW / (leftW + rightW);
  const x = inLeft ? rand(0, x0) : rand(x1, w);
  const y = rand(0, h);
  return { x, y };
}

function pickSeparatedClusterOrigin(
  w,
  h,
  mainWidthPx,
  r,
  clusters,
  excludeIdx,
) {
  const maxTries = 60;

  for (let tries = 0; tries < maxTries; tries++) {
    const p = pickPointOutsideMainColumn(w, h, mainWidthPx);
    let ok = true;

    const sepFactor = tries < 15 ? 0.95 : tries < 35 ? 0.8 : 0.65;
    for (let i = 0; i < clusters.length; i++) {
      if (i === excludeIdx) continue;
      const c = clusters[i];
      if (!c) continue;
      const dx = p.x - c.cx;
      const dy = p.y - c.cy;
      const minSep = sepFactor * (r + c.r) + 24;
      if (dx * dx + dy * dy < minSep * minSep) {
        ok = false;
        break;
      }
    }

    if (ok) return p;
  }

  return pickPointOutsideMainColumn(w, h, mainWidthPx);
}

(() => {
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  )?.matches;
  if (reduceMotion) return;

  const canvas = document.createElement("canvas");
  canvas.id = "bg-graph-canvas";
  document.body.prepend(canvas);

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const state = {
    w: 0,
    h: 0,
    dpr: 1,
    clusters: [],
    prevT: null,
  };

  function resize() {
    state.w = window.innerWidth;
    state.h = window.innerHeight;
    state.dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.floor(state.w * state.dpr);
    canvas.height = Math.floor(state.h * state.dpr);
    canvas.style.width = `${state.w}px`;
    canvas.style.height = `${state.h}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  function makeCluster(now, speed, excludeIdx = -1) {
    const size = Math.random();
    const params = clusterParams(size);
    const { r, n } = params;

    const { x: cx, y: cy } = pickSeparatedClusterOrigin(
      state.w,
      state.h,
      MAIN_COLUMN_PX,
      r,
      state.clusters,
      excludeIdx,
    );

    const vx = 0;
    const vy = (Math.random() < 0.5 ? -1 : 1) * speed;

    const nodes = Array.from({ length: n }, () => {
      return {
        // offsets + original offsets
        ox: 0,
        oy: 0,
        ox0: 0,
        oy0: 0,
        // jitter velocity
        jx: rand(-0.01, 0.01),
        jy: rand(-0.01, 0.01),
        // construction fields
        depth: 0,
        parent: -1,
        angle: 0,
        dist: 0,
        // render fields
        color: null,
        halo: 0,
        core: 0,
      };
    });

    const edges = [];
    const edgeSet = new Set();
    const addEdge = (i, j) => {
      if (i === j) return;
      const a = Math.min(i, j),
        b = Math.max(i, j);
      const key = `${a}-${b}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push([a, b]);
    };

    const stepMin = r * 0.14;
    const stepMax = r * 0.26;
    const rootAngle = rand(0, TAU);

    const minSep2 = params.minSep * params.minSep;
    const isFarEnough = (ox, oy, placedCount) => {
      for (let i = 0; i < placedCount; i++) {
        const q = nodes[i];
        const dx = ox - q.ox0;
        const dy = oy - q.oy0;
        if (dx * dx + dy * dy < minSep2) return false;
      }
      return true;
    };

    const assignPos = (p, placedCount) => {
      for (let tries = 0; tries < 14; tries++) {
        const ox = Math.cos(p.angle) * p.dist + rand(-2.0, 2.0);
        const oy = Math.sin(p.angle) * p.dist + rand(-2.0, 2.0);
        if (isFarEnough(ox, oy, placedCount)) {
          p.ox0 = p.ox = ox;
          p.oy0 = p.oy = oy;
          return;
        }
        p.angle += rand(-0.18, 0.18);
        p.dist = clamp(p.dist + rand(-8, 10), 0, r * 0.98);
      }
      p.ox0 = p.ox = Math.cos(p.angle) * p.dist;
      p.oy0 = p.oy = Math.sin(p.angle) * p.dist;
    };

    // root
    nodes[0].depth = 0;
    nodes[0].parent = -1;
    nodes[0].angle = rootAngle;
    nodes[0].dist = 0;
    assignPos(nodes[0], 0);

    // main branches
    const branchCount = Math.min(n - 1, params.branches);
    for (let i = 1; i <= branchCount; i++) {
      const p = nodes[i];
      p.parent = 0;
      p.depth = 1;
      const base = (TAU * (i - 1)) / Math.max(1, branchCount);
      p.angle = rootAngle + base + rand(-0.25, 0.25);
      p.dist = rand(stepMin, stepMax);
      assignPos(p, i);
      addEdge(i, 0);
    }

    const pickParent = (maxExclusive) => {
      let total = 0;
      for (let i = 0; i < maxExclusive; i++)
        total += 1 / (1 + nodes[i].depth * 0.9);
      let u = Math.random() * total;
      for (let i = 0; i < maxExclusive; i++) {
        const w = 1 / (1 + nodes[i].depth * 0.9);
        if (u < w) return i;
        u -= w;
      }
      return 0;
    };

    for (let i = branchCount + 1; i < n; i++) {
      const p = nodes[i];

      let parent = 0;
      let angle = rootAngle;
      let dist = 0;

      for (let tries = 0; tries < 8; tries++) {
        parent = pickParent(i);
        const pp = nodes[parent];
        const spread = params.spread / (1 + pp.depth * 0.35);
        angle = pp.angle + rand(-spread, spread);
        dist = pp.dist + rand(stepMin, stepMax);
        if (dist <= r * 0.98) break;
      }

      p.parent = parent;
      p.depth = nodes[parent].depth + 1;
      p.angle = angle;
      p.dist = Math.min(dist, r * 0.98);
      assignPos(p, i);
      addEdge(i, parent);
    }

    // Assign colors so adjacent nodes always differ.
    // The generated graph is a tree (parent-child edges), so a simple parent-aware
    // assignment is sufficient and deterministic.
    nodes[0].color = pick(AIIDA_PALETTE);
    ({ halo: nodes[0].halo, core: nodes[0].core } = NODE_SIZE[nodes[0].color]);
    for (let i = 1; i < n; i++) {
      const parentColor = nodes[nodes[i].parent]?.color;
      nodes[i].color = pickColorDifferentFrom(parentColor);
      ({ halo: nodes[i].halo, core: nodes[i].core } =
        NODE_SIZE[nodes[i].color]);
    }

    for (const p of nodes) {
      delete p.depth;
      delete p.parent;
      delete p.angle;
      delete p.dist;
    }

    return {
      bornAt: now,
      lifeMs: rand(15000, 25000),
      fadeInMs: rand(700, 1300),
      fadeOutMs: rand(900, 1500),
      cx,
      cy,
      r,
      vx,
      vy,
      nodes,
      edges,
    };
  }

  function init() {
    resize();
    state.prevT = null;
    state.clusters = [];

    const speed = rand(0.001, 0.005);
    const gutterArea = Math.max(0, state.w - MAIN_COLUMN_PX) * state.h;
    const clusterCount = clamp(gutterArea / 40000, 3, 20);

    const now = performance.now();
    for (let i = 0; i < clusterCount; i++) {
      // Build up a roughly uniform distribution by considering the already
      // placed cluster centers during placement.
      state.clusters.push(makeCluster(now, speed));
    }
  }

  function step(t) {
    if (state.prevT === null) state.prevT = t;
    const dt = clamp(t - state.prevT, MIN_DT, MAX_DT);
    state.prevT = t;

    ctx.clearRect(0, 0, state.w, state.h);

    for (let k = 0; k < state.clusters.length; k++) {
      const c = state.clusters[k];
      const fade = clusterFade(c, t);
      if (fade <= 0) {
        // Respawn with separation to avoid visible clumping over time.
        state.clusters[k] = makeCluster(t, Math.hypot(c.vx, c.vy), k);
        continue;
      }

      c.cx += c.vx * dt;
      c.cy += c.vy * dt;

      const pad = c.r + PAD_EXTRA;
      if (c.cx < -pad) c.cx = state.w + pad;
      else if (c.cx > state.w + pad) c.cx = -pad;
      if (c.cy < -pad) c.cy = state.h + pad;
      else if (c.cy > state.h + pad) c.cy = -pad;

      const jitterDamp = Math.pow(0.985, dt);
      for (const p of c.nodes) {
        p.ox += p.jx * dt;
        p.oy += p.jy * dt;

        p.ox += (p.ox0 - p.ox) * 0.0022 * dt;
        p.oy += (p.oy0 - p.oy) * 0.0022 * dt;

        p.jx *= jitterDamp;
        p.jy *= jitterDamp;
      }

      // edges
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(180,180,180,${EDGE_ALPHA * fade})`;
      ctx.beginPath();
      const r2 = c.r * c.r * 0.75;
      for (const [i, j] of c.edges) {
        const a = c.nodes[i],
          b = c.nodes[j];
        const ax = c.cx + a.ox,
          ay = c.cy + a.oy;
        const bx = c.cx + b.ox,
          by = c.cy + b.oy;
        const dx = ax - bx,
          dy = ay - by;
        if (dx * dx + dy * dy < r2) {
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
      }
      ctx.stroke();

      // nodes
      for (const p of c.nodes) {
        const x = c.cx + p.ox;
        const y = c.cy + p.oy;
        ctx.fillStyle = rgba(p.color, HALO_ALPHA * fade);
        ctx.beginPath();
        ctx.arc(x, y, p.halo, 0, TAU);
        ctx.fill();

        ctx.fillStyle = rgba(p.color, CORE_ALPHA * fade);
        ctx.beginPath();
        ctx.arc(x, y, p.core, 0, TAU);
        ctx.fill();
      }
    }

    requestAnimationFrame(step);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  init();
  requestAnimationFrame(step);
})();
