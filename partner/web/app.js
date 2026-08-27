const thread = document.getElementById("thread");
const empty = document.getElementById("empty");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const metaEl = document.getElementById("meta");
const resetBtn = document.getElementById("reset");
const suggestionsEl = document.getElementById("suggestions");

let conversationId = null;
let busy = false;

/* ---------- rendering helpers ---------- */

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Deliberately minimal markdown: fenced code, inline code, bold, and
 * paragraphs. Everything is escaped before any tag is introduced, so model
 * output can never inject markup into the page.
 */
function renderMarkdown(src) {
  const blocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return ` @@BLOCK${blocks.length - 1}@@ `;
  });

  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  const html = text
    .split(/\n{2,}/)
    .map((para) => (para.trim() === "" ? "" : `<p>${para.replace(/\n/g, "<br>")}</p>`))
    .join("");

  return html.replace(/<p>\s*@@BLOCK(\d+)@@\s*<\/p>|@@BLOCK(\d+)@@/g, (_m, a, b) => blocks[Number(a ?? b)]);
}

function atBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
}

function scrollDown(force = false) {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight;
}

function addTurn(who) {
  empty?.remove();
  const turn = document.createElement("div");
  turn.className = `turn ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  turn.appendChild(bubble);
  thread.appendChild(turn);
  scrollDown(true);
  return { turn, bubble };
}

/* ---------- conversation ---------- */

async function send(message) {
  if (busy || message.trim() === "") return;
  busy = true;
  sendBtn.disabled = true;

  addTurn("you").bubble.textContent = message;

  const { turn, bubble } = addTurn("partner");
  const activity = document.createElement("div");
  activity.className = "activity";
  turn.insertBefore(activity, bubble);

  const thinking = document.createElement("span");
  thinking.className = "chip live";
  thinking.textContent = "생각 중";
  activity.appendChild(thinking);

  let raw = "";
  let sources = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, conversationId }),
    });
    if (!res.ok || !res.body) throw new Error(`서버 오류 (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "start") {
          conversationId = event.conversationId;
        } else if (event.type === "delta") {
          thinking.remove();
          raw += event.text;
          bubble.innerHTML = renderMarkdown(raw);
          scrollDown();
        } else if (event.type === "tool") {
          thinking.textContent = event.summary;
          if (!thinking.isConnected) activity.appendChild(thinking);
        } else if (event.type === "cite") {
          sources = event.notes;
        } else if (event.type === "error") {
          thinking.remove();
          const box = document.createElement("div");
          box.className = "error";
          box.textContent = event.message;
          bubble.appendChild(box);
        }
      }
    }
  } catch (err) {
    thinking.remove();
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = err instanceof Error ? err.message : String(err);
    bubble.appendChild(box);
  } finally {
    thinking.remove();
    if (activity.childElementCount === 0) activity.remove();
    if (sources?.length) renderSources(turn, sources);
    busy = false;
    sendBtn.disabled = false;
    input.focus();
    scrollDown();
  }
}

/** Cited notes double as deep links back into Obsidian itself. */
function renderSources(turn, notes) {
  const box = document.createElement("div");
  box.className = "sources";

  const label = document.createElement("div");
  label.className = "sources-label";
  label.textContent = `참조한 노트 ${notes.length}개`;
  box.appendChild(label);

  const list = document.createElement("div");
  list.className = "sources-list";

  for (const note of notes) {
    const a = document.createElement("a");
    a.className = "source";
    a.textContent = note.title;
    a.title = note.path;
    a.href = "#";
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const r = await fetch(`/api/obsidian-uri?path=${encodeURIComponent(note.path)}`);
      const { uri } = await r.json();
      window.location.href = uri;
    });
    list.appendChild(a);
  }

  box.appendChild(list);
  turn.appendChild(box);
  scrollDown();
}

/* ---------- wiring ---------- */

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value;
  input.value = "";
  input.style.height = "auto";
  void send(message);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
});

resetBtn.addEventListener("click", () => {
  conversationId = null;
  location.reload();
});

(async function init() {
  try {
    const res = await fetch("/api/status");
    const s = await res.json();
    metaEl.textContent = `${s.vaultName} · 노트 ${s.noteCount}개 · ${s.model}`;

    const ideas = ["최근에 내가 뭐 하고 있었지?", "볼트 구조 좀 훑어봐 줘"];
    for (const t of (s.topTags ?? []).slice(0, 2)) {
      ideas.push(`#${t.tag} 관련해서 내가 써둔 거 정리해줘`);
    }
    for (const idea of ideas) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.textContent = idea;
      b.addEventListener("click", () => void send(idea));
      suggestionsEl?.appendChild(b);
    }
  } catch {
    metaEl.textContent = "서버에 연결하지 못했습니다";
  }
  input.focus();
})();
