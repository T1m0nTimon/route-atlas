"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { scan } = require("../src/scanner");
const { categorize } = require("../src/categories");

async function project(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}

async function paths(files) {
  return (await scan(await project(files))).map((route) => route.path);
}

const dependsOn = (name) => JSON.stringify({ dependencies: { [name]: "1" } });

test("flask blueprints keep their prefix, also from another file", async () => {
  const routes = await scan(
    await project({
      "app/__init__.py": 'from flask import Flask\nfrom .api import api_bp\napp = Flask(__name__)\napp.register_blueprint(api_bp, url_prefix="/api/v1")\n',
      "app/api.py": 'from flask import Blueprint\napi_bp = Blueprint("api", __name__)\n@api_bp.get("/users/<int:id>")\ndef user(id):\n    pass\n',
      "app/auth.py": 'from flask import Blueprint\nbp = Blueprint("auth", __name__, url_prefix="/auth")\n@bp.route("/login", methods=["GET", "POST"])\ndef login():\n    pass\n',
      "app/admin.py": 'from flask import Blueprint\nbp = Blueprint("x", __name__)\n@bp.get("/einstellungen")\n@admin_required\ndef s():\n    pass\n',
    }),
  );
  assert.deepEqual(routes.map((route) => route.path), ["/api/v1/users/:id", "/auth/login", "/einstellungen"]);
  assert.deepEqual(routes[1].methods, ["GET", "POST"]);
  assert.equal(routes[2].admin, true);
  assert.equal(routes[2].protected, true);
});

test("a blueprint imported from a package keeps its prefix", async () => {
  assert.deepEqual(
    await paths({
      "app/routes/__init__.py": 'from flask import Blueprint\nbp = Blueprint("main", __name__, url_prefix="/intern")\n',
      "app/routes/items.py": 'from app.routes import bp\n@bp.get("/items")\ndef items():\n    pass\n',
    }),
    ["/intern/items"],
  );
});

test("fastapi routers are joined with include_router", async () => {
  assert.deepEqual(
    await paths({
      "main.py": 'from fastapi import FastAPI\nfrom routers import users\napp = FastAPI()\napp.include_router(users.router, prefix="/api")\n',
      "routers/users.py": 'from fastapi import APIRouter\nrouter = APIRouter(prefix="/users")\n@router.get("/{user_id}")\ndef one(user_id):\n    pass\n',
    }),
    ["/api/users/:user_id"],
  );
});

test("django follows include", async () => {
  assert.deepEqual(
    await paths({
      "site/urls.py": 'urlpatterns = [path("admin/", admin.site.urls), path("blog/", include("blog.urls"))]\n',
      "blog/urls.py": 'urlpatterns = [path("<int:pk>/", views.post)]\n',
    }),
    ["/admin", "/blog/:pk"],
  );
});

test("express mounts routers and ignores http clients", async () => {
  assert.deepEqual(
    await paths({
      "server.js": 'const users = require("./routes/users");\napp.use("/api", users);\napp.get("/", (req, res) => {});\napp.get("view engine");\naxios.get("/nope", {});\n',
      "routes/users.js": 'router.get("/users/:id", handler);\n// router.get("/alt", handler);\n',
    }),
    ["/", "/api/users/:id"],
  );
});

test("next.js app and pages router", async () => {
  const routes = await scan(
    await project({
      "package.json": dependsOn("next"),
      "app/page.tsx": "",
      "app/(shop)/produkte/[id]/page.tsx": "",
      "app/api/users/route.ts": "export async function GET() {}\nexport function POST() {}\n",
      "app/_private/page.tsx": "",
      "pages/alt/[...slug].tsx": "",
    }),
  );
  assert.deepEqual(routes.map((route) => route.path), ["/", "/alt/:slug*", "/api/users", "/produkte/:id"]);
  assert.deepEqual(routes[2].methods, ["GET", "POST"]);
  assert.equal(routes[2].kind, "api");
});

test("sveltekit, nuxt and astro", async () => {
  assert.deepEqual(
    await paths({
      "web/package.json": dependsOn("@sveltejs/kit"),
      "web/src/routes/+page.svelte": "",
      "web/src/routes/(app)/konto/+page.svelte": "",
      "nuxt/package.json": dependsOn("nuxt"),
      "nuxt/pages/preise.vue": "",
      "nuxt/server/api/ping.get.ts": "",
      "astro/package.json": dependsOn("astro"),
      "astro/src/pages/blog/[slug].astro": "",
    }),
    ["/", "/api/ping", "/blog/:slug", "/konto", "/preise"],
  );
});

