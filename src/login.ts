import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CREDENTIALS_DIR = resolve(homedir(), ".docmark");
const CREDENTIALS_PATH = resolve(CREDENTIALS_DIR, "credentials.json");

export async function login(hubUrl?: string) {
  const hub = hubUrl ?? "https://docmark-hub.vercel.app";
  const code = randomBytes(16).toString("hex");

  // ローカルHTTPサーバーを起動してコールバックを待つ
  const port = await new Promise<number>((resolvePort) => {
    const srv = createServer(async (req, res) => {
      // CORS対応（ブラウザからのfetch）
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);

            // credentials を保存
            await mkdir(CREDENTIALS_DIR, { recursive: true });
            await writeFile(
              CREDENTIALS_PATH,
              JSON.stringify(
                {
                  api_key: data.key,
                  hub_url: data.hub_url,
                  org_id: data.org_id,
                  org_name: data.org_name,
                  org_slug: data.org_slug,
                  user_email: data.user_email,
                },
                null,
                2
              ),
              "utf-8"
            );

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));

            console.log("");
            console.log(`✓ ログインしました (${data.user_email})`);
            console.log(`  組織: ${data.org_name} (${data.org_slug})`);
            console.log(`  保存先: ${CREDENTIALS_PATH}`);
            console.log("");
            console.log("Claude Code の設定に以下を追加してください:");
            console.log("");
            console.log(`  {`);
            console.log(`    "mcpServers": {`);
            console.log(`      "docmark": {`);
            console.log(`        "command": "node",`);
            console.log(`        "args": ["${resolve(process.cwd(), "dist/index.js")}"]`);
            console.log(`      }`);
            console.log(`    }`);
            console.log(`  }`);
            console.log("");

            // サーバーを閉じる
            srv.close();
            process.exit(0);
          } catch (err) {
            res.writeHead(400);
            res.end("Invalid request");
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    srv.listen(0, () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      resolvePort(p);

      // 60秒でタイムアウト
      setTimeout(() => {
        console.error("\nタイムアウト: ブラウザでの認証が完了しませんでした。");
        srv.close();
        process.exit(1);
      }, 60000);
    });
  });

  const authUrl = `${hub}/auth/device?code=${code}&port=${port}`;

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
}
