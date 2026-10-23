// Service worker: talks to the helper over native messaging, keeps the job list in storage,
// and shows progress on YouTube pages and notifications when things finish.
importScripts("lib/common.js");

const HOST = "com.ytsteal.helper";
const HISTORY_MAX = 300;
const ICON = "icons/icon-128.png";

let port = null;
const waiting = new Map(); // request id -> resolve(reply)
let queue = Promise.resolve(); // serializes storage read-modify-write
let seq = 0;

// ---- storage: active jobs and history -----------------------------------------------------

function mutate(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function loadActive() {
  return (await chrome.storage.local.get({ active: {} })).active;
}

async function saveActive(active) {
  await chrome.storage.local.set({ active });
  const n = Object.keys(active).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
}

async function addHistory(job) {
  const { history } = await chrome.storage.local.get({ history: [] });
  history.unshift(job);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_MAX) });
}

function newJobId() {
  return "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Called when the helper goes away: nothing active can finish now. Callers queue this with
// mutate(); it must not queue anything itself, or the queue waits on itself.
async function failOrphansNow(message) {
  const active = await loadActive();
  const ids = Object.keys(active);
  if (!ids.length) return;
  for (const id of ids) {
    await finish(active, id, { status: "failed", message, details: "helper disconnected" });
  }
  await saveActive(active);
}

// Moves a job from active to history and tells the user it's over.
async function finish(active, id, patch) {
  const job = active[id];
  if (!job) return;
  delete active[id];
  Object.assign(job, patch, { finishedAt: Date.now(), percent: null, speed: null, eta: null });
  await addHistory(job);
  toast(job);
  if (job.status !== "cancelled" && (await getSettings()).notifications) notify(job);
}

// ---- native messaging -----------------------------------------------------------------------

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(onDisconnect);
  return port;
}

function onDisconnect() {
  const err = chrome.runtime.lastError?.message || "";
  port = null;
  const missing = /not found/i.test(err);
  for (const resolve of waiting.values()) {
    resolve({ ok: false, missing, error: missing ? MISSING_HELPER : "Lost connection to the helper." });
  }
  waiting.clear();
  mutate(() => failOrphansNow(missing ? MISSING_HELPER : "Lost connection to Ytsteal's helper. Click Retry to try again."));
}

function onHostMessage(msg) {
  if (msg.type === "reply") {
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg);
    }
    if (!msg.ok) mutate(() => failIfActive(msg.id, msg.error));
    return;
  }
  if (msg.type === "event") mutate(() => applyEvent(msg));
}

async function failIfActive(id, message) {
  const active = await loadActive();
  if (!active[id]) return;
  await finish(active, id, { status: "failed", message, details: "" });
  await saveActive(active);
}

// One request, one reply. Used for status, inspect and the other quick calls.
function request(msg) {
  const id = "q" + ++seq;
  return new Promise((resolve) => {
    try {
      connect();
      waiting.set(id, resolve);
      port.postMessage({ ...msg, id });
    } catch (e) {
      waiting.delete(id);
      resolve({ ok: false, error: "Couldn't reach the helper: " + e.message });
    }
  });
}

// Fire-and-forget: the reply (or error) arrives as a message for the job id.
function post(msg) {
  connect();
  port.postMessage(msg);
}

async function applyEvent(msg) {
  const active = await loadActive();
  const job = active[msg.id];
  if (!job) return;
  switch (msg.event) {
    case "queued":
      job.status = "queued";
      job.stage = "Waiting for a free slot";
      break;
    case "running":
      job.status = "running";
      job.stage = msg.stage || "Starting";
      job.title = msg.title || job.title;
      break;
    case "progress":
      job.status = "running";
      job.stage = msg.stage;
      job.title = msg.title || job.title;
      job.percent = msg.percent ?? null;
      job.speed = msg.speed ?? null;
      job.eta = msg.eta ?? null;
      break;
    case "done":
      await finish(active, msg.id, {
        status: "done", file: msg.file, sizeBytes: msg.sizeBytes, title: msg.title || job.title,
        uploader: msg.uploader, durationSeconds: msg.durationSeconds, thumbnail: msg.thumbnail,
      });
      return saveActive(active);
    case "failed":
      await finish(active, msg.id, { status: "failed", message: msg.message, details: msg.details || "" });
      return saveActive(active);
    case "cancelled":
      await finish(active, msg.id, { status: "cancelled" });
      return saveActive(active);
  }
  active[msg.id] = job;
  await saveActive(active);
  toast(job);
}

// ---- starting downloads -------------------------------------------------------------------

// items: [{ url, kind, format, quality, audioQuality, playlistFolder }]. Returns the jobs made.
async function startDownloads(items, tabId) {
  const settings = await getSettings();
  const jobs = items.map((item) => {
    const job = {
      id: newJobId(), url: item.url, status: "queued", stage: "Waiting for a free slot",
      kind: item.kind || "video", title: item.title || item.url, uploader: "", thumbnail: "",
      percent: null, speed: null, eta: null, createdAt: Date.now(), tabId: tabId || null,
      playlistFolder: item.playlistFolder || "",
      options: buildOptions(settings, item),
    };
    job.format = job.options.format;
    return job;
  });
  await mutate(async () => {
    const active = await loadActive();
    for (const job of jobs) active[job.id] = job;
    await saveActive(active);
  });
  for (const job of jobs) {
    post({ id: job.id, op: "download", url: job.url, options: job.options });
  }
  return jobs;
}

