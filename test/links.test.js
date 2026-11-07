"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { extractLinks, brokenLinks, scanLinks, suggest } = require("../src/links");

const route = (value, methods = []) => ({ path: value, methods, kind: "page", source: "Next.js", conflicts: [], file: "x", line: 0, locations: [] });
const ROUTES = ["/", "/about", "/users/:id", "/users/:id/edit", "/api/items", "/docs/:slug*"].map((item) => route(item));

test("links are found in JSX, templates, calls and markdown", () => {
  const text = [
    'import Link from "next/link";',
    '<Link href="/about">About</Link>',
    "<a href={`/users/${user.id}`}>Profile</a>",
    'const data = await fetch("/api/items?page=2");',
    "router.push('/users/7/edit');",
    'axios.post("/api/items", body);',
    'window.location.href = "/login";',
    "// <a href=\"/commented\">",
    'app.get("/defined-route", handler);',
    '"/just/a/string".replace("/a", "");',
    '<img src="/logo.png">',
    "fetch('/user/' + name + '/popup');",
    'const nav = [{ title: "Docs", href: "/docs" }];',
  ].join("\n");
  const links = extractLinks(text, ".tsx");
  assert.deepEqual(
    links.map((link) => link.path),
    ["/about", "/users/x", "/api/items", "/users/7/edit", "/api/items", "/login", "/docs"],
  );
  assert.deepEqual({ line: links[0].line, column: links[0].column, length: links[0].length }, { line: 1, column: 12, length: 6 });
  assert.deepEqual(extractLinks("See [the docs](/docs/start) and `href=\"/code\"`\n```\n[x](/inside-code)\n```", ".md").map((link) => link.path), ["/docs/start"]);
  assert.deepEqual(extractLinks('<a href="/a">\n<!-- <a href="/hidden"> -->\n<form action="/b">', ".html").map((link) => link.path), ["/a", "/b"]);
  assert.deepEqual(extractLinks('return redirect("/dashboard")\nRedirectResponse(url="/home")', ".py").map((link) => link.path), ["/dashboard", "/home"]);
});

test("only links that no route answers are broken", () => {
  const links = extractLinks(
    [
      '<a href="/about">',
      '<a href="/abuot">',
      '<a href="/users/42">',
      '<a href="/docs/guide/intro">',
      '<a href="/favicon.ico">',
      "<a href={`/usres/${id}`}>",
      '<a href="/api/itemz">',
      '<a href="/about/#team">',
    ].join("\n"),
    ".jsx",
  );
  const broken = brokenLinks(ROUTES, links);
  assert.deepEqual(broken.map((link) => link.path), ["/abuot", "/usres/x", "/api/itemz"]);
  assert.deepEqual(broken[0].suggestion, { path: "/about", replacement: "/about" });
  assert.deepEqual(broken[1].suggestion, { path: "/users/:id", replacement: "/users/x" });
  assert.deepEqual(brokenLinks(ROUTES, links, { ignore: ["^/api/", "("] }).map((link) => link.path), ["/abuot", "/usres/x"]);
  assert.deepEqual(brokenLinks([], links), []);
});

test("catch-all routes and static sites", () => {
  const links = extractLinks('<a href="/anything/at/all">\n<a href="/about.html">\n<a href="/missing.html">', ".html");
  assert.deepEqual(brokenLinks([route("/*")], links), []);
  assert.deepEqual(brokenLinks([route("/about.html")], links).map((link) => link.path), ["/anything/at/all", "/missing.html"]);
  assert.equal(suggest(ROUTES, "/completely-different-and-long"), undefined);
});

test("the whole project is searched, tests are skipped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-atlas-links-"));
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "nav.tsx"), '<a href="/about">\n<a href="/contakt">');
    await fs.writeFile(path.join(root, "tests", "nav.tsx"), '<a href="/nope">');
    const found = await scanLinks(root, [route("/about"), route("/contact")]);
    assert.equal(found.length, 1);
    assert.equal(path.basename(found[0].file), "nav.tsx");
    assert.equal(found[0].line, 1);
    assert.equal(found[0].suggestion.path, "/contact");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
