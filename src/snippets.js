"use strict";

const NO_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

function withContentType(headers, body) {
  const all = { ...headers };
  if (body && !Object.keys(all).some((name) => name.toLowerCase() === "content-type")) {
    all["Content-Type"] = /^\s*[[{]/.test(body) ? "application/json" : "text/plain";
  }
  return all;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toCurl({ method = "GET", url, headers = {}, body }) {
  const parts = ["curl"];
  if (method !== "GET" || body) parts.push(`-X ${method}`);
  parts.push(shellQuote(url));
  for (const [name, value] of Object.entries(withContentType(headers, body))) parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  if (body) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(" \\\n  ");
}

function jsBody(body, indent) {
  try {
    const parsed = JSON.parse(body);
    return { value: `JSON.stringify(${JSON.stringify(parsed, null, 2).replace(/\n/g, `\n${indent}`)})`, json: true, parsed };
  } catch {
    return { value: JSON.stringify(body), json: false };
  }
}

function objectLiteral(object, indent) {
  const json = JSON.stringify(object, null, 2);
  return json.replace(/\n/g, `\n${indent}`);
}

function toFetch({ method = "GET", url, headers = {}, body }) {
  const allHeaders = withContentType(headers, body);
  const options = [];
  if (method !== "GET") options.push(`  method: ${JSON.stringify(method)},`);
  if (Object.keys(allHeaders).length) options.push(`  headers: ${objectLiteral(allHeaders, "  ")},`);
  if (body && !NO_BODY.has(method)) options.push(`  body: ${jsBody(body, "  ").value},`);
  const call = options.length ? `fetch(${JSON.stringify(url)}, {\n${options.join("\n")}\n})` : `fetch(${JSON.stringify(url)})`;
  return `const response = await ${call};\nconst data = await response.json();`;
}

function toAxios({ method = "GET", url, headers = {}, body }) {
  const config = [`  method: ${JSON.stringify(method.toLowerCase())},`, `  url: ${JSON.stringify(url)},`];
  if (Object.keys(headers).length) config.push(`  headers: ${objectLiteral(headers, "  ")},`);
  if (body && !NO_BODY.has(method)) {
    const parsed = jsBody(body, "  ");
    config.push(`  data: ${parsed.json ? objectLiteral(parsed.parsed, "  ") : parsed.value},`);
  }
  return `const { data } = await axios({\n${config.join("\n")}\n});`;
}

function toHttpie({ method = "GET", url, headers = {}, body }) {
  const parts = ["http", method, shellQuote(url)];
  for (const [name, value] of Object.entries(headers)) parts.push(shellQuote(`${name}:${value}`));
  const command = parts.join(" ");
  return body && !NO_BODY.has(method) ? `echo ${shellQuote(body)} | ${command}` : command;
}

const SNIPPETS = [
  { id: "curl", label: "cURL", render: toCurl },
  { id: "fetch", label: "fetch", render: toFetch },
  { id: "axios", label: "Axios", render: toAxios },
  { id: "httpie", label: "HTTPie", render: toHttpie },
];

module.exports = { SNIPPETS, toCurl, toFetch, toAxios, toHttpie };
