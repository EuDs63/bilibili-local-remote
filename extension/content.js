const NEXT_SELECTORS = [
  ".bpx-player-ctrl-next",
  ".bilibili-player-video-btn-next",
  ".ytp-next-button",
  "[data-uia='control-next']",
  "button[aria-label='Next']",
  "button[aria-label='下一集']",
  "button[aria-label='下一个']",
];

const PREVIOUS_SELECTORS = [
  ".bpx-player-ctrl-prev",
  ".bilibili-player-video-btn-prev",
  "[data-uia='control-previous']",
  "button[aria-label='Previous']",
  "button[aria-label='上一集']",
  "button[aria-label='上一个']",
];

const FULLSCREEN_SELECTORS = [
  ".bpx-player-ctrl-full",
  ".bpx-player-ctrl-fullscreen",
  ".bilibili-player-video-btn-fullscreen",
  ".squirtle-video-fullscreen",
  ".ytp-fullscreen-button",
  ".plyr__controls__item.plyr__control[data-plyr='fullscreen']",
  ".plyr__control[data-plyr='fullscreen']",
  ".plyr [data-plyr='fullscreen']",
  "[data-fullscreen-button]",
  "[data-testid='fullscreen-button']",
  "button[aria-label*='full screen' i]",
  "button[title*='full screen' i]",
  "[aria-label='进入全屏']",
  "[aria-label='全屏']",
  "button[aria-label*='全屏']",
  "[data-title='进入全屏']",
  "[data-title='全屏']",
  "button[title*='全屏']",
];

const DANMAKU_SELECTORS = [
  ".bpx-player-dm-switch input",
  ".bpx-player-dm-switch",
  ".bui-danmaku-switch-input",
  ".bpx-player-ctrl-danmaku input",
];

const EPISODE_SELECTORS = [
  ".video-pod__item",
  ".ep-item",
  ".list-box li",
  ".bpx-player-episode-card",
  ".ytp-playlist-menu-item",
  "ytd-playlist-panel-video-renderer",
  "[data-episode-id]",
];

let cachedVideo = null;
let cachedTitle = "网页视频";
let cachedSiteName = "网页视频";
let cachedCapabilities = { danmaku: false, fullscreen: true, next: false, previous: false };
let cachedEpisodes = [];
let episodeTargets = new Map();
let episodesPageUrl = location.href;
let nextEpisodeIdentity = 1;
const episodeIdentities = new WeakMap();

function videoElement() {
  if (cachedVideo?.isConnected) return cachedVideo;
  const videos = [...document.querySelectorAll("video")];
  cachedVideo = videos.sort((left, right) => videoScore(right) - videoScore(left))[0] || null;
  return cachedVideo;
}

function videoScore(video) {
  const rect = video.getBoundingClientRect();
  const visibleArea = rect.width > 0 && rect.height > 0 ? rect.width * rect.height : 0;
  return (document.pictureInPictureElement === video ? 1_000_000_000 : 0)
    + (!video.paused && !video.ended ? 100_000_000 : 0)
    + (video.readyState >= 2 ? 10_000_000 : 0)
    + visibleArea
    + (Number.isFinite(video.duration) && video.duration > 0 ? 1_000 : 0);
}

function cleanTitle() {
  const heading = document.querySelector("h1.video-title, h1[title], .video-info-title-inner, .media-title");
  const metadata = document.querySelector("meta[property='og:title'], meta[name='twitter:title']");
  const genericHeading = document.querySelector("main h1, article h1, h1");
  const value = heading?.getAttribute("title")
    || heading?.textContent
    || metadata?.getAttribute("content")
    || genericHeading?.textContent
    || document.title;
  return String(value || "网页视频")
    .replace(/_哔哩哔哩_bilibili$/i, "")
    .replace(/-哔哩哔哩$/i, "")
    .replace(/\s+-\s+YouTube$/i, "")
    .trim();
}

function siteName() {
  const metadata = document.querySelector("meta[property='og:site_name'], meta[name='application-name']");
  const value = metadata?.getAttribute("content")?.trim();
  if (value) return value;
  return location.hostname.replace(/^www\./i, "") || "网页视频";
}

function hasSelector(selectors) {
  return selectors.some((selector) => document.querySelector(selector));
}

function hasEpisodeSibling(direction) {
  const currentSelectors = [
    ".video-pod__item.active",
    ".video-pod__item[data-active='true']",
    ".ep-item.cursor",
    ".list-box li.on",
    ".bpx-player-episode-card--active",
  ];
  return currentSelectors.some((selector) => {
    const current = document.querySelector(selector);
    return Boolean(direction > 0 ? current?.nextElementSibling : current?.previousElementSibling);
  });
}

function clickFirst(selectors, { allowHidden = false } = {}) {
  const hiddenCandidates = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.offsetParent !== null || element.getClientRects().length > 0) {
        element.click();
        return true;
      }
      if (allowHidden && hiddenCandidates.length === 0) hiddenCandidates.push(element);
    }
  }
  if (hiddenCandidates.length > 0) {
    hiddenCandidates[0].click();
    return true;
  }
  return false;
}

