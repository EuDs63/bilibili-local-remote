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
const EXTENSION_TIMEOUT_MS = 45_000;
const VERSION = "0.3.6";

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
  "closeTab",
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
  const header = req.headers["x-video-remote-token"] || req.headers["x-bili-remote-token"];
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

export function extractVideoUrl(value) {
  const text = String(value || "");
  const match = text.match(/https?:\/\/[^\s<>"'，。！？；：、）】》]+/i);
  if (!match) return null;
  try {
    const candidate = match[0].replace(/[),.!?;:，。！？；：、）】》]+$/u, "");
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Kept as an export so integrations written for version 0.2 do not break.
export const extractBilibiliUrl = extractVideoUrl;

function normalizeCapabilities(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    danmaku: Boolean(source.danmaku),
    fullscreen: source.fullscreen !== false,
    next: Boolean(source.next),
    previous: Boolean(source.previous),
  };
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
    const value = extractVideoUrl(body.value);
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
  port = Number(process.env.VIDEO_REMOTE_PORT || process.env.BILI_REMOTE_PORT || 17331),
  dataDir = DEFAULT_DATA_DIR,
  noPairing = process.env.VIDEO_REMOTE_NO_PAIRING === "1"
    || process.env.BILI_REMOTE_NO_PAIRING === "1"
    || process.argv.includes("--no-pairing"),
  logger = console,
} = {}) {
  const token = loadOrCreateToken(dataDir);
  const pairingCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const bootId = randomBytes(8).toString("hex");
  let sequence = 0;
  let latestState = null;
  let extensionLastSeen = 0;
  let extensionOnline = false;
  let acknowledgedSeq = 0;
  let lastPlayerUrl = "";
  const commandHistory = [];
  const waiters = new Set();
  const failedPairing = new Map();
  const phoneClients = new Set();

  function log(level, area, message) {
    const method = level === "错误" ? "error" : level === "警告" ? "warn" : "log";
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    logger?.[method]?.(`[${time}] [${area}] ${message}`);
  }

  function extensionIsConnected(now = Date.now()) {
    const connected = now - extensionLastSeen < EXTENSION_TIMEOUT_MS;
    if (!connected && extensionOnline) {
      extensionOnline = false;
      log("警告", "扩展", "连接已超时；请检查扩展是否重新加载、浏览器是否正在运行");
    }
    return connected;
  }

  function markExtensionSeen() {
    const wasConnected = extensionIsConnected();
    extensionLastSeen = Date.now();
    if (!wasConnected) {
      extensionOnline = true;
      log("信息", "扩展", "已连接，正在监听遥控命令");
    }
  }

  function commandDescription(command) {
    if (command.type === "openUrl") return `打开链接 ${command.value}`;
    if (command.value !== undefined) return `${command.type} (${command.value})`;
    return command.type;
  }

  function logDelivery(commands) {
    if (!commands.length) return;
    log("信息", "命令", `已发送到扩展：${commands.map((command) => `#${command.seq}`).join(", ")}`);
  }

  function publicState() {
    const now = Date.now();
    return {
      extensionConnected: extensionIsConnected(now),
      playerActive: Boolean(latestState && now - latestState.updatedAt < 5000),
      player: latestState,
      pairingRequired: !noPairing,
      serverTime: now,
      version: VERSION,
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
        logDelivery(commands);
        json(waiter.res, 200, { bootId, commands, latestSeq: sequence });
      }
    }
  }

  function enqueue(command) {
    const item = { ...command, seq: ++sequence, sentAt: Date.now() };
    commandHistory.push(item);
    if (commandHistory.length > 100) commandHistory.shift();
    log("信息", "命令", `#${item.seq} 已入队：${commandDescription(item)}`);
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
        "Access-Control-Allow-Headers": "Content-Type, X-Video-Remote-Token, X-Bili-Remote-Token",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return true;
    }

    if (url.pathname === "/api/info" && req.method === "GET") {
      json(res, 200, { pairingRequired: !noPairing, version: VERSION });
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
        log("信息", "手机", `设备 ${ip} 配对成功`);
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
      markExtensionSeen();
      json(res, 200, { acknowledgedSeq, bootId, latestSeq: sequence });
      return true;
    }

    if (url.pathname === "/api/extension/commands" && req.method === "GET") {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "只允许本机扩展访问" });
        return true;
      }
      markExtensionSeen();
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const commands = commandsAfter(after);
      if (commands.length) {
        logDelivery(commands);
        json(res, 200, { bootId, commands, latestSeq: sequence });
        return true;
      }
      const waiter = { after, res, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        json(res, 200, { bootId, commands: [], latestSeq: sequence });
      }, 20_000);
      waiters.add(waiter);
      res.on("close", () => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      });
      return true;
    }

    if (url.pathname === "/api/extension/result" && req.method === "POST") {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "只允许本机扩展访问" });
        return true;
      }
      try {
        const body = await readJson(req);
        const seq = Math.max(0, Math.trunc(Number(body.seq) || 0));
        const item = commandHistory.find((command) => command.seq === seq);
        if (!item) {
          json(res, 400, { error: "命令序号不存在" });
          return true;
        }
        const handled = body.handled === true;
        const detail = String(body.detail || "").replace(/\s+/g, " ").slice(0, 240);
        acknowledgedSeq = Math.max(acknowledgedSeq, seq);
        markExtensionSeen();
        log(handled ? "信息" : "警告", "命令", `#${seq} ${handled ? "执行成功" : "执行失败"}${detail ? `：${detail}` : ""}`);
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { error: "无法读取命令执行结果" });
      }
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
          title: String(body.title || "网页视频").slice(0, 200),
          siteName: String(body.siteName || "网页视频").slice(0, 80),
          currentTime: Math.max(0, Number(body.currentTime) || 0),
          duration: Math.max(0, Number(body.duration) || 0),
          volume: Math.min(1, Math.max(0, Number(body.volume) || 0)),
          muted: Boolean(body.muted),
          paused: Boolean(body.paused),
          playbackRate: Number(body.playbackRate) || 1,
          url: extractVideoUrl(body.url) || "",
          capabilities: normalizeCapabilities(body.capabilities),
          updatedAt: Date.now(),
        };
        markExtensionSeen();
        if (latestState.url && latestState.url !== lastPlayerUrl) {
          lastPlayerUrl = latestState.url;
          log("信息", "播放器", `${latestState.siteName} · ${latestState.title}`);
          log("信息", "播放器", `页面 ${latestState.url}`);
        }
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
      const ip = req.socket.remoteAddress || "unknown";
      if (!isLoopback(ip) && !phoneClients.has(ip)) {
        phoneClients.add(ip);
        log("信息", "手机", `控制页面已连接：${ip}`);
      }
      json(res, 200, publicState());
      return true;
    }

    if (url.pathname === "/api/command" && req.method === "POST") {
      if (!extensionIsConnected()) {
        log("警告", "命令", "已拒绝：扩展未连接，命令不会进入队列");
        json(res, 409, { error: "扩展未连接，请重新加载扩展并刷新视频页面后再试" });
        return true;
      }
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
      log("错误", "服务", error?.stack || error?.message || String(error));
      if (!res.headersSent) json(res, 500, { error: "本地服务发生错误" });
      else res.end();
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  log("信息", "服务", `正在监听 ${host}:${server.address().port}，版本 ${VERSION}`);

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
  console.log("\n  网页视频床上遥控器已经启动");
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
  console.log("\n  请保持这个窗口打开。按 Ctrl+C 可以停止。");
  console.log("  发送链接后，日志应依次显示：已入队 → 已发送到扩展 → 执行成功。\n");
}
