#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

// login コマンドの場合は別処理
if (process.argv[2] === "login") {
  const { login } = await import("./login.js");
  await login(process.argv[3]); // optional hub URL
  process.exit(0);
}

// credentials 読み込み
const CREDENTIALS_PATH = resolve(homedir(), ".docmark", "credentials.json");

interface Credentials {
  api_key: string;
  hub_url: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  user_email: string;
}

async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const creds = await loadCredentials();

// 環境変数 > credentials ファイル
const HUB_URL = process.env.DOCMARK_HUB_URL ?? creds?.hub_url ?? "https://docmark-hub.vercel.app";
const API_KEY = process.env.DOCMARK_API_KEY ?? creds?.api_key ?? "";

if (!API_KEY) {
  console.error(
    "認証情報がありません。以下のいずれかで設定してください:\n" +
    "  1. npx docmark-mcp login\n" +
    "  2. 環境変数 DOCMARK_API_KEY を設定\n"
  );
  process.exit(1);
}

// MCP Server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function api(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${HUB_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
}

const server = new McpServer({
  name: "docmark-mcp",
  version: "0.1.0",
});

// --- list_projects ---
server.tool(
  "list_projects",
  "組織内のプロジェクト一覧を取得する",
  { org_id: z.string().describe("組織ID") },
  async ({ org_id }) => {
    const res = await api(`/api/orgs/${org_id}/projects`);
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();
    const lines = data.projects.map(
      (p: { name: string; slug: string; id: string }) =>
        `- ${p.name} (slug: ${p.slug}, id: ${p.id})`
    );
    return {
      content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "プロジェクトがありません" }],
    };
  }
);

// --- list_documents ---
server.tool(
  "list_documents",
  "プロジェクト内のドキュメント一覧を取得する",
  {
    project_id: z.string().describe("プロジェクトID"),
    page: z.number().optional().describe("ページ番号（デフォルト: 1）"),
    per_page: z.number().optional().describe("1ページあたりの件数（デフォルト: 20, 最大: 100）"),
  },
  async ({ project_id, page, per_page }) => {
    const params = new URLSearchParams({ project_id });
    if (page) params.set("page", String(page));
    if (per_page) params.set("per_page", String(per_page));

    const res = await api(`/api/documents?${params}`);
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();
    const lines = data.documents.map(
      (d: { title: string; slug: string; id: string; current_version: number }) =>
        `- ${d.title} (v${d.current_version}, id: ${d.id})`
    );
    return {
      content: [{
        type: "text" as const,
        text: lines.length > 0
          ? `${lines.join("\n")}\n\n(${data.total}件中 ${data.documents.length}件表示)`
          : "ドキュメントがありません",
      }],
    };
  }
);

// --- get_document ---
server.tool(
  "get_document",
  "ドキュメントの内容を取得する",
  {
    document_id: z.string().describe("ドキュメントID"),
    version: z.number().optional().describe("バージョン番号（省略時は最新）"),
  },
  async ({ document_id, version }) => {
    const params = version ? `?version=${version}` : "";
    const res = await api(`/api/documents/${document_id}${params}`);
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();
    return {
      content: [{
        type: "text" as const,
        text: [
          `# ${data.title}`,
          `ID: ${data.id}`,
          `Version: v${data.requested_version} (最新: v${data.current_version})`,
          `URL: ${data.share_url}`,
          "",
          "---",
          "",
          data.content,
        ].join("\n"),
      }],
    };
  }
);

// --- pull_document ---
server.tool(
  "pull_document",
  "ドキュメントをローカルファイルとしてダウンロードする（フロントマター付き）",
  {
    document_id: z.string().describe("ドキュメントID"),
    output_path: z.string().describe("保存先のファイルパス"),
    version: z.number().optional().describe("バージョン番号（省略時は最新）"),
  },
  async ({ document_id, output_path, version }) => {
    const params = version ? `?version=${version}` : "";
    const res = await api(`/api/documents/${document_id}${params}`);
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();

    const hubMeta = {
      hub_doc_id: data.id,
      hub_project_id: data.project_id,
      hub_version: data.requested_version,
    };
    let content = data.content as string;
    const trimmed = content.trimStart();
    if (trimmed.startsWith("---")) {
      const endIdx = trimmed.indexOf("---", 3);
      if (endIdx !== -1) {
        const existing = trimmed.slice(3, endIdx).trim();
        const lines = existing.split("\n").filter(
          (l: string) =>
            !l.startsWith("hub_doc_id:") &&
            !l.startsWith("hub_project_id:") &&
            !l.startsWith("hub_version:")
        );
        const merged = [
          ...lines,
          ...Object.entries(hubMeta).map(([k, v]) => `${k}: ${v}`),
        ].join("\n");
        content = `---\n${merged}\n---${trimmed.slice(endIdx + 3)}`;
      }
    } else {
      const fm = ["---", ...Object.entries(hubMeta).map(([k, v]) => `${k}: ${v}`), "---"].join("\n");
      content = `${fm}\n\n${data.content}`;
    }

    const { writeFile } = await import("node:fs/promises");
    const absPath = resolve(output_path);
    await writeFile(absPath, content, "utf-8");

    return {
      content: [{ type: "text" as const, text: `${data.title} (v${data.requested_version}) を ${absPath} に保存しました` }],
    };
  }
);

