// The toolbar popup: the current video, pasted links, live downloads and history.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let current = { url: null, playlist: null, info: null };
let settings = null;

// ---- tabs --------------------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  });
  for (const m of document.querySelectorAll("main")) m.hidden = m.id !== name;
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("settings").onclick = () => chrome.runtime.openOptionsPage();

// ---- helper status -------------------------------------------------------------------------
async function checkHelper() {
  const pill = $("helper");
  const r = await send({ type: "status" });
  const needsSetup = !r.ok && r.missing;
  $("setup").hidden = !needsSetup;
  $("setupText").textContent = needsSetup ? MISSING_HELPER : r.error || "";
  if (r.ok) {
    pill.textContent = r.data.ytdlpFound ? "Ready" : "Engine missing";
    pill.className = "pill " + (r.data.ytdlpFound ? "ok" : "bad");
  } else {
    pill.textContent = needsSetup ? "Setup needed" : "Helper offline";
    pill.className = "pill bad";
  }
  return r;
}
$("getSetup").onclick = () => chrome.tabs.create({ url: RELEASES_URL });
$("recheck").onclick = async () => {
  await checkHelper();
  loadCurrent();
};

// ---- current page ----------------------------------------------------------------------------
let kind = "video";

function fillSelects() {
  const formats = kind === "audio" ? AUDIO_FORMATS : VIDEO_FORMATS;
  const quals = kind === "audio" ? AUDIO_QUALITIES : VIDEO_QUALITIES;
  $("format").replaceChildren(...formats.map(([v, t]) => el("option", { value: v, textContent: t })));
  $("format").value = kind === "audio" ? settings.audioFormat : settings.videoFormat;
  $("quality").replaceChildren(...quals.map(([v, t]) => el("option", { value: v, textContent: t })));
  $("quality").value = kind === "audio" ? settings.audioQuality : settings.videoQuality;
  $("qualityLabel").firstChild.textContent = kind === "audio" ? "Bitrate " : "Quality ";
}

document.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => {
  kind = b.dataset.kind;
  document.querySelectorAll("[data-kind]").forEach((x) => {
    x.classList.toggle("on", x === b);
    x.setAttribute("aria-checked", x === b);
  });
  fillSelects();
}));

async function loadCurrent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  const single = videoUrl(url), list = playlistUrl(url);
  current = { url: single, playlist: list, tabId: tab?.id };
  $("now").hidden = !single;
  $("playlist").hidden = !!single || !list;
  $("idle").hidden = !!single || !!list;
  if (single) return loadVideo(single);
  if (list) return loadPlaylist(list);
}

async function loadVideo(url) {
  $("title").textContent = "Loading…";
  $("uploader").textContent = "";
  $("thumb").hidden = true;
  $("downloadNow").disabled = true;
  const r = await send({ type: "inspect", url, playlist: false });
  if (url !== current.url) return;
  if (!r.ok) {
    $("title").textContent = "Couldn't read this video";
    $("nowMsg").className = "msg bad";
    $("nowMsg").textContent = r.error;
    return;
  }
  current.info = r.data;
  $("title").textContent = r.data.title;
  $("uploader").textContent = [r.data.uploader, fmtDuration(r.data.durationSeconds)].filter(Boolean).join(" · ");
  if (r.data.thumbnail) {
    $("thumb").src = r.data.thumbnail;
    $("thumb").hidden = false;
  }
  $("downloadNow").disabled = false;
  $("nowMsg").textContent = "";
}

async function loadPlaylist(url) {
  $("plTitle").textContent = "Loading playlist…";
  $("downloadAll").disabled = true;
  const r = await send({ type: "inspect", url, playlist: true });
  if (url !== current.playlist) return;
  if (!r.ok) {
    $("plTitle").textContent = "Couldn't read this playlist";
    $("plMsg").className = "msg bad";
    $("plMsg").textContent = r.error;
    return;
  }
  current.plInfo = r.data;
  $("plTitle").textContent = r.data.title;
  const extra = r.data.truncated ? " (first 500 are included)" : "";
  $("plInfo").textContent = `${r.data.count} videos${extra}`;
  $("downloadAll").disabled = r.data.count === 0;
  $("downloadAll").textContent = `Download all ${r.data.count}`;
}

$("downloadNow").onclick = async () => {
  $("downloadNow").disabled = true;
  const r = await send({
    type: "download", url: current.url, tabId: current.tabId, kind,
    format: $("format").value, quality: kind === "video" ? $("quality").value : undefined,
    audioQuality: kind === "audio" ? $("quality").value : undefined,
  });
  $("downloadNow").disabled = false;
  $("nowMsg").className = r.ok ? "msg ok" : "msg bad";
  $("nowMsg").textContent = r.ok ? "Added to your downloads." : r.error;
  if (r.ok) showTab("active");
};