async function clickPlayerFullscreen() {
  window.focus();
  const player = document.querySelector(".bpx-player, .bilibili-player, .bilibili-player-video, .plyr");
  player?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (clickFirst(FULLSCREEN_SELECTORS, { allowHidden: true })) return true;
  const video = videoElement();
  const target = video?.closest(".html5-video-player, .plyr, [class*='player']") || video;
  if (!target?.requestFullscreen) return false;
  try {
    await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

function navigateEpisode(direction) {
  if (clickFirst(direction > 0 ? NEXT_SELECTORS : PREVIOUS_SELECTORS)) return true;

  const currentSelectors = [
    ".video-pod__item.active",
    ".video-pod__item[data-active='true']",
    ".ep-item.cursor",
    ".list-box li.on",
    ".bpx-player-episode-card--active",
  ];
  for (const selector of currentSelectors) {
    const current = document.querySelector(selector);
    if (!current) continue;
    const sibling = direction > 0 ? current.nextElementSibling : current.previousElementSibling;
    const clickable = sibling?.matches("a") ? sibling : sibling?.querySelector("a, button, [role='button']") || sibling;
    if (clickable instanceof HTMLElement) {
      clickable.click();
      return true;
    }
  }
  return false;
}

function safeEpisodeUrl(element) {
  const link = element.matches?.("a[href]") ? element : element.querySelector?.("a[href]");
  if (!link) return null;
  try {
    const url = new URL(link.href, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function refreshEpisodes() {
  const elements = [];
  const seen = new Set();
  const seenUrls = new Set();
  for (const selector of EPISODE_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      const href = safeEpisodeUrl(element);
      if (!seen.has(element) && (!href || !seenUrls.has(href))) {
        seen.add(element);
        if (href) seenUrls.add(href);
        elements.push(element);
      }
      if (elements.length >= 200) break;
    }
    if (elements.length >= 200) break;
  }
  const targets = new Map();
  cachedEpisodes = elements.map((element, index) => {
    const href = safeEpisodeUrl(element);
    const title = String(
      element.getAttribute?.("title")
      || element.getAttribute?.("aria-label")
      || element.textContent
      || `第 ${index + 1} 集`,
    ).replace(/\s+/g, " ").trim().slice(0, 60);
    const fingerprint = `${href || ""}\n${title}`;
    let identity = episodeIdentities.get(element);
    if (!identity || identity.fingerprint !== fingerprint) {
      identity = { value: nextEpisodeIdentity, fingerprint };
      nextEpisodeIdentity += 1;
      episodeIdentities.set(element, identity);
    }
    const id = `e${identity.value}`;
    targets.set(id, { element, fingerprint });
    const current = Boolean(element.matches?.(
      ".active, .cursor, .on, [aria-current='true'], [data-active='true']",
    ));
    return { id, title, current };
  });
  episodeTargets = targets;
  episodesPageUrl = location.href;
}

function selectEpisode(value) {
  if (!value || value.pageUrl !== episodesPageUrl || value.pageUrl !== location.href) {
    return { handled: false, detail: "选集列表已过期，请刷新后重试" };
  }
  const target = episodeTargets.get(value.id);
  const element = target?.element;
  if (!element?.isConnected) return { handled: false, detail: "所选分集已不存在" };
  const currentTitle = String(
    element.getAttribute?.("title") || element.getAttribute?.("aria-label") || element.textContent || "",
  ).replace(/\s+/g, " ").trim().slice(0, 60);
  const currentFingerprint = `${safeEpisodeUrl(element) || ""}\n${currentTitle}`;
  if (currentFingerprint !== target.fingerprint) {
    return { handled: false, detail: "选集内容已变化，请刷新后重试" };
  }
  const clickable = element.matches?.("a, button, [role='button']")
    ? element
    : element.querySelector?.("a, button, [role='button']") || element;
  if (!(clickable instanceof HTMLElement)) return { handled: false, detail: "所选分集不可点击" };
  clickable.click();
  return { handled: true };
}

function resumeAt(value) {
  if (!value || typeof value.url !== "string" || !Number.isFinite(Number(value.time))) {
    return { handled: false, detail: "恢复时间点参数无效" };
  }
  const intended = new URL(value.url, location.href);
  const current = new URL(location.href);
  intended.hash = "";
  current.hash = "";
  if (intended.href !== current.href) {
    return { handled: false, detail: "仍在等待目标视频页面完成跳转" };
  }
  const video = videoElement();
  if (!video || video.readyState < 1) return { handled: false, detail: "仍在等待视频元数据" };
  const requested = Math.max(0, Number(value.time));
  video.currentTime = Math.min(Number.isFinite(video.duration) ? video.duration : requested, requested);
  return { handled: true };
}

async function execute(command) {
  if (command.type === "selectEpisode") return selectEpisode(command.value);
  if (command.type === "resumeAt") return resumeAt(command.value);
  const video = videoElement();
  if (!video && !["next", "previous", "fullscreen", "webFullscreen", "toggleDanmaku"].includes(command.type)) return false;

  switch (command.type) {
    case "toggle":
      if (video.paused) await video.play(); else video.pause();
      return true;
    case "play":
      await video.play();
      return true;
    case "pause":
      video.pause();
      return true;
    case "seekBy":
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + command.value));
      return true;
    case "seekTo":
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, command.value));
      return true;
    case "volume":
      video.volume = Math.min(1, Math.max(0, command.value));
      video.muted = false;
      return true;
    case "mute":
      video.muted = !video.muted;
      return true;
    case "speed":
      video.playbackRate = command.value;
      return true;
    case "toggleDanmaku":
      return clickFirst(DANMAKU_SELECTORS);
    case "fullscreen":
    case "webFullscreen":
      return clickPlayerFullscreen();
    case "next":
      return navigateEpisode(1);
    case "previous":
      return navigateEpisode(-1);
    default:
      return false;
  }
}

