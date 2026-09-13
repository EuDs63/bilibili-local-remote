(function exposeRemoteFinder(root) {
  const PORT = 17331;
  const SERVICE = "web-video-local-remote";
  const LAST_IP_KEY = "videoRemoteFinderLastIp";
  const NETWORK_KEY = "videoRemoteFinderNetwork";

  function isPrivateIpv4(value) {
    const parts = String(value).split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }

  function parseTarget(value) {
    const cleaned = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/[:/].*$/, "");
    const parts = cleaned.split(".");
    if (parts.length === 4 && isPrivateIpv4(cleaned)) {
      return { addresses: [cleaned], network: parts.slice(0, 3).join(".") };
    }
    if (parts.length === 3 && parts.every((part) => /^\d{1,3}$/.test(part))) {
      const network = parts.map(Number).join(".");
      if (!isPrivateIpv4(`${network}.1`)) return null;
      return {
        addresses: Array.from({ length: 254 }, (_, index) => `${network}.${index + 1}`),
        network,
      };
    }
    return null;
  }

  function prioritizeAddress(addresses, preferred) {
    if (!preferred || !addresses.includes(preferred)) return addresses.slice();
    return [preferred, ...addresses.filter((address) => address !== preferred)];
  }

  async function findService(addresses, probe, { concurrency = 24, onProgress = () => {} } = {}) {
    let cursor = 0;
    let checked = 0;
    let found = null;
    async function worker() {
      while (!found && cursor < addresses.length) {
        const address = addresses[cursor];
        cursor += 1;
        const matched = await probe(address);
        checked += 1;
        onProgress(checked, addresses.length, address);
        if (matched) found = address;
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
    return found;
  }

  root.RemoteFinder = { findService, isPrivateIpv4, parseTarget, prioritizeAddress };
  if (typeof document === "undefined") return;

  const card = document.querySelector(".finder-card");
  const title = document.querySelector("#finder-title");
  const status = document.querySelector("#status");
  const progress = document.querySelector("#progress");
  const progressText = document.querySelector("#progress-text");
  const progressTrack = document.querySelector(".progress-track");
  const form = document.querySelector("#scan-form");
  const networkInput = document.querySelector("#network");
  const scanButton = document.querySelector("#scan-button");
  let generation = 0;

  function storageGet(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  function setState(state, heading, message) {
    card.dataset.state = state;
    status.dataset.state = state;
    title.textContent = heading;
    status.textContent = message;
  }

  async function probe(address, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${address}:${PORT}/api/discovery`, {
        cache: "no-store",
        mode: "cors",
        signal: controller.signal,
        targetAddressSpace: "local",
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body.service === SERVICE && body.port === PORT;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function scan(value, automatic = false) {
    const currentGeneration = ++generation;
    const parsed = parseTarget(value);
    if (!parsed) {
      setState("error", "网段格式不正确", "请输入类似 192.168.1 的网段，或完整的私有网络 IP。");
      networkInput.focus();
      return;
    }

    storageSet(NETWORK_KEY, parsed.network);
    networkInput.value = parsed.network;
    scanButton.disabled = true;
    setState("scanning", "正在寻找电脑", automatic ? "正在检查上次连接和家庭网段…" : `正在扫描 ${parsed.network}.1–254…`);
    progress.style.width = "0%";
    progressTrack.setAttribute("aria-valuemax", String(parsed.addresses.length));
    progressTrack.setAttribute("aria-valuenow", "0");

    const lastIp = storageGet(LAST_IP_KEY);
    const addresses = prioritizeAddress(parsed.addresses, lastIp);
    if (lastIp && addresses[0] === lastIp) {
      progressText.textContent = `优先检查上次地址 ${lastIp}`;
      if (await probe(lastIp, 4000)) {
        if (currentGeneration === generation) connect(lastIp);
        return;
      }
    }

    const remaining = addresses.filter((address) => address !== lastIp);
    const found = await findService(remaining, (address) => probe(address, 1100), {
      concurrency: 28,
      onProgress(checked, total, address) {
        if (currentGeneration !== generation) return;
        const percent = Math.round((checked / total) * 100);
        progress.style.width = `${percent}%`;
        progressTrack.setAttribute("aria-valuenow", String(checked));
        progressText.textContent = `已检查 ${checked}/${total} · ${address}`;
      },
    });

    if (currentGeneration !== generation) return;
    scanButton.disabled = false;
    if (found) {
      connect(found);
    } else {
      setState("error", "没有找到电脑", "请检查服务、Wi-Fi 和 Chrome 的本地网络权限，然后重新查找。");
      progressText.textContent = `已完成 ${remaining.length} 个地址的检查`;
      document.querySelector("#help").open = true;
    }
  }

  function connect(address) {
    storageSet(LAST_IP_KEY, address);
    setState("found", "已经找到电脑", `正在连接 ${address}:${PORT}…`);
    progress.style.width = "100%";
    progressText.textContent = "连接成功，正在打开遥控器";
    window.setTimeout(() => window.location.replace(`http://${address}:${PORT}/`), 250);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void scan(networkInput.value);
  });

  const savedNetwork = storageGet(NETWORK_KEY);
  if (parseTarget(savedNetwork)) networkInput.value = savedNetwork;
  void scan(networkInput.value, true);
})(globalThis);
