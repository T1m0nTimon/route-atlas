"use strict";

const path = require("path");

const RULES = {
  "secret-hardcoded": ["Möglicherweise fest codiertes Geheimnis", "CWE-798"],
  "private-key": ["Privater Schlüssel im Quellcode", "CWE-321"],
  "sql-concat": ["Mögliche SQL-Injection durch String-Verkettung", "CWE-89"],
  "dynamic-eval": ["Dynamische Code-Ausführung", "CWE-95"],
  "shell-injection": ["Shell-Aufruf mit möglicher Benutzereingabe", "CWE-78"],
  "unsafe-innerhtml": ["Unsichere HTML-Ausgabe über innerHTML", "CWE-79"],
  "weak-tls": ["TLS-Zertifikatsprüfung deaktiviert", "CWE-295"],
  "wildcard-cors": ["CORS erlaubt beliebige Origins", "CWE-942"],
  "weak-hash": ["Schwacher Hash-Algorithmus", "CWE-328"],
  "debug-enabled": ["Debug-Modus möglicherweise aktiviert", "CWE-489"],
};

function toSarif(findings, workspaceRoot) {
  const rules = [...new Set(findings.map((finding) => finding.id))].map((id) => {
    const [description, cwe] = RULES[id] || [id, "CWE-unknown"];
    return {
      id,
      shortDescription: { text: description },
      properties: { tags: ["security", cwe], precision: "very-low" },
      helpUri: "https://cwe.mitre.org/data/definitions/" + cwe.replace("CWE-", "") + ".html",
    };
  });
  const results = findings.map((finding) => {
    const rule = RULES[finding.id] || [finding.title, "CWE-unknown"];
    const relative = path.relative(workspaceRoot, finding.file).split(path.sep).join("/");
    return {
      ruleId: finding.id,
      level: finding.severity === "critical" || finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "note",
      message: { text: finding.title + " (" + rule[1] + "; " + finding.confidence + " confidence). Static heuristic: verify manually." },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: relative || path.basename(finding.file) },
          region: { startLine: Math.max(1, finding.line), startColumn: Math.max(1, finding.column + 1) },
        },
      }],
      properties: { severity: finding.severity, confidence: finding.confidence, cwe: rule[1] },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Route Atlas",
          version: "0.4.0",
          informationUri: "https://github.com/T1m0nTimon/route-atlas",
          rules,
        },
      },
      results,
      invocations: [{ executionSuccessful: true, properties: { analysis: "local-read-only-static-heuristics", confirmedVulnerabilities: false } }],
    }],
  };
}

module.exports = { toSarif };