async function startPlaylist(url, tabId) {
  const reply = await request({ op: "inspect", url, playlist: true });
  if (!reply.ok) return reply;
  const pl = reply.data;
  if (!pl.count) return { ok: false, error: "This playlist has no videos Ytsteal can download." };
  await startDownloads(pl.entries.map((e) => ({ url: e.url, title: e.title, playlistFolder: pl.title })), tabId);
  return { ok: true, count: pl.count, title: pl.title, truncated: pl.truncated, unavailable: pl.unavailable };
}

// ---- page feedback -----------------------------------------------------------------------

function toast(job) {
  if (!job.tabId) return;
  const state = job.status === "done" ? "ok" : job.status === "failed" || job.status === "cancelled" ? "bad" : "run";
  const text = job.status === "done" ? job.title
    : job.status === "failed" ? job.message : job.status === "cancelled" ? "Cancelled" : job.title || "Preparing";
  const head = job.status === "done" ? "Download complete"
    : job.status === "failed" ? "Download failed" : job.status === "cancelled" ? "Cancelled"
    : job.percent != null ? `${job.stage} ${Math.round(job.percent)}%` : job.stage || "Downloading";
  chrome.tabs.sendMessage(job.tabId, { type: "toast", head, text, state, percent: job.percent })
    .catch(() => {});
}

function notify(job) {
  const done = job.status === "done";
  chrome.notifications.create(job.id, {
    type: "basic", iconUrl: ICON,
    title: done ? "Download complete" : "Download failed",
    message: done ? job.title : job.message || "Something went wrong.",
    buttons: done && job.file ? [{ title: "Show in folder" }] : [],
    priority: 0,
  });
}

chrome.notifications.onClicked.addListener(revealJob);
chrome.notifications.onButtonClicked.addListener((id) => revealJob(id));

async function revealJob(id) {
  const { history } = await chrome.storage.local.get({ history: [] });
  const job = history.find((j) => j.id === id);
  if (job?.file) request({ op: "reveal", path: job.file });
}

// ---- entry points -------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = videoUrl(tab?.url || "");
  if (!url) {
    chrome.notifications.create({ type: "basic", iconUrl: ICON, title: "Ytsteal",
      message: "Open a YouTube video, then press the shortcut again." });
    return;
  }
  startDownloads([{ url, kind: command === "download-audio" ? "audio" : "video" }], tab.id);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ytsteal", title: "Ytsteal", contexts: ["link", "page", "video"] });
    chrome.contextMenus.create({ id: "ytsteal-video", parentId: "ytsteal", title: "Download video", contexts: ["link", "page", "video"] });
    chrome.contextMenus.create({ id: "ytsteal-audio", parentId: "ytsteal", title: "Download audio only", contexts: ["link", "page", "video"] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const href = info.linkUrl || info.pageUrl || tab?.url || "";
  const kind = info.menuItemId === "ytsteal-audio" ? "audio" : "video";
  const single = videoUrl(href);
  if (single) return startDownloads([{ url: single, kind }], tab?.id);
  const list = playlistUrl(href);
  if (list) return startPlaylist(list, tab?.id);
  chrome.notifications.create({ type: "basic", iconUrl: ICON, title: "Ytsteal",
    message: "That isn't a YouTube video or playlist link." });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id || msg.tabId;
  const run = {
    status: () => request({ op: "status" }),
    inspect: () => request({ op: "inspect", url: msg.url, playlist: !!msg.playlist }),
    download: async () => {
      const items = msg.items || [{ url: msg.url, kind: msg.kind, format: msg.format, quality: msg.quality, audioQuality: msg.audioQuality }];
      if (!items.length || items.some((i) => !i.url)) return { ok: false, error: "No link to download." };
      const jobs = await startDownloads(items, tabId);
      return { ok: true, count: jobs.length };
    },
    playlist: () => startPlaylist(msg.url, tabId),
    cancel: async () => {
      const active = await loadActive();
      const job = active[msg.id];
      if (!job) return { ok: false, error: "That download already finished." };
      post({ id: "c" + msg.id, op: "cancel", job: msg.id });
      return { ok: true };
    },
    retry: async () => {
      const { history } = await chrome.storage.local.get({ history: [] });
      const old = history.find((j) => j.id === msg.id);
      if (!old) return { ok: false, error: "Can't find that download." };
      const jobs = await startDownloads([{ url: old.url, kind: old.kind, format: old.format,
        quality: old.options?.quality, audioQuality: old.options?.audioQuality,
        playlistFolder: old.playlistFolder, title: old.title }], old.tabId);
      await mutate(async () => {
        const { history: h } = await chrome.storage.local.get({ history: [] });
        await chrome.storage.local.set({ history: h.filter((j) => j.id !== msg.id) });
      });
      return { ok: true, count: jobs.length };
    },
    reveal: () => request({ op: msg.op || "reveal", path: msg.path }),
    "pick-folder": () => request({ op: "pick-folder" }),
    "update-engine": () => request({ op: "update" }),
    "clear-history": () => mutate(() => chrome.storage.local.set({ history: [] })).then(() => ({ ok: true })),
    "remove-history": () => mutate(async () => {
      const { history } = await chrome.storage.local.get({ history: [] });
      await chrome.storage.local.set({ history: history.filter((j) => j.id !== msg.id) });
    }).then(() => ({ ok: true })),
  }[msg.type];
  if (!run) return;
  Promise.resolve().then(run).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Anything still "active" when the worker starts was running under a port that no longer exists.
mutate(() => failOrphansNow("Ytsteal was interrupted. Click Retry to download it again."));
