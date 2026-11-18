"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { toAiPrompt, redact } = require("../src/ai-report");
const { buildGraph, graphHtml, scriptJson } = require("../src/graph");
const { scanSecurity } = require("../src/security");
const { main } = require("../bin/route-atlas");

const SECRET = "sk_live_9f8e7d6c5b4a3210";

async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-ai-"));
  const lines = [`const api_key = "${SECRET}";`];
  for (let index = 0; index < 120; index++) lines.push(`el${index}.innerHTML = input${index};`, "// padding line", "// padding line");
  await fs.writeFile(path.join(root, "app.js"), lines.join("\n"));
  await fs.writeFile(path.join(root, ".env"), "DB_PASSWORD=hunter2hunter2\nDEBUG=true\n");
  return root;
}

test("secrets never reach the prompt", () => {
  assert.equal(redact(`password = "${SECRET}"`), 'password = "***"');
  assert.equal(redact("TOKEN=abc123", "/p/.env.local"), "TOKEN=***");
  assert.equal(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAB12\n-----END RSA PRIVATE KEY-----"), "-----BEGIN RSA PRIVATE KEY-----\n***\n***\n-----END RSA PRIVATE KEY-----");
  assert.equal(redact("x = eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0abcdef"), "x = ***");
});

test("the AI prompt is split into self-contained parts below the size limit", async () => {
  const root = await project();
  const findings = await scanSecurity(root);
  const parts = await toAiPrompt({ title: "demo", root, findings, maxChars: 6000 });
  assert.ok(parts.length > 1);
  const all = parts.join("\n");
  for (const part of parts) {
    assert.ok(part.length <= 6000, `part has ${part.length} characters`);
    assert.match(part, /Security-Review: demo \(Teil \d+ von \d+\)/);
    assert.match(part, /Antwortformat/);
  }
  const ids = all.match(/^### S\d+/gm);
  assert.equal(ids.length, findings.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!all.includes(SECRET) && !all.includes("hunter2"));
  assert.match(all, /`app\.js:1`/);
  assert.match(parts[0], /S1 · CRITICAL/);
});

test("an empty scan still gives a usable prompt", async () => {
  const [part] = await toAiPrompt({ title: "leer", findings: [] });
  assert.match(part, /keine Muster gefunden/);
});

test("the command line writes the prompt into numbered files", async () => {
  const root = await project();
  const out = path.join(root, "prompt.md");
  const result = await main(["ai", root, "--max-chars", "6000", "-o", out]);
  assert.equal(result.code, 0);
  assert.ok(result.quiet);
  assert.match(await fs.readFile(out, "utf8"), /Security-Review/);
  assert.match(await fs.readFile(path.join(root, "prompt.part-2.md"), "utf8"), /Teil 2 von/);
  await assert.rejects(main(["ai", root, "--max-chars", "10"]), /at least 4000/);
});

test("the graph links routes to their parent, area and file, and findings to files", () => {
  const route = (value, file) => ({ path: value, methods: ["GET"], kind: "page", file, line: 0, locations: [{ file, line: 0, methods: ["GET"] }] });
  const root = path.join(path.sep, "p");
  const file = path.join(root, "admin.py");
  const graph = buildGraph({
    results: [{ root, name: "p", routes: [route("/admin", file), route("/admin/users/:id", file), route("/", path.join(root, "home.py"))] }],
    findings: [{ severity: "high", title: "Eval", file, line: 3 }],
  });
  const has = (source, target) => graph.edges.some((edge) => edge.source === source && edge.target === target);
  assert.ok(has(`r:${root}|/admin`, `r:${root}|/admin/users/:id`));
  assert.ok(has(`c:${root}|admin`, `r:${root}|/admin`), "areas, not the home page, hold top-level routes");
  assert.ok(has(`r:${root}|/admin`, `f:${file}`));
  assert.ok(has(`f:${file}`, "s:0"));
  assert.equal(graph.nodes.find((node) => node.id === `f:${file}`).findings, 1);
  assert.equal(graph.nodes.find((node) => node.id === "s:0").line, 2);
  assert.ok(graph.clusters.some((cluster) => cluster.id === "Admin"));
  assert.ok(graph.clusters.some((cluster) => cluster.id === "Security"));
});

test("route names cannot break out of the graph page", () => {
  assert.ok(!scriptJson({ label: "</script><script>alert(1)</script>" }).includes("</script>"));
  const html = graphHtml({ data: { nodes: [{ label: "</script>" }] }, labels: new Proxy({}, { get: () => "x" }), nonce: "n", scriptUri: "u", cspSource: "c" });
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.match(html, /script-src 'nonce-n'/);
});
