"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { scan } = require("../src/scanner");
const { buildTree, groupRoutes, findings, matchRoute } = require("../src/tree");
const { FORMATS } = require("../src/exporters");
const { checkAll, checkable, findServer, isLocal, send } = require("../src/http");
const { createTranslator, resolveLanguage } = require("../src/i18n");

const route = (value, extra = {}) => ({
  path: value,
  methods: [],
  kind: "page",
  source: "Flask",
  conflicts: [],
  file: "a.py",
  line: 0,
  locations: [{ file: "a.py", line: 0, methods: [] }],
  ...extra,
});

function shape(nodes) {
  return nodes.map((node) => (node.children.length ? { [node.label]: shape(node.children) } : node.label));
}

test("everything below /admin hangs under /admin", () => {
  const nodes = buildTree(["/admin", "/admin/users", "/admin/users/:id", "/admin/users/:id/edit", "/admin/users/new", "/admin/logs"].map((item) => route(item)));
  assert.deepEqual(shape(nodes), [{ "/admin": ["/logs", { "/users": ["/new", { "/:id": ["/edit"] }] }] }]);
  assert.equal(nodes[0].route.path, "/admin");
});

test("empty folders fold together and the home page comes first", () => {
  const nodes = buildTree(["/zebra", "/api/v1/users", "/api/v1/items", "/"].map((item) => route(item)));
  assert.deepEqual(shape(nodes), ["/", { "/api/v1": ["/items", "/users"] }, "/zebra"]);
  assert.equal(nodes[1].full, "/api/v1");
});

test("routes group by file, framework, method and access", () => {
  const routes = [route("/a", { methods: ["GET", "POST"], protected: true }), route("/b", { methods: ["GET"], source: "Express", locations: [{ file: path.join("r", "b.js"), line: 0, methods: [] }] })];
  const labels = (mode) => groupRoutes(routes, mode, { root: "r" }).map((group) => group.label);
  assert.deepEqual(labels("framework"), ["Express", "Flask"]);
  assert.deepEqual(labels("method"), ["GET", "POST"]);
  assert.deepEqual(labels("access"), ["Protected", "Public"]);
  assert.ok(labels("file").includes("b.js"));
});

test("handlers on the same path and method are reported, GET and POST are not", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-"));
  await fs.writeFile(path.join(root, "a.py"), 'from flask import Flask\n@app.get("/x")\ndef a():\n    pass\n@app.post("/y")\ndef b():\n    pass\n');
  await fs.writeFile(path.join(root, "b.py"), 'from flask import Flask\n@app.get("/x")\ndef c():\n    pass\n@app.get("/y")\ndef d():\n    pass\n');
  const routes = await scan(root);
  assert.deepEqual(findings(routes).filter((item) => item.type === "conflict").map((item) => item.route.path), ["/x"]);
  assert.equal(routes[1].locations.length, 2);
});

test("admin routes without a login check are reported unless one exists elsewhere", () => {
  const paths = (routes) => findings(routes).map((item) => item.route.path);
  assert.deepEqual(paths([route("/admin/open")]), ["/admin/open"]);
  assert.deepEqual(paths([route("/admin/ok", { protected: true })]), []);
  assert.deepEqual(paths([route("/admin/hook", { guardedElsewhere: true })]), []);
  assert.deepEqual(paths([route("/admin/next", { source: "Next.js" })]), []);
  assert.deepEqual(paths([route("/oeffentlich")]), []);
});

test("addresses find their route", () => {
  const routes = [route("/users/new"), route("/users/:id"), route("/docs/:rest*")];
  assert.equal(matchRoute(routes, "/users/new").path, "/users/new");
  assert.equal(matchRoute(routes, "http://localhost:3000/users/7?tab=a").path, "/users/:id");
  assert.equal(matchRoute(routes, "/docs/a/b").path, "/docs/:rest*");
  assert.equal(matchRoute(routes, "/nope"), undefined);
});

test("exports", () => {
  const routes = [route("/items/:id", { methods: ["GET", "DELETE"], protected: true }), route("/", { methods: ["GET"] }), route("/admin", { admin: true })];
  const render = (id) => FORMATS.find((format) => format.id === id).render(routes, { title: "T", baseUrl: "http://x" });
  const api = JSON.parse(render("openapi"));
  assert.deepEqual(Object.keys(api.paths["/items/{id}"]), ["get", "delete"]);
  assert.equal(api.paths["/items/{id}"].get.parameters[0].name, "id");
  assert.match(render("http"), /DELETE \{\{baseUrl\}\}\/items\/\{\{id\}\}/);
  assert.match(render("markdown"), /\| `\/items\/:id` \| GET, DELETE \| yes \| Flask \|/);
  assert.equal(JSON.parse(render("json")).length, 3);
  const sitemap = render("sitemap");
  assert.match(sitemap, /<loc>http:\/\/x<\/loc>/);
  assert.doesNotMatch(sitemap, /items|admin/);
});

test("bulk checks stay away from anything that could change data", () => {
  assert.equal(checkable(route("/a", { methods: ["GET"] })), true);
  assert.equal(checkable(route("/a", { methods: ["POST"] })), false);
  assert.equal(checkable(route("/a/:id", { methods: ["GET"] })), false);
  assert.equal(checkable(route("/logout", { methods: ["GET"] })), false);
  assert.equal(checkable(route("/items/delete", { methods: ["GET"] })), false);
});

test("requests, server detection and checks work against a real server", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${request.headers["x-test"] || ""} ${request.headers["content-type"] || ""} ${body}`.trim());
      if (request.url === "/kaputt") response.writeHead(500);
      else if (request.url === "/weiter") response.writeHead(302, { Location: "/login" });
      else response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await findServer([1, port]), port);
    const answer = await send({ url: `${baseUrl}/x`, method: "POST", body: '{"a":1}', headers: { "X-Test": "ja" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.text, '{"ok":true}');
    assert.equal(seen.at(-1), 'POST /x ja application/json {"a":1}');

    const results = {};
    const routes = ["/fein", "/kaputt", "/weiter", "/logout"].map((item) => route(item, { methods: ["GET"] }));
    await checkAll(routes, baseUrl, { onResult: (item, status) => (results[item.path] = status.status) });
    assert.deepEqual(results, { "/fein": 200, "/kaputt": 500, "/weiter": 302 });
  } finally {
    server.close();
  }
});

test("only this computer counts as local", () => {
  assert.equal(isLocal("http://127.0.0.1:8080"), true);
  assert.equal(isLocal("http://localhost"), true);
  assert.equal(isLocal("https://example.com"), false);
  assert.equal(isLocal("http://127.0.0.1.example.com"), false);
});

test("language follows the setting, then the editor, then the system", () => {
  assert.equal(resolveLanguage("en", "de", "de-DE"), "en");
  assert.equal(resolveLanguage("auto", "en", "de-DE"), "de");
  assert.equal(resolveLanguage("auto", "en", "en-US"), "en");
  assert.equal(createTranslator("de")("{0} routes", 3), "3 Seiten");
  assert.equal(createTranslator("en")("{0} routes", 3), "3 routes");
  assert.equal(createTranslator("de")("/items"), "/items");
});
