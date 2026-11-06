"use strict";

const { categorize } = require("./categories");

function methodsOf(route) {
  return route.methods.length ? route.methods.filter((method) => method !== "WS" && method !== "ALL") : ["GET"];
}

function toMarkdown(routes, { title, rules = [] }) {
  const lines = [`# ${title}`, ""];
  for (const group of categorize(routes, rules)) {
    lines.push(`## ${group.label}`, "", "| Path | Methods | Protected | Source |", "| --- | --- | --- | --- |");
    for (const route of group.routes) {
      lines.push(`| \`${route.path}\` | ${route.methods.join(", ") || "-"} | ${route.protected ? "yes" : ""} | ${route.source} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function toJson(routes) {
  const plain = routes.map(({ path, methods, kind, source, protected: guarded }) => ({ path, methods, kind, source, protected: Boolean(guarded) }));
  return JSON.stringify(plain, null, 2);
}

function toOpenApi(routes, { title, baseUrl }) {
  const paths = {};
  for (const route of routes) {
    const parameters = (route.path.match(/:\w+/g) || []).map((name) => ({
      name: name.slice(1),
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const key = route.path.replace(/:(\w+)\*?/g, "{$1}");
    paths[key] = {};
    for (const method of methodsOf(route)) {
      paths[key][method.toLowerCase()] = {
        summary: route.path,
        ...(parameters.length ? { parameters } : {}),
        responses: { default: { description: "Response" } },
      };
    }
  }
  return JSON.stringify({ openapi: "3.0.3", info: { title, version: "1.0.0" }, servers: [{ url: baseUrl }], paths }, null, 2);
}

function toHttpFile(routes, { baseUrl }) {
  const lines = [`@baseUrl = ${baseUrl}`, ""];
  for (const route of routes) {
    for (const method of methodsOf(route)) {
      lines.push(`### ${route.path}`, `${method} {{baseUrl}}${route.path.replace(/:(\w+)\*?/g, "{{$1}}")}`, "");
    }
  }
  return lines.join("\n");
}

function toSitemap(routes, { baseUrl }) {
  const pages = routes.filter((route) => route.kind === "page" && !route.protected && !route.path.includes(":") && !route.admin);
  const urls = pages.map((route) => `  <url><loc>${baseUrl}${route.path === "/" ? "" : route.path}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>", ""].join("\n");
}

const FORMATS = [
  { id: "markdown", label: "Markdown", language: "markdown", render: toMarkdown },
  { id: "openapi", label: "OpenAPI 3", language: "json", render: toOpenApi },
  { id: "http", label: ".http", language: "http", render: toHttpFile },
  { id: "json", label: "JSON", language: "json", render: toJson },
  { id: "sitemap", label: "sitemap.xml", language: "xml", render: toSitemap },
];

module.exports = { FORMATS };
