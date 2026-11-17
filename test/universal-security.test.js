"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { languageForFile, summarizeLanguages } = require("../src/languages");
const { scanText } = require("../src/security");

test("recognizes a broad range of languages and project manifests", () => {
  assert.equal(languageForFile("src/main.rs"), "Rust");
  assert.equal(languageForFile("src/App.tsx"), "TypeScript/TSX");
  assert.equal(languageForFile("lib/main.dart"), "Dart");
  assert.equal(languageForFile("infra/main.tf"), "Terraform/HCL");
  assert.equal(languageForFile("composer.json"), "PHP/Composer project");
  assert.equal(summarizeLanguages(["a.py","b.py","c.rs"]).find(x=>x.language==="Python").files, 2);
});

test("security scan reports common risky patterns with locations", () => {
  const results = scanText("src/app.js", [
    'const api_key = "sk_live_1234567890abcdef";',
    'element.innerHTML = userInput;',
    'const tls = { rejectUnauthorized: false };',
    'eval(userInput);',
  ].join("\n"));
  assert.ok(results.some(x => x.id === "secret-hardcoded" && x.line === 1));
  assert.ok(results.some(x => x.id === "unsafe-innerhtml" && x.line === 2));
  assert.ok(results.some(x => x.id === "weak-tls" && x.line === 3));
  assert.ok(results.some(x => x.id === "dynamic-eval" && x.line === 4));
});

test("security scan ignores obvious placeholders", () => {
  assert.equal(scanText("config.js", 'password = "change_me_please";').length, 0);
});
