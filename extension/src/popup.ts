import type { PopupStatus } from "./types";

const $ = (id: string) => document.getElementById(id)!;
const SUPPORTED = /(^|\.)(netflix\.com|hotstar\.com|primevideo\.com|amazon\.(in|com)|sonyliv\.com|zee5\.com|jiocinema\.com|youtube\.com)$/;

const render = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = (await chrome.runtime.sendMessage({ type: "popup:status" })) as PopupStatus;
  const host = tab?.url ? new URL(tab.url).hostname : "";
  const supported = SUPPORTED.test(host);
  const thisTabLinked = status.linked && status.linkedTabId === tab?.id;

  const dot = status.linked ? (status.connected ? "on" : "warn") : "";
  $("status").innerHTML = "";
  const line = (label: string, value: string, cls = "") => {
    const row = document.createElement("div");
    row.className = "row";
    const l = document.createElement("span");
    if (cls !== "skip") {
      const d = document.createElement("span");
      d.className = `dot ${cls}`;
      l.appendChild(d);
    }
    l.appendChild(document.createTextNode(label));
    const v = document.createElement("span");
    v.textContent = value;
    row.append(l, v);
    $("status").appendChild(row);
  };
  if (status.linked) {
    line(status.connected ? "Connected" : "Connecting…", status.controller ? "You're host" : "Following host", dot);
    if (status.userName) line("Signed in as", status.userName, "skip");
  } else {
    line("Not linked", supported ? host.replace(/^www\./, "") : "Open a streaming site", "");
  }

  ($("link") as HTMLButtonElement).disabled = !supported || thisTabLinked;
  $("link").textContent = thisTabLinked ? "This tab is linked" : status.linked ? "Move link to this tab" : "Link this tab to my room";
  $("unlink").hidden = !status.linked;
  $("error").textContent = status.error ?? "";
};

$("link").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  ($("link") as HTMLButtonElement).disabled = true;
  const result = (await chrome.runtime.sendMessage({ type: "popup:link", tabId: tab.id })) as { ok: boolean; error?: string };
  if (!result.ok) $("error").textContent = result.error ?? "Couldn't link";
  setTimeout(render, 600);
});

$("unlink").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup:unlink" });
  render();
});

render();
setInterval(render, 2000);
