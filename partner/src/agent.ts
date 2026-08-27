import { randomUUID } from "node:crypto";
import { query, type CanUseTool, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PartnerConfig } from "./config.js";
import type { VaultIndex } from "./vault/index.js";
import { buildSystemPrompt } from "./persona.js";
import { createVaultTools } from "./tools/vault-tools.js";

export type PartnerEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "cite"; notes: Array<{ path: string; title: string }> }
  | { type: "error"; message: string }
  | { type: "done" };

/** Read-only built-ins the partner may use without asking. */
const SAFE_BUILTINS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite"]);

function isVaultTool(name: string): boolean {
  return name.includes("vault_");
}

function summariseTool(name: string, input: Record<string, unknown>): string {
  const short = name.replace(/^mcp__vault__/, "");
  const arg = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (short) {
    case "vault_search": {
      const bits = [arg("query"), input["tag"] ? `#${String(input["tag"])}` : "", arg("folder")].filter(Boolean);
      return `볼트 검색: ${bits.join(" ") || "(전체)"}`;
    }
    case "vault_read":
      return `노트 읽는 중: ${arg("path")}`;
    case "vault_neighbors":
      return `링크 따라가는 중: ${arg("path")}`;
    case "vault_recent":
      return "최근 노트 확인 중";
    case "vault_map":
      return "볼트 구조 파악 중";
    case "vault_write":
      return `노트 쓰는 중: ${arg("path")}`;
    default:
      return short;
  }
}

export class Conversation {
  private readonly sessionId = randomUUID();
  private started = false;

  constructor(
    private readonly config: PartnerConfig,
    private readonly index: VaultIndex,
  ) {}

  get id(): string {
    return this.sessionId;
  }

  async *send(prompt: string): AsyncGenerator<PartnerEvent> {
    const cited = new Set<string>();
    const vaultServer = createVaultTools(this.index, this.config.writeRoot, (paths) => {
      for (const p of paths) cited.add(p);
    });

    // Resuming keeps the whole prior exchange without us replaying it, which is
    // what lets the partner refer back to something said twenty turns ago.
    const sessionOption = this.started ? { resume: this.sessionId } : { sessionId: this.sessionId };
    this.started = true;

    const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
      if (isVaultTool(toolName) || SAFE_BUILTINS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      return {
        behavior: "deny",
        message:
          `"${toolName}" 은 이 파트너에게 허용되지 않은 도구야. ` +
          "볼트 도구나 읽기 전용 도구로 해결해 줘.",
      };
    };

    try {
      const stream = query({
        prompt,
        options: {
          ...sessionOption,
          cwd: this.config.projectPath ?? this.config.vaultPath,
          model: this.config.model,
          systemPrompt: buildSystemPrompt(this.config, this.index),
          mcpServers: { vault: vaultServer },
          permissionMode: "default",
          // Settings files on disk belong to Claude Code, not to this app.
          settingSources: [],
          maxTurns: 40,
          // Token-level deltas: the partner often reads several notes before it
          // answers, and watching the answer form is what keeps that wait bearable.
          includePartialMessages: true,
          canUseTool,
        },
      });

      let citeFlushed = 0;
      let sawText = false;
      let blockHasText = false;

      for await (const message of stream) {
        if (message.type === "stream_event") {
          const event = message.event;

          if (event.type === "content_block_start" && event.content_block.type === "text") {
            // Separate a post-tool paragraph from whatever was said before it.
            if (sawText) yield { type: "delta", text: "\n\n" };
            blockHasText = false;
          }

          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            if (text !== "") {
              blockHasText = true;
              sawText = true;
              yield { type: "delta", text };
            }
          }
          continue;
        }

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              yield {
                type: "tool",
                name: block.name,
                summary: summariseTool(block.name, (block.input ?? {}) as Record<string, unknown>),
              };
            }
          }
          continue;
        }

        // Tool results come back as user messages; citations are recorded by the
        // tool handlers themselves, so flush whatever is newly known.
        if (message.type === "user" && cited.size > citeFlushed) {
          citeFlushed = cited.size;
          yield { type: "cite", notes: this.describe([...cited]) };
          continue;
        }

        if (message.type === "result") {
          if (message.subtype !== "success") {
            yield { type: "error", message: `대화가 정상 종료되지 않았어 (${message.subtype})` };
          } else if (!blockHasText && !sawText) {
            yield { type: "error", message: "응답이 비어 있어. 다시 물어봐 줄래?" };
          }
          break;
        }
      }

      if (cited.size > 0) yield { type: "cite", notes: this.describe([...cited]) };
      yield { type: "done" };
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done" };
    }
  }

  private describe(paths: string[]): Array<{ path: string; title: string }> {
    return paths.map((path) => ({ path, title: this.index.get(path)?.title ?? path }));
  }
}