function reportState() {
  const video = videoElement();
  if (!video) return null;
  const state = {
      title: cachedTitle,
      siteName: cachedSiteName,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      volume: video.volume,
      muted: video.muted,
      paused: video.paused,
      playbackRate: video.playbackRate,
      url: location.href,
      capabilities: cachedCapabilities,
      episodes: cachedEpisodes,
      episodesPageUrl,
    };
  chrome.runtime.sendMessage({
    kind: "player-state",
    state,
  }).catch(() => {});
  return state;
}

function capabilities() {
  return {
    danmaku: hasSelector(DANMAKU_SELECTORS),
    fullscreen: true,
    next: hasSelector(NEXT_SELECTORS) || hasEpisodeSibling(1),
    previous: hasSelector(PREVIOUS_SELECTORS) || hasEpisodeSibling(-1),
  };
}

function currentState() {
  const video = videoElement();
  if (!video) return null;
  return {
    title: cachedTitle, siteName: cachedSiteName, currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    volume: video.volume, muted: video.muted, paused: video.paused,
    playbackRate: video.playbackRate, url: location.href, capabilities: cachedCapabilities,
    episodes: cachedEpisodes, episodesPageUrl,
  };
}

let reportTimer = null;
let scanTimer = null;
let attachedVideo = null;
let cachedSignature = "";
const mediaEvents = ["play", "pause", "ended", "durationchange", "volumechange", "ratechange", "seeked", "loadedmetadata", "emptied"];

function scheduleReport(delay = 120) {
  if (reportTimer !== null) return;
  reportTimer = setTimeout(() => { reportTimer = null; reportState(); }, delay);
}

function attachVideoEvents() {
  const video = videoElement();
  if (video === attachedVideo) return;
  if (attachedVideo) for (const event of mediaEvents) attachedVideo.removeEventListener(event, onMediaEvent);
  attachedVideo = video;
  if (attachedVideo) for (const event of mediaEvents) attachedVideo.addEventListener(event, onMediaEvent, { passive: true });
  scheduleReport(0);
}

function onMediaEvent() { scheduleReport(120); }

function scanPage() {
  cachedVideo = null;
  attachVideoEvents();
  if (!cachedVideo) {
    cachedEpisodes = [];
    episodeTargets = new Map();
    chrome.runtime.sendMessage({ kind: "player-unavailable" }).catch(() => {});
    return;
  }
  cachedTitle = cleanTitle();
  cachedSiteName = siteName();
  cachedCapabilities = capabilities();
  refreshEpisodes();
  const signature = [
    location.href,
    document.title,
    Boolean(document.querySelector("video")),
    hasSelector(NEXT_SELECTORS),
    hasSelector(PREVIOUS_SELECTORS),
    hasSelector(DANMAKU_SELECTORS),
  ].join("\n");
  if (signature !== cachedSignature) { cachedSignature = signature; scheduleReport(); }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === "player-probe") {
    sendResponse({ state: currentState() });
    return;
  }
  if (message?.kind !== "remote-command") return;
  execute(message.command)
    .then((result) => {
      reportState();
      sendResponse(typeof result === "object" ? result : { handled: result });
    })
    .catch(() => sendResponse({ handled: false }));
  return true;
});

scanPage();
// A short heartbeat keeps the server's five-second activity window alive for paused/background video.
setInterval(reportState, 1800);
// Discovery is intentionally much slower than the old full-DOM one-second scan.
setInterval(scanPage, 5000);
const observer = new MutationObserver(() => {
  if (scanTimer !== null) return;
  scanTimer = setTimeout(() => { scanTimer = null; scanPage(); }, 1200);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", () => scheduleReport(0));
window.addEventListener("hashchange", () => scheduleReport(0));
