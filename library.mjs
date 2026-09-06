import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIMITS = { queue: 100, bookmarks: 200, history: 50 };
const cleanText = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const newId = () => randomBytes(9).toString("base64url");

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function emptyLibrary() { return { queue: [], bookmarks: [], history: [] }; }

function sanitizeLoaded(loaded) {
  const clean = emptyLibrary();
  for (const kind of Object.keys(clean)) {
    if (!Array.isArray(loaded?.[kind])) continue;
    for (const raw of loaded[kind]) {
      const id = cleanText(raw?.id, 80), url = safeUrl(raw?.url);
      if (!id || !url) continue;
      const item = { ...raw, id, url, title: cleanText(raw.title, 200) || url };
      if (kind !== "queue") {
        const time = Number(raw.time);
        if (!Number.isFinite(time) || time < 0 || time > 86400) continue;
        item.time = time;
      }
      if (kind === "bookmarks") item.note = cleanText(raw.note, 300);
      clean[kind].push(item);
      if (clean[kind].length >= LIMITS[kind]) break;
    }
  }
  return clean;
}

export function createLibrary(dataDir, logger = console) {
  const path = join(dataDir, "library.json");
  let data = emptyLibrary();
  let historyTimer = null;
  if (existsSync(path)) {
    try {
      data = sanitizeLoaded(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      logger?.warn?.(`[媒体库] 无法读取已有数据，将使用空媒体库：${error.message}`);
    }
  }

  const snapshot = () => structuredClone(data);
  function save(next = data) {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }
  function commit(change) {
    const next = snapshot();
    change(next);
    save(next);
    data = next;
    return snapshot();
  }
  function flush() {
    if (!historyTimer) return;
    clearTimeout(historyTimer);
    historyTimer = null;
    save();
  }
  function scheduleHistorySave() {
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      try { save(); } catch (error) { logger?.error?.(`[媒体库] 保存播放历史失败：${error.message}`); }
    }, 10_000);
  }
  function recordHistory({ url, title, time, paused }) {
    const normalizedUrl = safeUrl(url);
    if (!normalizedUrl) return;
    const existing = data.history.find((item) => item.url === normalizedUrl);
    const normalizedTime = Math.min(86400, Math.max(0, Number(time) || 0));
    const normalizedTitle = cleanText(title, 200) || normalizedUrl;
    if (paused && existing && existing.title === normalizedTitle && Math.abs(existing.time - normalizedTime) < 0.5) return;
    const item = {
      id: existing?.id || newId(), url: normalizedUrl, title: normalizedTitle,
      time: normalizedTime, updatedAt: Date.now(),
    };
    data.history = [item, ...data.history.filter((entry) => entry.id !== item.id)].slice(0, LIMITS.history);
    scheduleHistorySave();
  }
  function addQueue(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new Error("队列每次需要添加 1 到 50 项");
    const additions = items.map((item) => {
      const url = safeUrl(item?.url);
      if (!url) throw new Error("队列中包含无效链接");
      return { id: newId(), url, title: cleanText(item?.title, 200) || url, addedAt: Date.now() };
    });
    if (data.queue.length + additions.length > LIMITS.queue) throw new Error(`队列最多保存 ${LIMITS.queue} 项`);
    return commit((next) => { next.queue.push(...additions); });
  }
  function addBookmark(input) {
    const url = safeUrl(input?.url), time = Number(input?.time);
    if (!url || !Number.isFinite(time) || time < 0 || time > 86400) throw new Error("书签链接或时间无效");
    return commit((next) => {
      next.bookmarks.unshift({ id: newId(), url, title: cleanText(input.title, 200) || url, time, note: cleanText(input.note, 300), addedAt: Date.now() });
      next.bookmarks = next.bookmarks.slice(0, LIMITS.bookmarks);
    });
  }
  function find(kind, id) { return data[kind].find((item) => item.id === id) || null; }
  function remove(kind, id) {
    if (!find(kind, id)) throw new Error("项目不存在");
    return commit((next) => { next[kind] = next[kind].filter((item) => item.id !== id); });
  }
  function moveQueue(id, direction) {
    if (direction !== -1 && direction !== 1) throw new Error("移动方向无效");
    const index = data.queue.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("队列项目不存在");
    return commit((next) => {
      const destination = Math.max(0, Math.min(next.queue.length - 1, index + direction));
      const [item] = next.queue.splice(index, 1); next.queue.splice(destination, 0, item);
    });
  }
  return { snapshot, flush, recordHistory, addQueue, addBookmark, find, remove, moveQueue };
}