$("downloadAll").onclick = async () => {
  $("downloadAll").disabled = true;
  $("plMsg").className = "msg";
  $("plMsg").textContent = "Adding videos…";
  const r = await send({ type: "playlist", url: current.playlist, tabId: current.tabId });
  $("plMsg").className = r.ok ? "msg ok" : "msg bad";
  $("plMsg").textContent = r.ok ? `Added ${r.count} videos from “${r.title}”.` : r.error;
  $("downloadAll").disabled = false;
  if (r.ok) showTab("active");
};

// ---- pasted links -----------------------------------------------------------------------
$("pasteGo").onclick = async () => {
  const urls = $("paste").value.split(/\s+/).filter(Boolean);
  if (!urls.length) {
    $("pasteMsg").className = "msg bad";
    return ($("pasteMsg").textContent = "Paste at least one link first.");
  }
  const bad = urls.filter((u) => !/^https?:\/\//.test(u));
  if (bad.length) {
    $("pasteMsg").className = "msg bad";
    return ($("pasteMsg").textContent = `These don't look like links: ${bad.slice(0, 2).join(", ")}`);
  }
  const k = $("pasteKind").value;
  const r = await send({ type: "download", items: urls.map((url) => ({ url, kind: k })) });
  $("pasteMsg").className = r.ok ? "msg ok" : "msg bad";
  $("pasteMsg").textContent = r.ok ? `Added ${r.count} download${r.count === 1 ? "" : "s"}.` : r.error;
  if (r.ok) {
    $("paste").value = "";
    showTab("active");
  }
};

// ---- jobs ---------------------------------------------------------------------------------
function activeItem(j) {
  const pct = j.percent;
  const details = [j.stage, pct != null ? Math.round(pct) + "%" : "", fmtSpeed(j.speed), fmtEta(j.eta)]
    .filter(Boolean).join(" · ");
  return el("div", { className: "job" },
    el("div", { className: "job-title", textContent: j.title || j.url, title: j.title || j.url }),
    el("div", { className: "bar" + (pct == null ? " pulse" : ""), }, el("i", { style: pct != null ? `width:${pct}%` : "" })),
    el("div", { className: "row" },
      el("small", { textContent: details }),
      el("button", { className: "link muted", textContent: "Cancel", onclick: () => send({ type: "cancel", id: j.id }) })));
}

function historyItem(j) {
  const ok = j.status === "done";
  const detail = ok ? [j.format?.toUpperCase(), fmtBytes(j.sizeBytes), fmtWhen(j.finishedAt)].filter(Boolean).join(" · ")
    : j.status === "cancelled" ? `Cancelled · ${fmtWhen(j.finishedAt)}`
    : `${j.message || "Failed"}`;
  const actions = el("div", { className: "actions" });
  const add = (text, fn, cls = "link") => actions.append(el("button", { className: cls, textContent: text, onclick: fn }));
  if (ok) {
    add("Show in folder", () => send({ type: "reveal", path: j.file }));
    add("Open", () => send({ type: "reveal", path: j.file, op: "open" }));
  }
  if (!ok) add("Retry", () => send({ type: "retry", id: j.id }));
  add("Remove", () => send({ type: "remove-history", id: j.id }), "link muted");
  return el("div", { className: "job" },
    el("div", { className: "job-title", textContent: j.title || j.url, title: j.title || j.url }),
    el("small", { className: ok ? "" : "bad", textContent: detail }),
    actions);
}

let historyFilter = "";

async function render() {
  const { active, history } = await chrome.storage.local.get({ active: {}, history: [] });
  const jobs = Object.values(active).sort((a, b) => a.createdAt - b.createdAt);
  $("activeList").replaceChildren(...jobs.map(activeItem));
  $("noActive").hidden = jobs.length > 0;
  $("activeCount").hidden = jobs.length === 0;
  $("activeCount").textContent = jobs.length;

  const q = historyFilter.toLowerCase();
  const shown = history.filter((j) => !q || (j.title || j.url).toLowerCase().includes(q));
  $("historyList").replaceChildren(...shown.map(historyItem));
  $("noHistory").hidden = shown.length > 0;
  $("noHistory").textContent = history.length ? "Nothing matches your search." : "No downloads yet.";
  $("clearHistory").hidden = history.length === 0;
}

$("search").oninput = (e) => {
  historyFilter = e.target.value;
  render();
};
$("clearHistory").onclick = () => {
  if (confirm("Clear the download list? Your files are not deleted.")) send({ type: "clear-history" });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.active || changes.history)) render();
});

// ---- start ----------------------------------------------------------------------------------
(async function init() {
  settings = await getSettings();
  kind = "video";
  fillSelects();
  await checkHelper();
  await loadCurrent();
  render();
})();
