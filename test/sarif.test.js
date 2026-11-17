"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { toSarif } = require("../src/sarif");

test("exports security findings as SARIF 2.1.0 with relative paths and CWE metadata", () => {
  const report = toSarif([{
    id: "unsafe-innerhtml", title: "Unsafe HTML", severity: "high",
    confidence: "medium", file: "/project/src/app.js", line: 12, column: 4,
  }], "/project");
  assert.equal(report.version, "2.1.0");
  assert.equal(report.runs[0].results[0].ruleId, "unsafe-innerhtml");
  assert.equal(report.runs[0].results[0].level, "error");
  assert.equal(report.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/app.js");
  assert.equal(report.runs[0].results[0].properties.cwe, "CWE-79");
});
