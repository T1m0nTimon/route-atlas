"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { toCurl, toFetch, toAxios, toHttpie } = require("../src/snippets");
const { toTypeScript, routeName } = require("../src/typed");
const { FORMATS } = require("../src/exporters");

const request = { method: "POST", url: "http://127.0.0.1:3000/api/items", headers: { Authorization: "Bearer t'k" }, body: '{"name":"Tim"}' };

test("requests become cURL, fetch, Axios and HTTPie snippets", () => {
  assert.equal(
    toCurl(request),
    [
      "curl \\",
      "  -X POST \\",
      "  'http://127.0.0.1:3000/api/items' \\",
      "  -H 'Authorization: Bearer t'\\''k' \\",
      "  -H 'Content-Type: application/json' \\",
      `  --data-raw '{"name":"Tim"}'`,
    ].join("\n"),
  );
  assert.equal(toCurl({ url: "http://x/a" }), "curl \\\n  'http://x/a'");
  assert.equal(toFetch({ url: "http://x/a" }), 'const response = await fetch("http://x/a");\nconst data = await response.json();');
  const fetchCode = toFetch(request);
  assert.match(fetchCode, /method: "POST"/);
  assert.match(fetchCode, /"Content-Type": "application\/json"/);
  assert.match(fetchCode, /body: JSON.stringify\(\{\n {4}"name": "Tim"\n {2}\}\)/);
  const axiosCode = toAxios(request);
  assert.match(axiosCode, /method: "post"/);
  assert.match(axiosCode, /data: \{\n {4}"name": "Tim"\n {2}\}/);
  assert.match(toAxios({ ...request, body: "plain" }), /data: "plain"/);
  assert.equal(toHttpie({ url: "http://x/a", headers: { A: "1" } }), "http GET 'http://x/a' 'A:1'");
  assert.equal(toHttpie(request).startsWith(`echo '{"name":"Tim"}' | http POST`), true);
});

test("route names are readable and unique", () => {
  assert.equal(routeName("/"), "home");
  assert.equal(routeName("/users/:id/edit"), "usersByIdEdit");
  assert.equal(routeName("/api/v1/user-settings"), "apiV1UserSettings");
  assert.equal(routeName("/404"), "_404");
  const code = toTypeScript(["/a-b", "/a_b"].map((item) => ({ path: item, methods: [], source: "Flask" })));
  assert.match(code, /aB: \(\) => "\/a-b"/);
  assert.match(code, /aB2: \(\) => "\/a_b"/);
  assert.ok(FORMATS.some((format) => format.id === "typescript"));
});

test("generated helpers build the right addresses", { skip: !process.features.typescript && "this Node.js cannot run TypeScript" }, async () => {
  const routes = ["/", "/users/:id/edit", "/docs/:slug*", "/:rest*", "/api/items"].map((item) => ({ path: item, methods: ["GET"], source: "Next.js" }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-ts-"));
  try {
    const file = path.join(dir, "routes.ts");
    await fs.writeFile(file, toTypeScript(routes));
    const { routes: helpers, href } = await import(pathToFileURL(file).href);
    assert.equal(helpers.home(), "/");
    assert.equal(helpers.usersByIdEdit({ id: "a b" }), "/users/a%20b/edit");
    assert.equal(helpers.docsBySlug({ slug: ["x", "y z"] }), "/docs/x/y%20z");
    assert.equal(helpers.docsBySlug({ slug: "x/y" }), "/docs/x/y");
    assert.equal(helpers.docsBySlug(), "/docs");
    assert.equal(helpers.byRest(), "/");
    assert.equal(href("usersByIdEdit", { id: 7 }), "/users/7/edit");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
