import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, basename, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { PartnerConfig } from "./config.js";
import type { VaultIndex } from "./vault/index.js";
import { Conversation } from "./agent.js";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * One process serves one person, so conversations live in memory and are keyed
 * by an id the browser holds. Restarting the server starts a fresh thread.
 */
const conversations = new Map<string, Conversation>();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": MIME[".json"] ?? "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : normalize(urlPath).replace(/^([/\\.])+/, "");
  const abs = join(WEB_ROOT, rel);
  if (!abs.startsWith(WEB_ROOT)) {
    json(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const data = await readFile(abs);
    res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

export function startServer(config: PartnerConfig, index: VaultIndex): void {
  const vaultName = basename(config.vaultPath);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, {
        vaultName,
        vaultPath: config.vaultPath,
        writeRoot: config.writeRoot,
        projectPath: config.projectPath ?? null,
        model: config.model,
        noteCount: index.size,
        topTags: index.tagCounts().slice(0, 12),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readBody(req);
      let parsed: { message?: unknown; conversationId?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: "invalid json" });
        return;
      }
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      if (message === "") {
        json(res, 400, { error: "message is required" });
        return;
      }

      const requestedId = typeof parsed.conversationId === "string" ? parsed.conversationId : "";
      let convo = requestedId ? conversations.get(requestedId) : undefined;
      if (!convo) {
        convo = new Conversation(config, index);
        conversations.set(convo.id, convo);
      }

      // Newline-delimited JSON over a streamed response: no EventSource limits
      // (which is GET-only) and trivial to consume with fetch + a reader.
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`${JSON.stringify({ type: "start", conversationId: convo.id })}\n`);

      for await (const event of convo.send(message)) {
        if (res.writableEnded) break;
        res.write(`${JSON.stringify(event)}\n`);
      }
      res.end();
      return;
    }

    // Turns a cited note into a link that opens it in Obsidian itself.
    if (req.method === "GET" && url.pathname === "/api/obsidian-uri") {
      const path = url.searchParams.get("path") ?? "";
      const file = path.replace(/\.md$/i, "");
      json(res, 200, {
        uri: `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`,
      });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    json(res, 405, { error: "method not allowed" });
  }

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`\n  파트너 준비됨 → http://localhost:${config.port}`);
    console.log(`  볼트: ${config.vaultPath} (노트 ${index.size}개)`);
    console.log(`  쓰기 허용 폴더: ${config.writeRoot}/`);
    if (config.projectPath) console.log(`  코드: ${config.projectPath}`);
    console.log("");
  });
}