test("laravel, rails, spring, asp.net, go and axum", async () => {
  assert.deepEqual(
    await paths({
      "routes/web.php": "<?php\nRoute::prefix('admin')->group(function () {\n  Route::get('/nutzer', [A::class, 'x']);\n});\n",
      "config/routes.rb": "Rails.application.routes.draw do\n  namespace :intern do\n    resources :posts\n  end\n  get '/hilfe', to: 'a#b'\nend\n",
      "Api.java": '@RestController\n@RequestMapping("/java")\npublic class Api {\n  @GetMapping("/eins")\n  String a() {}\n}\n',
      "Dotnet.cs": '[Route("api/[controller]")]\npublic class WerteController {\n  [HttpGet("{id}")]\n  public void A() {}\n}\n',
      "main.go": 'r.GET("/go/eins", h)\nmux.HandleFunc("POST /go/zwei", h)\n',
      "main.rs": 'Router::new().route("/rust", get(h).post(i));\n',
    }),
    ["/admin/nutzer", "/api/werte/:id", "/go/eins", "/go/zwei", "/hilfe", "/intern/posts", "/intern/posts/:id", "/java/eins", "/rust"],
  );
});

test("client routers", async () => {
  assert.deepEqual(
    await paths({
      "src/router.ts": 'import { createRouter } from "vue-router";\nconst routes = [{ path: "/start" }, { path: "/:pathMatch(.*)*" }];\n',
      "src/App.jsx": 'import { Route } from "react-router-dom";\nconst a = <Route path="/hilfe" element={<A />} />;\n',
    }),
    ["/hilfe", "/start"],
  );
});

test("plain sites list their files, frameworks hide their templates", async () => {
  assert.deepEqual(await paths({ "index.html": "", "ueber/index.html": "", "kontakt.php": "<?php", "templates/teil.html": "" }), ["/", "/kontakt.php", "/ueber"]);
  assert.deepEqual(await paths({ "app.py": 'from flask import Flask\n@app.get("/x")\ndef x():\n    pass\n', "index.html": "" }), ["/x"]);
});

test("tests and dependencies are not searched", async () => {
  assert.deepEqual(
    await paths({
      "app.py": 'from flask import Flask\n@app.get("/echt")\ndef x():\n    pass\n',
      "tests/test_a.py": '@app.get("/test")\ndef x():\n    pass\n',
      "node_modules/x/index.js": 'app.get("/modul", h);\n',
      ".venv/lib/x.py": '@app.get("/venv")\ndef x():\n    pass\n',
    }),
    ["/echt"],
  );
});

test("categories", () => {
  const route = (route, extra = {}) => ({ path: route, methods: [], kind: "page", ...extra });
  const groups = categorize([
    route("/"),
    route("/admin/nutzer"),
    route("/de/admin"),
    route("/:lang/admin/x"),
    route("/api/v1/items"),
    route("/login"),
    route("/konto"),
    route("/impressum"),
    route("/health"),
    route("/blog"),
    route("/blog/:slug"),
    route("/preise"),
    route("/einstellung", { admin: true }),
    route("/rechnen", { kind: "api" }),
    route("/shop/x"),
  ], [{ label: "Laden", pattern: "^/shop" }]);
  const by = Object.fromEntries(groups.map((group) => [group.label, group.routes.map((item) => item.path)]));
  assert.deepEqual(by.Admin, ["/admin/nutzer", "/de/admin", "/:lang/admin/x", "/einstellung"]);
  assert.deepEqual(by.API, ["/api/v1/items", "/rechnen"]);
  assert.deepEqual(by["/blog"], ["/blog", "/blog/:slug"]);
  assert.deepEqual(by.Pages, ["/", "/preise"]);
  assert.deepEqual(by.Laden, ["/shop/x"]);
  assert.equal(groups[0].label, "Laden");
});

test("a broken custom pattern does not stop the sorting", () => {
  assert.equal(categorize([{ path: "/x", methods: [], kind: "page" }], [{ label: "Kaputt", pattern: "(" }])[0].label, "Pages");
});
