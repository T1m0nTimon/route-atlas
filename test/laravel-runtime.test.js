"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { parseLaravelRoutes } = require("../src/laravel-runtime");

test("parses Laravel route:list JSON including methods, middleware and API routes", () => {
  const routes = parseLaravelRoutes(JSON.stringify([
    { domain: null, method: "GET|HEAD", uri: "admin/users/{user}", name: "admin.users.show", action: "App\\Http\\Controllers\\UserController@show", middleware: ["web", "auth"] },
    { domain: null, method: "POST", uri: "api/v1/items", name: "items.store", action: "Closure", middleware: ["api"] },
  ]), "/project");

  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, "/admin/users/:user");
  assert.deepEqual(routes[0].methods, ["GET", "HEAD"]);
  assert.equal(routes[0].protected, true);
  assert.equal(routes[0].source, "Laravel");
  assert.equal(routes[0].name, "admin.users.show");
  assert.equal(routes[0].file, path.join("/project", "routes", "web.php"));
  assert.equal(routes[1].path, "/api/v1/items");
  assert.equal(routes[1].kind, "api");
  assert.deepEqual(routes[1].methods, ["POST"]);
});

test("rejects unexpected route:list JSON shapes", () => {
  assert.throws(() => parseLaravelRoutes('{"routes":[]}', "/project"), /JSON array/);
});

test("a failing runtime command reports why instead of failing silently", async () => {
  const { scanLaravelRuntime } = require("../src/laravel-runtime");
  let reported;
  const result = await scanLaravelRuntime(process.cwd(), { executable: "route-atlas-missing-binary", args: [], onError: (error) => { reported = error; } });
  assert.equal(result, null);
  assert.match(String(reported && reported.message), /ENOENT|not found|nicht gefunden/i);
});
