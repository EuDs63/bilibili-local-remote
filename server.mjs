import http from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(ROOT, "public");
const DEFAULT_DATA_DIR = join(ROOT, ".data");
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SIMPLE_COMMANDS = new Set([
  "toggle",
  "play",
  "pause",
  "mute",
  "next",
  "previous",
  "toggleDanmaku",
  "fullscreen",
  "webFullscreen",
]);

function loadOrCreateToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const value = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token)) {
        return value.token;
      }
    } catch {
      // A damaged local config is replaced below.
    }
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(configPath, `${JSON.stringify({ token }, null, 2)}\n`, "utf8");
  return token;
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(body);
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function tokensMatch(received, expected) {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readToken(req) {
  const header = req.headers["x-bili-remote-token"];
  return Array.isArray(header) ? header[0] : header;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function extractBilibiliUrl(value) {
  const text = String(value || "");
  const match = text.match(/https?:\/\/(?:[a-z0-9-]+\.)*bilibili\.com\/[^\s<>"'，。！？；：、）】》]+|https?:\/\/b23\.tv\/[^\s<>"'，。！？；：、）】》]+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "bilibili.com" && !host.endsWith(".bilibili.com") && host !== "b23.tv") return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeCommand(body) {
  const type = body?.type;
  if (SIMPLE_COMMANDS.has(type)) return { type };

  if (type === "seekBy") {
    const value = Number(body.value);
    if (Number.isFinite(value) && value >= -600 && value <= 600) return { type, value };
  }
  if (type === "seekTo") {
    const value = Number(body.value);
    if (Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 60) return { type, value };
  }
  if (type === "volume") {
    const value = Number(body.value);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return { type, value };
  }
  if (type === "speed") {
    const value = Number(body.value);
    if ([0.5, 0.75, 1, 1.25, 1.5, 2].includes(value)) return { type, value };
  }
  if (type === "openUrl") {
    const value = extractBilibiliUrl(body.value);
    if (value) return { type, value };
  }
  return null;
}

function addressPriority(name, address) {
  const virtualPenalty = /clash|radmin|wsl|hyper-v|vethernet|virtual|vpn/i.test(name) ? 20 : 0;
  if (/^192\.168\./.test(address)) return virtualPenalty;
  if (/^10\./.test(address)) return 2 + virtualPenalty;
  const second = Number(address.split(".")[1]);
  if (/^172\./.test(address) && second >= 16 && second <= 31) return 4 + virtualPenalty;
  if (/^198\.(18|19)\./.test(address)) return 40 + virtualPenalty;
  return 10 + virtualPenalty;
}

export function lanAddresses() {
  const addresses = [];
  for (const [name, records] of Object.entries(networkInterfaces())) {
    for (const record of records || []) {
      if (record.family === "IPv4" && !record.internal && !record.address.startsWith("169.254.")) {
        addresses.push({ address: record.address, priority: addressPriority(name, record.address) });
      }
    }
  }
  return [...new Map(addresses.map((item) => [item.address, item])).values()]
    .sort((left, right) => left.priority - right.priority)
    .map((item) => item.address);
}

export async function startServer({
  host = "0.0.0.0",
  port = Number(process.env.BILI_REMOTE_PORT || 7331),
  dataDir = DEFAULT_DATA_DIR,
  noPairing = process.env.BILI_REMOTE_NO_PAIRING === "1" || process.argv.includes("--no-pairing"),
} = {}) {
  const token = loadOrCreateToken(dataDir);
  const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const bootId = randomBytes(8).toString("hex");
  let sequence = 0;
  let latestState = null;
  let extensionLastSeen = 0;
  const commandHistory = [];
  const waiters = new Set();
  const failedPairing = new Map();

  function publicState() {
    const now = Date.now();
    return {
      extensionConnected: now - extensionLastSeen < 25_000,
      playerActive: Boolean(latestState && now - latestState.updatedAt < 5000),
      player: latestState,
      pairingRequired: !noPairing,
      serverTime: now,
      version: "0.2.0",
    };
  }

  function commandsAfter(after) {
    return commandHistory.filter((item) => item.seq > after);
  }

  function flushWaiters() {
    for (const waiter of [...waiters]) {
      const commands = commandsAfter(waiter.after);
      if (commands.length) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        json(waiter.res, 200, { bootId, commands, latestSeq: sequence });
      }
    }
  }

  function enqueue(command) {
    const item = { ...command, seq: ++sequence, sentAt: Date.now() };
    commandHistory.push(item);
    if (commandHistory.length > 100) commandHistory.shift();
    flushWaiters();
    return item;
  }

  function pairingAllowed(ip) {
    const now = Date.now();
    const attempts = (failedPairing.get(ip) || []).filter((time) => now - time < 60_000);
    failedPairing.set(ip, attempts);
    return attempts.length < 8;
  }

  function recordPairingFailure(ip) {
    const attempts = failedPairing.get(ip) || [];
    attempts.push(Date.now());
    failedPairing.set(ip, attempts);
  }

  async function api(req, res, url) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type, X-Bili-Remote-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return true;
    }

    if (url.pathname === "/api/info" && req.method === "GET") {
      json(res, 200, { pairingRequired: !noPairing, version: "0.2.0" });
      return true;
    }

    if (url.pathname === "/api/pair" && req.method === "POST") {
      if (noPairing) {
        json(res, 200, { pairingRequired: false, token: "" });
        return true;
      }
      const ip = req.socket.remoteAddress || "unknown";
      if (!pairingAllowed(ip)) {
        json(res, 429, { error: "尝试次数过多，请一分钟后再试" });
        return true;
      }
      try {
        const body = await readJson(req);
        if (String(body.code || "") !== pairingCode) {
          recordPairingFailure(ip);
          json(res, 401, { error: "配对码不正确" });
          return true;
        }
        failedPairing.delete(ip);
        json(res, 200, { token });
      } catch {
        json(res, 400, { error: "无法读取配对请求" });
      }
      return true;
    }

    if (url.pathname === "/api/extension/hello" && req.method === "GET") {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "只允许本机扩展访问" });
        return true;
      }
      extensionLastSeen = Date.now();
      json(res, 200, { bootId, latestSeq: sequence });
      return true;
    }

    if (url.pathname === "/api/extension/commands" && req.method === "GET") {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "只允许本机扩展访问" });
        return true;
      }
      extensionLastSeen = Date.now();
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const commands = commandsAfter(after);
      if (commands.length) {
        json(res, 200, { bootId, commands, latestSeq: sequence });
        return true;
      }
      const waiter = { after, res, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        json(res, 200, { bootId, commands: [], latestSeq: sequence });
      }, 20_000);
      waiters.add(waiter);
      req.on("close", () => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      });
      return true;
    }

    if (url.pathname === "/api/extension/state" && req.method === "POST") {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "只允许本机扩展访问" });
        return true;
      }
      try {
        const body = await readJson(req);
        latestState = {
          title: String(body.title || "哔哩哔哩").slice(0, 200),
          currentTime: Math.max(0, Number(body.currentTime) || 0),
          duration: Math.max(0, Number(body.duration) || 0),
          volume: Math.min(1, Math.max(0, Number(body.volume) || 0)),
          muted: Boolean(body.muted),
          paused: Boolean(body.paused),
          playbackRate: Number(body.playbackRate) || 1,
          url: extractBilibiliUrl(body.url) || "",
          updatedAt: Date.now(),
        };
        extensionLastSeen = Date.now();
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { error: "播放器状态格式不正确" });
      }
      return true;
    }

    if (!noPairing && !tokensMatch(readToken(req), token)) {
      json(res, 401, { error: "请先使用配对码连接" });
      return true;
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      json(res, 200, publicState());
      return true;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const command = normalizeCommand(body);
        if (!command) {
          json(res, 400, { error: "不支持的遥控指令" });
          return true;
        }
        const item = enqueue(command);
        json(res, 202, { ok: true, seq: item.seq });
      } catch {
        json(res, 400, { error: "无法读取遥控指令" });
      }
      return true;
    }

    json(res, 404, { error: "接口不存在" });
    return true;
  }

  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "请求方式不支持" });
      return;
    }
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = resolve(PUBLIC_ROOT, normalize(relative));
    if (!filePath.startsWith(resolve(PUBLIC_ROOT) + sep)) {
      json(res, 403, { error: "禁止访问" });
      return;
    }
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Length": body.length,
        "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      json(res, 404, { error: "页面不存在" });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await api(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (error) {
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: "本地服务发生错误" });
      else res.end();
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });

  return {
    bootId,
    pairingCode,
    noPairing,
    server,
    token,
    port: server.address().port,
  };
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  const running = await startServer();
  const addresses = lanAddresses();
  const primaryUrl = addresses.length ? `http://${addresses[0]}:${running.port}/` : null;
  console.log("\n  B站床上遥控器已经启动");
  if (running.noPairing) {
    console.log("  模式：免配对（同一局域网内的设备均可控制）");
  } else {
    console.log(`  配对码：${running.pairingCode}`);
  }
  console.log("\n  请在安卓手机浏览器打开以下地址之一：");
  if (addresses.length === 0) console.log(`  http://电脑局域网IP:${running.port}`);
  for (const address of addresses) console.log(`  http://${address}:${running.port}/`);
  if (primaryUrl) {
    try {
      const QRCode = (await import("qrcode")).default;
      const terminalQr = await QRCode.toString(primaryUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        small: true,
        type: "utf8",
      });
      console.log(`\n  扫描二维码打开：${primaryUrl}\n`);
      console.log(terminalQr);
    } catch (error) {
      console.warn(`\n  二维码生成失败：${error.message}`);
    }
  }
  console.log("\n  请保持这个窗口打开。按 Ctrl+C 可以停止。\n");
}
