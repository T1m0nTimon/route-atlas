"use strict";

const path = require("path");
const { categorize } = require("./categories");

const MAX_FINDINGS = 400;

/**
 * Nodes for areas, routes, source files and security findings. Routes hang below their
 * closest parent route or their area, so /admin/users sits next to /admin.
 */
function buildGraph({ results = [], findings = [], rules = [] }) {
  const nodes = new Map();
  const edges = [];
  const clusters = new Map();
  const node = (id, data) => {
    if (!nodes.has(id)) nodes.set(id, { id, ...data });
    return nodes.get(id);
  };
  const link = (source, target) => source !== target && edges.push({ source, target });
  const fileNode = (root, file, cluster) => {
    const label = path.relative(root, file).split(path.sep).join("/") || path.basename(file);
    return node(`f:${file}`, { label, type: "file", cluster, file, line: 0, findings: 0 });
  };

  for (const { root, name, routes } of results) {
    const prefix = results.length > 1 ? `${name}: ` : "";
    const byPath = new Map(routes.map((route) => [route.path, route]));
    for (const group of categorize(routes, rules)) {
      const cluster = `${prefix}${group.label}`;
      clusters.set(cluster, { id: cluster, label: cluster });
      const hub = node(`c:${root}|${group.id}`, { label: cluster, type: "area", cluster });
      for (const route of group.routes) {
        const id = `r:${root}|${route.path}`;
        node(id, {
          label: route.path, type: "route", cluster, file: route.file, line: route.line,
          methods: route.methods, protected: Boolean(route.protected),
        });
        let parent = route.path;
        do parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
        while (parent !== "/" && !byPath.has(parent));
        // "/" is no parent: otherwise every route would hang below the home page instead of its area.
        link(parent !== "/" && byPath.has(parent) ? `r:${root}|${parent}` : hub.id, id);
        for (const place of route.locations || []) {
          if (place.file && !route.runtime) link(id, fileNode(root, place.file, cluster).id);
        }
      }
    }
  }

  const rootOf = (file) => (results.find(({ root }) => !path.relative(root, file).startsWith("..")) || { root: path.dirname(file) }).root;
  for (const [index, finding] of findings.slice(0, MAX_FINDINGS).entries()) {
    const file = fileNode(rootOf(finding.file), finding.file, "Security");
    file.findings++;
    const id = `s:${index}`;
    node(id, {
      label: `${finding.severity.toUpperCase()} ${finding.title}`, type: "finding", cluster: "Security",
      severity: finding.severity, file: finding.file, line: Math.max(0, finding.line - 1),
    });
    link(file.id, id);
  }
  if (findings.length) clusters.set("Security", { id: "Security", label: "Security" });

  return { nodes: [...nodes.values()], edges, clusters: [...clusters.values()], truncated: Math.max(0, findings.length - MAX_FINDINGS) };
}

/** JSON that is safe inside a <script> tag, even with paths such as "</script>". */
function scriptJson(value) {
  const unsafe = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, "g");
  return JSON.stringify(value).replace(unsafe, (char) => `${String.fromCharCode(92)}u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function graphHtml({ data, labels, nonce, scriptUri, cspSource }) {
  return `<!doctype html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}
canvas{position:absolute;inset:0;width:100%;height:100%;cursor:grab}canvas.dragging{cursor:grabbing}
aside{position:absolute;top:12px;right:12px;bottom:12px;width:220px;overflow:auto;padding:14px;border-radius:8px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);box-sizing:border-box}
h1{font-size:14px;margin:0 0 4px}h2{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin:16px 0 6px}
.row{display:flex;justify-content:space-between;align-items:center;margin:4px 0}.pill{padding:1px 8px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}button{font:inherit;padding:5px 6px;border:0;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}button.wide{grid-column:span 2}button[aria-pressed=true]{outline:2px solid var(--vscode-focusBorder)}
input[type=search]{width:100%;box-sizing:border-box;padding:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px}
.legend{display:flex;flex-wrap:wrap;gap:6px}.legend button{background:none;color:inherit;padding:2px 4px;display:flex;gap:4px;align-items:center}.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.legend button.off{opacity:.35}kbd{font:inherit;padding:0 3px;border:1px solid var(--vscode-panel-border);border-radius:3px}small{color:var(--vscode-descriptionForeground);display:block;margin:3px 0}
#tip{position:absolute;pointer-events:none;padding:6px 8px;border-radius:4px;background:var(--vscode-editorHoverWidget-background);border:1px solid var(--vscode-editorHoverWidget-border);display:none;max-width:420px;white-space:pre-wrap}
</style></head><body>
<canvas id="graph" aria-label="${labels.graph}"></canvas><div id="tip" role="tooltip"></div>
<aside>
<h1>Route Atlas</h1><small id="project"></small>
<h2>${labels.properties}</h2>
<div class="row">${labels.nodes}<span class="pill" id="nodeCount"></span></div>
<div class="row">${labels.edges}<span class="pill" id="edgeCount"></span></div>
<div class="row">${labels.charge}<span class="pill" id="charge"></span></div>
<div class="grid">
<button id="labels" class="wide" aria-pressed="false">${labels.toggleLabels}</button>
<button id="forceDown">− ${labels.force}</button><button id="forceUp">+ ${labels.force}</button>
<button id="zoomOut">− Zoom</button><button id="zoomIn">+ Zoom</button>
<button id="fit" class="wide">${labels.fit}</button>
<button id="heat" class="wide" aria-pressed="false">${labels.heatmap}</button>
<button id="ai" class="wide">${labels.aiPrompt}</button>
</div>
<h2>${labels.search}</h2><input id="search" type="search" placeholder="${labels.searchNodes}" aria-label="${labels.searchNodes}">
<h2>${labels.clusters}</h2><div class="legend" id="legend"></div>
<h2>${labels.shortcuts}</h2>
<small><kbd>⇧</kbd>+<kbd>S</kbd> ${labels.select}</small><small><kbd>⇧</kbd>+<kbd>R</kbd> ${labels.reset}</small><small><kbd>⇧</kbd>+<kbd>F</kbd> ${labels.fade}</small><small>${labels.doubleClick}</small>
</aside>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
}

module.exports = { buildGraph, graphHtml, scriptJson };
