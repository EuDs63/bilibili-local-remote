(function exposeRemoteFeatures(root) {
  function extractUrls(text, limit = 50) {
    const matches = String(text || "").match(/https?:\/\/[^\s<>"'，。！？；：、）】》]+/gi) || [];
    const seen = new Set();
    const items = [];
    for (const match of matches) {
      const candidate = match.replace(/[),.!?;:，。！？；：、）】》]+$/u, "");
      try {
        const url = new URL(candidate);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) {
          continue;
        }
        seen.add(url.href);
        items.push({ url: url.href });
        if (items.length >= limit) break;
      } catch {
        // Ignore malformed fragments in pasted share text.
      }
    }
    return items;
  }

  function moveItem(items, id, direction) {
    const copy = items.slice();
    const from = copy.findIndex((item) => item.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= copy.length) return copy;
    [copy[from], copy[to]] = [copy[to], copy[from]];
    return copy;
  }

  function bookmarkFromPlayer(player, note) {
    if (!player?.url) return null;
    return {
      url: player.url,
      title: player.title || player.url,
      time: Math.max(0, Number(player.currentTime) || 0),
      note: String(note || "").trim(),
    };
  }

  function buildTabTree(tabs) {
    const windows = new Map();
    const ordered = tabs.map((tab, sourceIndex) => ({
      tab,
      sourceIndex,
      windowId: Number.isInteger(tab.windowId) ? tab.windowId : 0,
      index: Number.isInteger(tab.index) ? tab.index : sourceIndex,
    }));
    ordered.sort((a, b) => a.windowId - b.windowId || a.index - b.index || a.sourceIndex - b.sourceIndex);
    ordered.forEach(({ tab, windowId }) => {
      if (!windows.has(windowId)) {
        windows.set(windowId, { windowId, entries: [] });
      }
      const window = windows.get(windowId);
      const validGroup = Number.isInteger(tab.group?.id) && tab.group.id >= 0;
      const groupId = validGroup ? tab.group.id : null;
      const key = groupId === null ? "ungrouped" : `group:${groupId}`;
      let entry = window.entries.at(-1);
      if (!entry || entry.key !== key) {
        entry = {
          key,
          group: validGroup ? tab.group : null,
          tabs: [],
        };
        window.entries.push(entry);
      }
      entry.tabs.push(tab);
    });
    return [...windows.values()];
  }

  function createThemeController({ storage, root, meta }) {
    const key = "videoRemoteTheme";
    let saved = null;
    try {
      const value = storage.getItem(key);
      if (value === "light" || value === "dark") saved = value;
    } catch {
      saved = null;
    }
    const apply = (theme) => {
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      if (meta) meta.content = theme === "dark" ? "#141618" : "#e7e9ec";
      return theme;
    };
    apply(saved || "light");
    return {
      get theme() { return root.dataset.theme; },
      get userSelected() { return saved !== null; },
      toggle() {
        saved = root.dataset.theme === "dark" ? "light" : "dark";
        apply(saved);
        try {
          storage.setItem(key, saved);
        } catch {
          // The chosen theme still applies for this page session.
        }
        return saved;
      },
    };
  }

  root.RemoteFeatures = { extractUrls, moveItem, bookmarkFromPlayer, buildTabTree, createThemeController };
})(globalThis);