// --- push_document ---
server.tool(
  "push_document",
  "ローカルのMarkdownファイルをdocmark hubにプッシュする（新規 or 更新を自動判定）",
  {
    file_path: z.string().describe("プッシュするMarkdownファイルのパス"),
    project_id: z.string().optional().describe("新規作成時のプロジェクトID（フロントマターにhub_project_idがない場合に必要）"),
    title: z.string().optional().describe("新規作成時のタイトル（省略時はファイル名）"),
    commit_message: z.string().optional().describe("コミットメッセージ"),
  },
  async ({ file_path, project_id, title, commit_message }) => {
    const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const absPath = resolve(file_path);
    const raw = await rf(absPath, "utf-8");

    let content = raw;
    let hubDocId: string | null = null;
    let hubProjectId: string | null = null;

    const trimmed = raw.trimStart();
    if (trimmed.startsWith("---")) {
      const endIdx = trimmed.indexOf("---", 3);
      if (endIdx !== -1) {
        const fmBlock = trimmed.slice(3, endIdx).trim();
        for (const line of fmBlock.split("\n")) {
          const [key, ...rest] = line.split(":");
          const val = rest.join(":").trim();
          if (key.trim() === "hub_doc_id") hubDocId = val;
          if (key.trim() === "hub_project_id") hubProjectId = val;
        }
        content = trimmed.slice(endIdx + 3).replace(/^\n+/, "");
      }
    }

    if (hubDocId) {
      const res = await api(`/api/documents/${hubDocId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, commit_message }),
      });
      if (!res.ok) {
        const err = await res.json();
        return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
      }
      const data = await res.json();
      const updated = raw.replace(/hub_version:\s*\d+/, `hub_version: ${data.version}`);
      await wf(absPath, updated, "utf-8");
      return {
        content: [{ type: "text" as const, text: `${data.title} を v${data.version} に更新しました\nURL: ${data.share_url}` }],
      };
    } else {
      const pid = project_id ?? hubProjectId;
      if (!pid) {
        return {
          content: [{ type: "text" as const, text: "Error: project_id が必要です。フロントマターに hub_project_id がないため、project_id パラメータを指定してください。" }],
        };
      }
      const docTitle = title ?? basename(absPath, ".md");
      const res = await api("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: pid, title: docTitle, content, commit_message }),
      });
      if (!res.ok) {
        const err = await res.json();
        return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
      }
      const data = await res.json();
      const fm = ["---", `hub_doc_id: ${data.id}`, `hub_project_id: ${pid}`, `hub_version: ${data.version}`, "---"].join("\n");
      await wf(absPath, `${fm}\n\n${content}`, "utf-8");
      return {
        content: [{ type: "text" as const, text: `${data.title} を新規作成しました (v${data.version})\nURL: ${data.share_url}` }],
      };
    }
  }
);

// --- list_versions ---
server.tool(
  "list_versions",
  "ドキュメントのバージョン履歴を取得する",
  { document_id: z.string().describe("ドキュメントID") },
  async ({ document_id }) => {
    const res = await api(`/api/documents/${document_id}/versions`);
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();
    const lines = data.versions.map(
      (v: { version: number; commit_message: string | null; committed_by: { display_name: string }; created_at: string }) =>
        `v${v.version} — ${v.commit_message ?? "(メッセージなし)"} by ${v.committed_by.display_name} (${new Date(v.created_at).toLocaleString("ja-JP")})`
    );
    return {
      content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "バージョン履歴がありません" }],
    };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
