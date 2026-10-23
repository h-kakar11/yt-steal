// Runs on YouTube: a Download button next to Like/Share, and the progress toast.
const sendMsg = (m) => chrome.runtime.sendMessage(m).catch(() => ({ ok: false, error: "Ytsteal was updated. Reload this page." }));

const CSS = `
#ytsteal-wrap{position:relative;display:inline-flex;margin-left:8px}
#ytsteal-btn,#ytsteal-caret{height:36px;border:0;background:var(--yt-spec-badge-chip-background,#2a2a2a);
  color:var(--yt-spec-text-primary,#fff);font:500 14px Roboto,Arial,sans-serif;cursor:pointer}
#ytsteal-btn{padding:0 16px;border-radius:18px 0 0 18px}
#ytsteal-caret{width:30px;border-radius:0 18px 18px 0;border-left:1px solid #0003;font-size:11px}
#ytsteal-btn:hover,#ytsteal-caret:hover{filter:brightness(1.15)}
#ytsteal-menu{position:absolute;top:42px;left:0;z-index:2147483647;min-width:230px;padding:6px 0;border-radius:12px;
  background:#282828;color:#fff;box-shadow:0 8px 24px #0009;font:14px Roboto,Arial,sans-serif}
#ytsteal-menu[hidden]{display:none}
#ytsteal-menu button{display:block;width:100%;padding:10px 16px;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit}
#ytsteal-menu button:hover{background:#ffffff1a}
#ytsteal-menu small{display:block;color:#aaa;font-size:12px}
#ytsteal-toast{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:300px;padding:12px 14px;border-radius:12px;
  font:13px system-ui,sans-serif;color:#fff;background:#1f1f1fee;box-shadow:0 4px 20px #0008;backdrop-filter:blur(8px);
  transform:translateY(20px);opacity:0;transition:.25s}
#ytsteal-toast.on{transform:none;opacity:1}
#ytsteal-toast b{display:block;font-size:12px;opacity:.7;margin-bottom:2px}
#ytsteal-toast span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
#ytsteal-toast i{display:block;height:4px;margin-top:8px;border-radius:2px;background:#fff3;overflow:hidden}
#ytsteal-toast i u{display:block;height:100%;width:0;background:#3ea6ff;transition:width .4s}
#ytsteal-toast.ok i u{background:#2ba640}#ytsteal-toast.bad i u{background:#e5484d}`;

// Styles go in once, up front, so the button and menu look right before any toast appears.
(document.head || document.documentElement).append(Object.assign(document.createElement("style"), { textContent: CSS }));

// ---- toast -------------------------------------------------------------------------------
let toastEl, toastTimer;

// state: "run" | "ok" | "bad"; percent null = unknown (the bar pulses)
function toast(head, text, state = "run", percent = null) {
  if (!toastEl) {
    toastEl = document.body.appendChild(document.createElement("div"));
    toastEl.id = "ytsteal-toast";
    toastEl.innerHTML = "<b></b><span></span><i><u></u></i>";
    requestAnimationFrame(() => toastEl.classList.add("on"));
  }
  toastEl.className = `on ${state}`;
  toastEl.children[0].textContent = head;
  toastEl.children[1].textContent = text;
  const width = state === "run" && percent == null ? "8%" : `${state === "run" ? percent : 100}%`;
  toastEl.querySelector("u").style.width = width;
  clearTimeout(toastTimer);
  if (state !== "run") toastTimer = setTimeout(() => {
    toastEl?.classList.remove("on");
    setTimeout(() => { toastEl?.remove(); toastEl = null; }, 300);
  }, 4000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "toast") toast(msg.head, msg.text, msg.state, msg.percent);
});

// ---- button ------------------------------------------------------------------------------
async function download(kind) {
  const url = videoUrl(location.href);
  if (!url) return toast("Can't download", "Open a video first.", "bad");
  closeMenu();
  const r = await sendMsg({ type: "download", url, kind });
  if (!r.ok) toast("Can't download", r.error || "Something went wrong.", "bad");
}

async function downloadPlaylist() {
  const url = playlistUrl(location.href);
  closeMenu();
  toast("Reading playlist...", "This takes a few seconds", "run");
  const r = await sendMsg({ type: "playlist", url });
  if (!r.ok) return toast("Can't download", r.error || "Something went wrong.", "bad");
  toast(`Queued ${r.count} videos`, r.title + (r.truncated ? " (first 500)" : ""), "ok");
}

function closeMenu() {
  document.getElementById("ytsteal-menu")?.setAttribute("hidden", "");
}

function buildButton(row) {
  const wrap = document.createElement("span");
  wrap.id = "ytsteal-wrap";
  wrap.innerHTML = `<button id="ytsteal-btn" title="Download this video (Alt+Shift+D)">Download</button>
    <button id="ytsteal-caret" title="More download options">&#9662;</button>
    <div id="ytsteal-menu" hidden>
      <button data-act="video">Video <small>Saved to your Downloads folder</small></button>
      <button data-act="audio">Audio only <small>Saved as an audio file</small></button>
      <button data-act="playlist" hidden>Whole playlist <small></small></button>
    </div>`;
  const menu = wrap.querySelector("#ytsteal-menu");
  wrap.querySelector("#ytsteal-btn").onclick = () => download("video");
  wrap.querySelector("#ytsteal-caret").onclick = (e) => {
    e.stopPropagation();
    const playlist = playlistUrl(location.href);
    const pl = menu.querySelector('[data-act="playlist"]');
    pl.hidden = !playlist;
    menu.toggleAttribute("hidden");
  };
  menu.onclick = (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "video") download("video");
    if (act === "audio") download("audio");
    if (act === "playlist") downloadPlaylist();
  };
  row.append(wrap);
}

document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#ytsteal-wrap")) closeMenu();
});

// YouTube re-renders its page on navigation, so keep checking for the row.
setInterval(() => {
  const row = document.querySelector("#top-level-buttons-computed");
  if (!row || location.pathname !== "/watch" || row.querySelector("#ytsteal-wrap")) return;
  buildButton(row);
}, 1500);
