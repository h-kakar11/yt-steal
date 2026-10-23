// Settings page. Every control is bound to one key in chrome.storage.local and saves on change.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

function fill(select, options) {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
}

function setupSelects() {
  fill($("naming"), NAMINGS);
  fill($("videoFormat"), VIDEO_FORMATS);
  fill($("videoQuality"), VIDEO_QUALITIES);
  fill($("audioFormat"), AUDIO_FORMATS);
  fill($("audioQuality"), AUDIO_QUALITIES);
  fill($("subtitles"), SUBTITLE_MODES);
  fill($("cookies"), BROWSERS);
  fill($("rateLimit"), RATE_LIMITS);
}

let savedTimer;
function flashSaved() {
  $("saved").textContent = "Saved";
  $("saved").classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1200);
}

function bind(input) {
  const key = input.dataset.key;
  const update = async () => {
    const value = input.type === "checkbox" ? input.checked
      : input.dataset.key === "concurrency" ? Number(input.value) : input.value.trim();
    if (key === "outputDir" && value && !/^([A-Za-z]:[\\/]|\\\\|\/)/.test(value)) {
      $("folderNote").className = "bad small";
      $("folderNote").textContent = "Use a full path, like D:\\Videos";
      return;
    }
    await setSettings({ [key]: value });
    $("folderNote").textContent = "";
    flashSaved();
  };
  input.addEventListener("change", update);
}

async function loadValues() {
  const s = await getSettings();
  document.querySelectorAll("[data-key]").forEach((input) => {
    const v = s[input.dataset.key];
    if (input.type === "checkbox") input.checked = !!v;
    else input.value = v ?? "";
  });
}

async function showShortcuts() {
  const labels = { "download-video": "Download the video you're watching", "download-audio": "Download only the audio" };
  const cmds = (await chrome.commands.getAll()).filter((c) => labels[c.name]);
  $("shortcuts").replaceChildren(...cmds.map((c) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { textContent: labels[c.name] }));
    li.append(Object.assign(document.createElement("kbd"), { textContent: c.shortcut || "not set" }));
    return li;
  }));
}

async function showEngine() {
  const r = await send({ type: "status" });
  const dl = $("engine");
  if (!r.ok) {
    dl.replaceChildren(...kv("Helper", r.missing ? "Not set up yet" : "Not reachable", "bad"));
    $("updateEngine").disabled = true;
    $("engineMsg").textContent = r.missing ? MISSING_HELPER : r.error;
    return;
  }
  const d = r.data;
  $("updateEngine").disabled = !d.ytdlpFound;
  dl.replaceChildren(
    ...kv("Helper version", d.helper),
    ...kv("yt-dlp", d.ytdlpFound ? d.ytdlp : "missing — run the setup file again", d.ytdlpFound ? "" : "bad"),
    ...kv("ffmpeg", d.ffmpeg ? "installed" : "missing — needed for MP3, MP4 merging and subtitles", d.ffmpeg ? "ok" : "bad"),
    ...kv("JavaScript runtime", d.deno ? "installed" : "not found (YouTube may need it)", d.deno ? "ok" : ""),
    ...kv("Helper data folder", d.dataDir),
  );
  $("folderNote").textContent = `Empty means ${d.defaultOutputDir}`;
  $("outputDir").placeholder = d.defaultOutputDir;
}

function kv(label, value, cls = "") {
  return [Object.assign(document.createElement("dt"), { textContent: label }),
    Object.assign(document.createElement("dd"), { textContent: value, className: cls })];
}

$("browse").onclick = async () => {
  const r = await send({ type: "pick-folder" });
  if (!r.ok) {
    $("folderNote").className = "bad small";
    return ($("folderNote").textContent = r.error);
  }
  if (r.data.path) {
    $("outputDir").value = r.data.path;
    await setSettings({ outputDir: r.data.path });
    flashSaved();
  }
};
$("resetFolder").onclick = async () => {
  $("outputDir").value = "";
  await setSettings({ outputDir: "" });
  flashSaved();
};
$("openFolder").onclick = async () => {
  const status = await send({ type: "status" });
  const folder = (await getSettings()).outputDir || status.data?.defaultOutputDir;
  const r = await send({ type: "reveal", op: "open-folder", path: folder });
  if (!r.ok) $("folderNote").textContent = r.error;
};
$("openShortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
$("recheck").onclick = showEngine;
$("updateEngine").onclick = async () => {
  $("updateEngine").disabled = true;
  $("engineMsg").className = "msg";
  $("engineMsg").textContent = "Updating… this can take a minute.";
  const r = await send({ type: "update-engine" });
  $("engineMsg").className = r.ok ? "msg ok" : "msg bad";
  $("engineMsg").textContent = r.ok ? r.data.message : r.error;
  showEngine();
};
$("reset").onclick = async () => {
  if (!confirm("Reset every Ytsteal setting to its default?")) return;
  await chrome.storage.local.set(DEFAULTS);
  await loadValues();
  flashSaved();
};

document.querySelectorAll("[data-key]").forEach(bind);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") loadValues();
});

setupSelects();
loadValues();
showShortcuts();
showEngine();
