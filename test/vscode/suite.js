"use strict";

// Runs inside a real VS Code window (started by test/vscode/run.js) against a copy of ./fixture.
const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

async function waitFor(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const steps = [];
const step = (name, body) => steps.push({ name, body });
let api;
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

step("activates quickly", async () => {
  const extension = vscode.extensions.getExtension("t1m0ntimon.route-atlas");
  assert.ok(extension, "extension is installed in the test window");
  const started = Date.now();
  api = await extension.activate();
  const ms = Date.now() - started;
  console.log(`    activation ${ms} ms`);
  assert.ok(ms < 3000, `activation took ${ms} ms`);
});

step("finds routes, mounted prefixes and Laravel runtime routes", async () => {
  const paths = await waitFor(() => {
    const list = api.results().flatMap((result) => result.routes.map((route) => route.path));
    return list.includes("/panel/servers/:server") && list;
  }, "routes");
  for (const expected of ["/", "/login", "/api/users", "/api/users/:id", "/admin/settings", "/panel/servers/:server"]) {
    assert.ok(paths.includes(expected), `missing ${expected} in ${paths.join(", ")}`);
  }
});

step("all commands are registered", async () => {
  const commands = await vscode.commands.getCommands(true);
  const manifest = vscode.extensions.getExtension("t1m0ntimon.route-atlas").packageJSON.contributes.commands;
  for (const { command } of manifest) assert.ok(commands.includes(command), `${command} is not registered`);
});

step("security scan fills the Problems panel", async () => {
  await vscode.commands.executeCommand("routeAtlas.securityScan");
  const diagnostics = await waitFor(() => {
    const all = vscode.languages.getDiagnostics().flatMap(([, list]) => list).filter((item) => item.source === "Route Atlas Security");
    return all.length >= 3 && all;
  }, "security diagnostics");
  const codes = diagnostics.map((item) => item.code);
  for (const code of ["secret-hardcoded", "unsafe-innerhtml", "sql-concat"]) assert.ok(codes.includes(code), `no ${code} in ${codes}`);
});

step("AI prompt is written without secrets", async () => {
  // Warm up VS Code's own Markdown support, which starts the first time a .md file opens.
  const warm = Date.now();
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content: "# warm-up" }));
  await vscode.extensions.getExtension("vscode.markdown-language-features")?.activate();
  console.log(`    markdown warm-up ${Date.now() - warm} ms`);
  const started = Date.now();
  await vscode.commands.executeCommand("routeAtlas.aiPrompt");
  console.log(`    routeAtlas.aiPrompt ${Date.now() - started} ms`);
  const file = path.join(root(), ".route-atlas", "ai-security-prompt.md");
  const text = await waitFor(() => fs.readFile(file, "utf8").catch(() => ""), "prompt file");
  assert.match(text, /# Security-Review/);
  assert.match(text, /admin\/panel\.js:2/);
  assert.ok(!text.includes("fixture-not-a-real-secret-42"), "secret leaked into the prompt");
  assert.equal(await fs.readFile(path.join(root(), ".route-atlas", ".gitignore"), "utf8"), "*\n");
  assert.equal(await vscode.env.clipboard.readText(), text);
});

step("graph opens and its script renders every node", async () => {
  await vscode.commands.executeCommand("routeAtlas.graph");
  const nodes = await waitFor(() => api.graphNodes(), "graph render message");
  assert.ok(nodes >= 10, `graph rendered only ${nodes} nodes`);
});

step("other commands run without errors", async () => {
  await vscode.commands.executeCommand("routeAtlas.refresh");
  await vscode.commands.executeCommand("routeAtlas.clearFilter");
});

exports.run = async () => {
  let failed = 0;
  for (const { name, body } of steps) {
    const started = Date.now();
    try {
      await body();
      console.log(`  ✔ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.log(`  ✖ ${name}\n    ${error.stack || error}`);
    }
  }
  console.log(`${steps.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} end-to-end steps failed`);
};
