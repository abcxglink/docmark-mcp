#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

// サブコマンドの処理
if (process.argv[2] === "login") {
  const { login } = await import("./login.js");
  await login(process.argv[3]); // optional hub URL
  process.exit(0);
}
if (process.argv[2] === "init") {
  const { init } = await import("./login.js");
  await init(process.argv[3]); // optional hub URL
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
const HUB_URL = process.env.DOCMARK_HUB_URL ?? creds?.hub_url ?? "https://hub.docmark.dev";
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

// UUID形式かどうかの判定
function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// org_id がslugの場合、APIから組織一覧を取得してslugでマッチさせUUIDを返す
async function resolveOrgId(orgIdOrSlug: string): Promise<string> {
  if (isUUID(orgIdOrSlug)) return orgIdOrSlug;
  const res = await api("/api/orgs");
  if (!res.ok) throw new Error("組織一覧の取得に失敗しました");
  const data = await res.json();
  const org = data.organizations.find((o: { slug: string }) => o.slug === orgIdOrSlug);
  if (!org) throw new Error(`組織 "${orgIdOrSlug}" が見つかりません`);
  return org.id;
}

// project_id がslugの場合、プロジェクト一覧からslugでマッチさせUUIDを返す
async function resolveProjectId(projectIdOrSlug: string, orgId: string): Promise<string> {
  if (isUUID(projectIdOrSlug)) return projectIdOrSlug;
  const res = await api(`/api/orgs/${orgId}/projects`);
  if (!res.ok) throw new Error("プロジェクト一覧の取得に失敗しました");
  const data = await res.json();
  const proj = data.projects.find((p: { slug: string }) => p.slug === projectIdOrSlug);
  if (!proj) throw new Error(`プロジェクト "${projectIdOrSlug}" が見つかりません`);
  return proj.id;
}

const server = new McpServer({
  name: "docmark-mcp",
  version: "0.3.0",
});

// --- list_organizations ---
server.tool(
  "list_organizations",
  "自分が所属する組織の一覧を取得する",
  {},
  async () => {
    const res = await api("/api/orgs");
    if (!res.ok) {
      const err = await res.json();
      return { content: [{ type: "text" as const, text: `Error: ${err.error?.message ?? res.statusText}` }] };
    }
    const data = await res.json();
    const lines = data.organizations.map(
      (o: { name: string; slug: string; id: string }) =>
        `- ${o.name} (slug: ${o.slug}, id: ${o.id})`
    );
    return {
      content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "所属する組織がありません" }],
    };
  }
);

// --- list_projects ---
server.tool(
  "list_projects",
  "組織内のプロジェクト一覧を取得する",
  { org_id: z.string().optional().describe("組織IDまたはslug（省略時はデフォルト組織）") },
  async ({ org_id }) => {
    const orgIdRaw = org_id ?? creds?.org_id;
    if (!orgIdRaw) {
      return { content: [{ type: "text" as const, text: "Error: org_id を指定してください（デフォルト組織が未設定です）" }] };
    }
    let resolvedOrgId: string;
    try {
      resolvedOrgId = await resolveOrgId(orgIdRaw);
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    const res = await api(`/api/orgs/${resolvedOrgId}/projects`);
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
    project_id: z.string().optional().describe("新規作成時のプロジェクトIDまたはslug（フロントマターにhub_project_idがない場合に必要）"),
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
      let pidRaw = project_id ?? hubProjectId;
      // project_id 未指定時、デフォルト組織にプロジェクトが1つだけなら自動選択
      if (!pidRaw && creds?.org_id) {
        try {
          const projRes = await api(`/api/orgs/${creds.org_id}/projects`);
          if (projRes.ok) {
            const projData = await projRes.json();
            if (projData.projects.length === 1) {
              pidRaw = projData.projects[0].id;
            }
          }
        } catch { /* ignore */ }
      }
      if (!pidRaw) {
        return {
          content: [{ type: "text" as const, text: "Error: project_id が必要です。フロントマターに hub_project_id がないため、project_id パラメータを指定してください。" }],
        };
      }
      let pid: string;
      try {
        if (!isUUID(pidRaw)) {
          const defaultOrgId = creds?.org_id ?? "";
          pid = await resolveProjectId(pidRaw, defaultOrgId);
        } else {
          pid = pidRaw;
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
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
