import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CREDENTIALS_DIR = resolve(homedir(), ".docmark");
const CREDENTIALS_PATH = resolve(CREDENTIALS_DIR, "credentials.json");

export async function login(hubUrl?: string) {
  const hub = hubUrl ?? "https://hub.docmark.dev";
  const code = randomBytes(16).toString("hex");

  const authUrl = `${hub}/auth/device?code=${code}`;

  console.log("");
  console.log("docmark hub にログイン");
  console.log("");
  console.log("ブラウザを開いています...");
  console.log("");
  console.log(`  ${authUrl}`);
  console.log("");
  console.log("ブラウザが開かない場合は、上のURLを手動で開いてください。");
  console.log("認証を待機中...");

  // ブラウザを開く
  const { exec } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${authUrl}"`);

  // サーバーをポーリングして認証結果を取得
  const pollUrl = `${hub}/api/auth/device/poll?code=${code}`;
  const timeout = 120000; // 2分
  const interval = 2000; // 2秒ごと
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));

    try {
      const res = await fetch(pollUrl);
      if (res.status === 202) {
        // まだ認証されていない
        continue;
      }
      if (!res.ok) {
        console.error("\n認証に失敗しました。再度お試しください。");
        process.exit(1);
      }

      const data = await res.json();

      // credentials を保存（組織非依存）
      await mkdir(CREDENTIALS_DIR, { recursive: true });
      await writeFile(
        CREDENTIALS_PATH,
        JSON.stringify(
          {
            api_key: data.key,
            hub_url: hub,
            user_email: data.user_email,
          },
          null,
          2
        ),
        "utf-8"
      );

      console.log("");
      console.log(`✓ ログインしました (${data.user_email})`);
      console.log(`  保存先: ${CREDENTIALS_PATH}`);
      return;
    } catch {
      // ネットワークエラーなどは無視してリトライ
      continue;
    }
  }

  throw new Error("タイムアウト: ブラウザでの認証が完了しませんでした。");
}

export async function init(hubUrl?: string) {
  const { execSync } = await import("node:child_process");

  // 1. ログイン
  await login(hubUrl);

  // 2. Claude Code MCP にdocmarkを登録
  console.log("");
  console.log("Claude Code に MCP サーバーを登録しています...");
  try {
    execSync("claude mcp add docmark -- npx -y docmark-mcp", {
      stdio: "inherit",
    });
    console.log("✓ MCP サーバーを登録しました");
  } catch {
    console.log("");
    console.log("Claude Code への自動登録に失敗しました。手動で以下を実行してください:");
    console.log("  claude mcp add docmark -- npx -y docmark-mcp");
  }

  console.log("");
  console.log("セットアップ完了！Claude Code を再起動すると docmark ツールが使えます。");
}
