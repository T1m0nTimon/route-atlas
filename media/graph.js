// Force-directed route graph for the Route Atlas webview. No libraries, so it works offline.
(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  const tip = document.getElementById("tip");
  const $ = (id) => document.getElementById(id);
  const PALETTE = ["#4e9af1", "#f28e2c", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#edc949", "#ff9da7", "#9c755f", "#bab0ab", "#a0cbe8", "#8cd17d"];
  const SEVERITY = { critical: "#ff2d55", high: "#e15759", medium: "#f2b134", low: "#9aa0a6" };

  let nodes = [], edges = [], byId = new Map(), neighbors = new Map(), colors = new Map();
  let view = { x: 0, y: 0, k: 1 }, charge = -300, alpha = 1;
  let showLabels = false, heat = false, fade = false, query = "";
  let hovered = null, dragged = null, panning = null, hiddenClusters = new Set(), hullCluster = null;
  const selected = new Set();
  const state = vscode.getState() || {};

  function load(data) {
    const old = new Map(nodes.map((node) => [node.id, node]));
    nodes = data.nodes.map((node, index) => {
      const before = old.get(node.id);
      const angle = index * 2.399;
      const distance = 30 * Math.sqrt(index + 1);
      return { ...node, x: before ? before.x : Math.cos(angle) * distance, y: before ? before.y : Math.sin(angle) * distance, vx: 0, vy: 0 };
    });
    byId = new Map(nodes.map((node) => [node.id, node]));
    edges = data.edges.map((edge) => ({ source: byId.get(edge.source), target: byId.get(edge.target) })).filter((edge) => edge.source && edge.target);
    neighbors = new Map(nodes.map((node) => [node, new Set()]));
    for (const { source, target } of edges) {
      neighbors.get(source).add(target);
      neighbors.get(target).add(source);
    }
    for (const node of nodes) {
      const degree = neighbors.get(node).size;
      node.r = node.type === "area" ? 9 + Math.sqrt(degree) * 2.4 : node.type === "finding" ? 4 : 3.5 + Math.sqrt(degree) * 1.6;
    }
    colors = new Map(data.clusters.map((cluster, index) => [cluster.id, cluster.id === "Security" ? SEVERITY.high : PALETTE[index % PALETTE.length]]));
    $("project").textContent = data.title + (data.truncated ? ` · +${data.truncated} …` : "");
    $("nodeCount").textContent = nodes.length;
    $("edgeCount").textContent = edges.length;
    renderLegend(data.clusters);
    alpha = 1;
  }

  function renderLegend(clusters) {
    const legend = $("legend");
    legend.textContent = "";
    for (const cluster of clusters) {
      const button = document.createElement("button");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = colors.get(cluster.id);
      button.append(dot, document.createTextNode(cluster.label));
      button.title = cluster.label;
      button.classList.toggle("off", hiddenClusters.has(cluster.id));
      button.onmouseenter = () => { hullCluster = cluster.id; };
      button.onmouseleave = () => { hullCluster = null; };
      button.onclick = () => {
        if (!hiddenClusters.delete(cluster.id)) hiddenClusters.add(cluster.id);
        button.classList.toggle("off");
      };
      legend.append(button);
    }
  }

  /* ------------------------------------------------------------ Simulation */

  function tick() {
    const cell = 140;
    const grid = new Map();
    const visible = nodes.filter((node) => !hiddenClusters.has(node.cluster));
    for (const node of visible) {
      const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(node);
    }
    // shortcut: repulsion only between neighbouring grid cells; upgrade to Barnes-Hut if graphs get much larger.
    for (const node of visible) {
      const cx = Math.floor(node.x / cell), cy = Math.floor(node.y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (other === node) continue;
          let x = node.x - other.x, y = node.y - other.y;
          let d2 = x * x + y * y;
          if (d2 === 0) { x = Math.random() - 0.5; y = Math.random() - 0.5; d2 = 0.5; }
          const force = (-charge * alpha) / d2;
          node.vx += x * force * 0.5;
          node.vy += y * force * 0.5;
        }
      }
    }
    for (const { source, target } of edges) {
      const x = target.x - source.x, y = target.y - source.y;
      const distance = Math.sqrt(x * x + y * y) || 1;
      const strength = ((distance - (source.r + target.r + 30)) / distance) * 0.08 * alpha;
      target.vx -= x * strength; target.vy -= y * strength;
      source.vx += x * strength; source.vy += y * strength;
    }
    for (const node of visible) {
      node.vx -= node.x * 0.002 * alpha;
      node.vy -= node.y * 0.002 * alpha;
      if (node === dragged) continue;
      node.vx *= 0.6; node.vy *= 0.6;
      node.x += Math.max(-40, Math.min(40, node.vx));
      node.y += Math.max(-40, Math.min(40, node.vy));
    }
    alpha = Math.max(0, alpha - 0.006);
  }

  /* --------------------------------------------------------------- Drawing */

  function theme(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function matches(node) {
    return query && node.label.toLowerCase().includes(query);
  }

  function dimmed(node) {
    if (query) return !matches(node);
    if (hovered) return node !== hovered && !neighbors.get(hovered).has(node);
    if (fade && selected.size) return !selected.has(node) && ![...selected].some((item) => neighbors.get(item).has(node));
    return false;
  }

  function color(node) {
    if (node.type === "finding") return SEVERITY[node.severity] || SEVERITY.medium;
    if (heat) return node.findings ? `hsl(0, 85%, ${Math.max(35, 70 - node.findings * 8)}%)` : "#5f6368";
    return colors.get(node.cluster) || "#888";
  }

  function hull(points) {
    if (points.length < 3) return points;
    points = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const point of points) {
      while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    for (const point of points.reverse()) {
      while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== width * ratio) { canvas.width = width * ratio; canvas.height = height * ratio; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2 + view.x, height / 2 + view.y);
    ctx.scale(view.k, view.k);
    const shown = (node) => !hiddenClusters.has(node.cluster);

    if (hullCluster) {
      const points = hull(nodes.filter((node) => node.cluster === hullCluster && shown(node)));
      if (points.length > 2) {
        ctx.beginPath();
        points.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
        ctx.closePath();
        ctx.fillStyle = colors.get(hullCluster) + "22";
        ctx.strokeStyle = colors.get(hullCluster);
        ctx.lineWidth = 2 / view.k;
        ctx.fill(); ctx.stroke();
      }
    }

    ctx.lineWidth = 1 / view.k;
    for (const { source, target } of edges) {
      if (!shown(source) || !shown(target)) continue;
      ctx.globalAlpha = dimmed(source) && dimmed(target) ? 0.06 : 0.45;
      ctx.strokeStyle = color(source);
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(target.x, target.y); ctx.stroke();
    }
    const text = theme("--vscode-foreground", "#ccc");
    ctx.font = `${11 / view.k}px ${theme("--vscode-font-family", "sans-serif")}`;
    for (const node of nodes) {
      if (!shown(node)) continue;
      const faded = dimmed(node);
      ctx.globalAlpha = faded ? 0.15 : 1;
      ctx.fillStyle = color(node);
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2); ctx.fill();
      if (selected.has(node) || matches(node) || node.protected) {
        ctx.strokeStyle = node.protected && !selected.has(node) ? "#59a14f" : text;
        ctx.lineWidth = 2 / view.k;
        ctx.stroke();
      }
      const label = showLabels || node.type === "area" || node === hovered || selected.has(node) || matches(node) || view.k > 2.2;
      if (label && !faded) {
        ctx.fillStyle = text;
        ctx.fillText(node.label.length > 60 ? `${node.label.slice(0, 57)}…` : node.label, node.x + node.r + 3, node.y + 4 / view.k);
      }
    }
    ctx.globalAlpha = 1;
  }

  let autoFit = true, ticks = 0;
  function frame() {
    if (alpha > 0) {
      tick();
      // Follow the layout while it unfolds, until the user takes over the view.
      if (autoFit && ++ticks % 8 === 0) fit();
    }
    draw();
    requestAnimationFrame(frame);
  }

  /* ----------------------------------------------------------- Interaction */

  function toGraph(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - rect.width / 2 - view.x) / view.k, y: (event.clientY - rect.top - rect.height / 2 - view.y) / view.k };
  }

  function nodeAt(event) {
    const point = toGraph(event);
    let best = null, bestDistance = Infinity;
    for (const node of nodes) {
      if (hiddenClusters.has(node.cluster)) continue;
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance < node.r + 4 / view.k && distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best;
  }

  function zoom(factor, event) {
    autoFit = false;
    const rect = canvas.getBoundingClientRect();
    const mx = event ? event.clientX - rect.left - rect.width / 2 : 0;
    const my = event ? event.clientY - rect.top - rect.height / 2 : 0;
    const k = Math.min(8, Math.max(0.05, view.k * factor));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
  }

  function fit() {
    const visible = nodes.filter((node) => !hiddenClusters.has(node.cluster));
    if (!visible.length) return;
    const xs = visible.map((node) => node.x), ys = visible.map((node) => node.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // The sidebar covers 250px on the right; on narrow panels the graph uses the full width under it.
    const sidebar = canvas.clientWidth > 600 ? 250 : 0;
    const width = canvas.clientWidth - sidebar, height = canvas.clientHeight;
    view.k = Math.min(4, 0.9 * Math.min(width / (maxX - minX + 60), height / (maxY - minY + 60)));
    view.x = -((minX + maxX) / 2) * view.k - sidebar / 2;
    view.y = -((minY + maxY) / 2) * view.k;
  }

  canvas.addEventListener("wheel", (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event); }, { passive: false });
  canvas.addEventListener("mousedown", (event) => {
    dragged = nodeAt(event);
    if (dragged) alpha = Math.max(alpha, 0.3);
    else panning = { x: event.clientX - view.x, y: event.clientY - view.y };
    autoFit = false;
    canvas.classList.add("dragging");
  });
  window.addEventListener("mouseup", () => { dragged = null; panning = null; canvas.classList.remove("dragging"); });
  canvas.addEventListener("mousemove", (event) => {
    if (dragged) {
      Object.assign(dragged, toGraph(event), { vx: 0, vy: 0 });
      alpha = Math.max(alpha, 0.1);
      return;
    }
    if (panning) { view.x = event.clientX - panning.x; view.y = event.clientY - panning.y; return; }
    hovered = nodeAt(event);
    tip.style.display = hovered ? "block" : "none";
    if (hovered) {
      const methods = hovered.methods && hovered.methods.length ? `${hovered.methods.join(", ")} ` : "";
      tip.textContent = `${methods}${hovered.label}\n${hovered.cluster}${hovered.findings ? ` · ${hovered.findings} ⚠` : ""}${hovered.protected ? " · 🔒" : ""}`;
      tip.style.left = `${event.clientX + 14}px`;
      tip.style.top = `${event.clientY + 14}px`;
    }
  });
  canvas.addEventListener("mouseleave", () => { hovered = null; tip.style.display = "none"; });
  canvas.addEventListener("click", (event) => {
    const node = nodeAt(event);
    if (node && !selected.delete(node)) selected.add(node);
  });
  canvas.addEventListener("dblclick", (event) => {
    const node = nodeAt(event);
    if (node && node.file) vscode.postMessage({ type: "open", id: node.id });
  });
  window.addEventListener("keydown", (event) => {
    if (!event.shiftKey || event.target === $("search")) return;
    const key = event.key.toLowerCase();
    if (key === "s" && hovered && !selected.delete(hovered)) selected.add(hovered);
    if (key === "r") { selected.clear(); fade = false; }
    if (key === "f") fade = !fade;
  });

  const press = (button, value) => button.setAttribute("aria-pressed", String(value));
  $("labels").onclick = () => press($("labels"), (showLabels = !showLabels));
  $("heat").onclick = () => press($("heat"), (heat = !heat));
  const setCharge = (value) => { charge = Math.max(-2000, Math.min(-50, value)); $("charge").textContent = charge; alpha = 0.6; vscode.setState({ ...state, charge }); };
  $("forceDown").onclick = () => setCharge(charge + 100);
  $("forceUp").onclick = () => setCharge(charge - 100);
  $("zoomIn").onclick = () => zoom(1.3);
  $("zoomOut").onclick = () => zoom(1 / 1.3);
  $("fit").onclick = fit;
  $("ai").onclick = () => vscode.postMessage({ type: "aiPrompt" });
  $("search").addEventListener("input", (event) => { query = event.target.value.trim().toLowerCase(); });
  $("search").addEventListener("keydown", (event) => {
    const first = event.key === "Enter" && nodes.find(matches);
    if (first) { autoFit = false; view.x = -first.x * view.k - (canvas.clientWidth > 600 ? 125 : 0); view.y = -first.y * view.k; }
  });
  window.addEventListener("message", (event) => { if (event.data && event.data.type === "data") load(event.data.data); });

  load(JSON.parse(document.getElementById("data").textContent));
  requestAnimationFrame(() => vscode.postMessage({ type: "rendered", nodes: nodes.length }));
  setCharge(state.charge || charge);
  alpha = 1;
  frame();
})();
