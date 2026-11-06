"use strict";

const net = require("net");

const COMMON_PORTS = [3000, 5173, 8000, 8080, 5000, 4321, 4200, 8090];
const RISKY = /(logout|signout|sign-out|abmelden|delete|remove|destroy|reset|clear|purge)/i;

function isOpen(port, host = "127.0.0.1", timeout = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** The first port from `preferred`, then from the usual ones, that accepts a connection. */
async function findServer(preferred) {
  const ports = [...new Set([...preferred, ...COMMON_PORTS])];
  const open = await Promise.all(ports.map((port) => isOpen(port)));
  const index = open.indexOf(true);
  return index === -1 ? null : ports[index];
}

async function send({ url, method = "GET", body, headers = {}, timeout = 15000 }) {
  const started = Date.now();
  const options = { method, headers: { ...headers }, redirect: "manual", signal: AbortSignal.timeout(timeout) };
  if (body) {
    options.body = body;
    if (!Object.keys(options.headers).some((name) => name.toLowerCase() === "content-type")) {
      options.headers["Content-Type"] = /^\s*[[{]/.test(body) ? "application/json" : "text/plain";
    }
  }
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    statusText: response.statusText,
    ms: Date.now() - started,
    headers: Object.fromEntries(response.headers.entries()),
    text,
  };
}

/** Only plain GET routes without parameters are safe to call in bulk. */
function checkable(route) {
  const readable = !route.methods.length || route.methods.includes("GET");
  return readable && !route.path.includes(":") && !route.path.includes("*") && !RISKY.test(route.path);
}

async function checkAll(routes, baseUrl, { headers, concurrency = 4, onResult }) {
  const queue = routes.filter(checkable);
  const worker = async () => {
    for (let route = queue.shift(); route; route = queue.shift()) {
      try {
        const { status, ms } = await send({ url: baseUrl + route.path, headers, timeout: 8000 });
        onResult(route, { status, ms });
      } catch {
        onResult(route, { status: 0, ms: 0 });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function isLocal(url) {
  return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/.test(url);
}

module.exports = { findServer, send, checkable, checkAll, isLocal };
