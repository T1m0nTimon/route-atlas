"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const BIN = path.join(__dirname, "..", "bin", "route-atlas.js");
let root;

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-cli-"));
  await fs.writeFile(path.join(root, "package.json"), '{"dependencies":{"express":"4"}}');
  await fs.writeFile(
    path.join(root, "server.js"),
    [
      'const app = require("express")();',
      'app.get("/", (req, res) => res.send("<a href=\\"/abuot\\">x</a>"));',
      'app.get("/about", (req, res) => res.redirect("/"));',
      'app.get("/broken", (req, res) => res.sendStatus(500));',
      'app.post("/api/items/:id", (req, res) => res.json({}));',
    ].join("\n"),
  );
  await fs.writeFile(path.join(root, "page.html"), '<a href="/abuot">About</a>\n<a href="/about">About</a>');
});

after(() => fs.rm(root, { recursive: true, force: true }));

test("lists routes as a table and as JSON", async () => {
  const table = await run(root);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /GET\s+\/about\s+Express\s+server\.js:3/);
  assert.match(table.stdout, /4 routes/);
  const json = JSON.parse((await run("list", root, "--json")).stdout);
  assert.deepEqual(json.find((item) => item.path === "/api/items/:id"), {
    path: "/api/items/:id",
    methods: ["POST"],
    kind: "page",
    source: "Express",
    protected: false,
    file: "server.js",
    line: 5,
  });
});

test("exports to stdout and to a file", async () => {
  const openapi = JSON.parse((await run("export", "openapi", root, "--base-url", "http://example.test")).stdout);
  assert.equal(openapi.servers[0].url, "http://example.test");
  assert.ok(openapi.paths["/api/items/{id}"].post);
  const out = path.join(root, "routes.gen.ts");
  const written = await run("export", "typescript", root, "-o", out);
  assert.equal(written.code, 0);
  assert.match(await fs.readFile(out, "utf8"), /apiItemsById: \(params: \{ id: Param \}\)/);
  assert.equal((await run("export", "nope", root)).code, 2);
});

test("lint reports broken links and fails", async () => {
  const result = await run("lint", root);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /page\.html:1:10 {2}broken-link {2}No route answers \/abuot, did you mean \/about\?/);
  const ignored = await run("lint", root, "--ignore-link", "^/abuot$", "--json");
  assert.equal(ignored.code, 0);
  assert.deepEqual(JSON.parse(ignored.stdout), []);
});

test("check calls the server and fails on errors", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/broken" ? 500 : 200);
    response.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await run("check", root, "--base-url", baseUrl, "--json");
    const report = JSON.parse(result.stdout);
    assert.equal(result.code, 1);
    assert.equal(report.checked, 3);
    assert.deepEqual(report.results.filter((item) => item.failed).map((item) => item.path), ["/broken"]);
    assert.equal((await run("check", root, "--base-url", baseUrl, "--fail-on", "600")).code, 0);
  } finally {
    server.close();
  }
});

test("bad usage exits with 2", async () => {
  assert.equal((await run("--nope")).code, 2);
  assert.equal((await run(path.join(root, "missing"))).code, 2);
  assert.equal((await run("--header", "broken", "check", root)).code, 2);
  const help = await run("--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /route-atlas lint/);
});
