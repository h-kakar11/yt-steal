// Shared by the service worker, the YouTube content script and the popup/options pages.
// Plain globals on purpose: importScripts and content scripts can't use ES modules.

const DEFAULTS = {
  outputDir: "",            // "" = the helper's default folder (Downloads\Ytsteal)
  videoFormat: "mp4",
  videoQuality: "best",
  audioFormat: "mp3",
  audioQuality: "320",
  naming: "title",          // title | title-id | channel-title
  subfolder: "none",        // none | channel
  subtitles: "none",        // none | en | auto-en
  saveThumbnail: false,
  embedThumbnail: true,
  sponsorBlock: false,
  cookies: "",              // "" or a browser to borrow sign-in from
  rateLimit: "",
  concurrency: 2,
  notifications: true,
};

const VIDEO_FORMATS = [["mp4", "MP4 (plays everywhere)"], ["mkv", "MKV"], ["webm", "WebM"]];
const AUDIO_FORMATS = [["mp3", "MP3"], ["m4a", "M4A (AAC)"], ["opus", "Opus"], ["flac", "FLAC (lossless)"], ["wav", "WAV (lossless)"]];
const VIDEO_QUALITIES = [["best", "Best available"], ["2160p", "4K (2160p)"], ["1440p", "1440p"], ["1080p", "1080p HD"], ["720p", "720p"], ["480p", "480p"], ["360p", "360p"]];
const AUDIO_QUALITIES = [["best", "Best"], ["320", "320 kbps"], ["192", "192 kbps"], ["128", "128 kbps"]];
const NAMINGS = [["title", "Video title"], ["title-id", "Video title + ID"], ["channel-title", "Channel - Video title"]];
const SUBTITLE_MODES = [["none", "Off"], ["en", "English subtitles (.srt file)"], ["auto-en", "English, including auto-generated"]];
const RATE_LIMITS = [["", "No limit"], ["1M", "1 MB/s"], ["5M", "5 MB/s"], ["10M", "10 MB/s"], ["25M", "25 MB/s"]];
const BROWSERS = [["", "Off"], ["chrome", "Chrome"], ["edge", "Edge"], ["brave", "Brave"], ["firefox", "Firefox"]];

const RELEASES_URL = "https://github.com/h-kakar11/ytgrab/releases/latest";

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

function setSettings(patch) {
  return chrome.storage.local.set(patch);
}

// Canonical watch URL for a YouTube video page or link, or null when it isn't one video.
function videoUrl(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    let id = null;
    if (host === "youtu.be") id = u.pathname.slice(1, 12);
    else if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else id = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];
    } else return null;
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch {
    return null;
  }
}

// Canonical playlist URL for any YouTube link carrying list=, or null. YouTube "Mix" radios
// (RD...) are endless and aren't playlists, so they're skipped.
function playlistUrl(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    const id = u.searchParams.get("list");
    if (!id || (/^RD/.test(id) && !/^RDCLAK/.test(id))) return null;
    return `https://www.youtube.com/playlist?list=${id}`;
  } catch {
    return null;
  }
}

function isYouTube(href) {
  try {
    return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(href).hostname);
  } catch {
    return false;
  }
}

// What the helper receives for one download. overrides come from the popup or menu.
function buildOptions(settings, overrides = {}) {
  const kind = overrides.kind || "video";
  return {
    outputDir: settings.outputDir,
    kind,
    format: overrides.format || (kind === "audio" ? settings.audioFormat : settings.videoFormat),
    quality: overrides.quality || settings.videoQuality,
    audioQuality: overrides.audioQuality || settings.audioQuality,
    naming: settings.naming,
    subfolder: settings.subfolder,
    subtitles: settings.subtitles,
    saveThumbnail: settings.saveThumbnail,
    embedThumbnail: settings.embedThumbnail,
    sponsorBlock: settings.sponsorBlock,
    cookies: settings.cookies,
    rateLimit: settings.rateLimit,
    concurrency: settings.concurrency,
    playlistFolder: overrides.playlistFolder || "",
  };
}

function fmtBytes(n) {
  if (!n) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1e3)) + " KB";
}

function fmtDuration(sec) {
  if (!sec) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function fmtSpeed(bps) {
  return bps ? fmtBytes(bps) + "/s" : "";
}

function fmtEta(sec) {
  if (sec == null || sec < 0) return "";
  return sec < 60 ? `${Math.round(sec)}s left` : `${Math.round(sec / 60)} min left`;
}

// Friendly relative time for history rows.
function fmtWhen(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return Math.round(d / 60e3) + " min ago";
  if (d < 86400e3) return Math.round(d / 3600e3) + " h ago";
  return new Date(ms).toLocaleDateString();
}

const MISSING_HELPER =
  "Ytsteal needs a one-time setup on this computer. Download the setup file, run it, then reload this page.";
