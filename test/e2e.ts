#!/usr/bin/env npx tsx
/**
 * docmark MCP Server E2E テスト
 *
 * 前提:
 *   - ~/.docmark/credentials.json が存在する（npx docmark-mcp login 済み）
 *   - credentials 内の org_id に少なくとも1つのプロジェクトがあること
 *
 * 実行:
 *   npx tsx test/e2e.ts
 *
 * テストフロー:
 *   1. credentials 読み込み
 *   2. list_projects → プロジェクト一覧取得
 *   3. push_document（新規）→ ドキュメント作成
 *   4. list_documents → 作成したドキュメントが存在するか確認
 *   5. get_document → 内容が一致するか確認
 *   6. pull_document → ローカルにダウンロード、フロントマター確認
 *   7. push_document（更新）→ 内容を変更してプッシュ
 *   8. list_versions → バージョンが2つあるか確認
 *   9. get_document (version=1) → 旧バージョン取得
 *  10. クリーンアップ
 */

import { readFile, writeFile, unlink, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ── 設定 ────────────────────────────────
const CREDENTIALS_PATH = resolve(homedir(), ".docmark", "credentials.json");

interface Credentials {
  api_key: string;
  hub_url: string;
  org_id: string;
}

// ── ヘルパー ────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function api(
  hubUrl: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${hubUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

// ── メイン ────────────────────────────
async function main() {
  console.log("\n=== docmark MCP E2E テスト ===\n");

  // ── 1. credentials 読み込み ──
  console.log("1. credentials 読み込み");
  let creds: Credentials;
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    creds = JSON.parse(raw);
    assert(!!creds.api_key, "api_key が存在する");
    assert(!!creds.hub_url, "hub_url が存在する");
    assert(!!creds.org_id, "org_id が存在する");
  } catch {
    console.error("  ✗ credentials.json が読み込めません。先に npx docmark-mcp login を実行してください。");
    process.exit(1);
  }

  const { api_key, hub_url, org_id } = creds;

  // ── 2. list_projects ──
  console.log("\n2. list_projects");
  const projRes = await api(hub_url, api_key, `/api/orgs/${org_id}/projects`);
  assert(projRes.ok, `GET /api/orgs/${org_id}/projects → ${projRes.status}`);
  const projData = await projRes.json();
  const projects = projData.projects ?? [];
  assert(projects.length > 0, `プロジェクトが${projects.length}件ある`);

  const testProject = projects[0];
  const projectId = testProject.id;
  console.log(`  → テスト対象プロジェクト: ${testProject.name} (${projectId})`);

  // ── 3. push_document（新規作成）──
  console.log("\n3. push_document（新規作成）");
  const testTitle = `E2E テスト ${Date.now()}`;
  const testContent = `# テストドキュメント\n\nこれはE2Eテストで作成されたドキュメントです。\n\n作成日時: ${new Date().toISOString()}`;
  const createRes = await api(hub_url, api_key, "/api/documents", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      title: testTitle,
      content: testContent,
      commit_message: "E2Eテスト: 初回作成",
    }),
  });
  assert(createRes.ok, `POST /api/documents → ${createRes.status}`);
  const created = await createRes.json();
  const docId = created.id;
  assert(!!docId, `ドキュメントID: ${docId}`);
  assert(created.version === 1, `バージョン: ${created.version}`);

  // ── 4. list_documents ──
  console.log("\n4. list_documents");
  const listRes = await api(hub_url, api_key, `/api/documents?project_id=${projectId}`);
  assert(listRes.ok, `GET /api/documents → ${listRes.status}`);
  const listData = await listRes.json();
  const found = listData.documents.some((d: { id: string }) => d.id === docId);
  assert(found, "作成したドキュメントが一覧に含まれる");

  // ── 5. get_document ──
  console.log("\n5. get_document");
  const getRes = await api(hub_url, api_key, `/api/documents/${docId}`);
  assert(getRes.ok, `GET /api/documents/${docId} → ${getRes.status}`);
  const getDoc = await getRes.json();
  assert(getDoc.title === testTitle, `タイトル一致: "${getDoc.title}"`);
  assert(getDoc.content === testContent, "コンテンツ一致");
  assert(getDoc.current_version === 1, `current_version: ${getDoc.current_version}`);

  // ── 6. pull_document（ローカル保存 + フロントマター確認）──
  console.log("\n6. pull_document（ローカル保存）");
  const tmpDir = await mkdtemp(join(tmpdir(), "docmark-e2e-"));
  const localPath = join(tmpDir, "test-doc.md");

  // pull相当: get → フロントマター付与 → 保存
  const hubMeta = {
    hub_doc_id: getDoc.id,
    hub_project_id: getDoc.project_id,
    hub_version: getDoc.requested_version,
  };
  const fm = ["---", ...Object.entries(hubMeta).map(([k, v]) => `${k}: ${v}`), "---"].join("\n");
  const pullContent = `${fm}\n\n${getDoc.content}`;
  await writeFile(localPath, pullContent, "utf-8");

  const savedRaw = await readFile(localPath, "utf-8");
  assert(savedRaw.includes("hub_doc_id:"), "フロントマターに hub_doc_id がある");
  assert(savedRaw.includes("hub_project_id:"), "フロントマターに hub_project_id がある");
  assert(savedRaw.includes("hub_version: 1"), "フロントマターに hub_version: 1 がある");
  assert(savedRaw.includes("# テストドキュメント"), "本文が含まれる");

  // ── 7. push_document（更新）──
  console.log("\n7. push_document（更新）");
  const updatedContent = testContent + "\n\n## 追記セクション\n\nE2Eテストで追記しました。";
  const updateRes = await api(hub_url, api_key, `/api/documents/${docId}`, {
    method: "PUT",
    body: JSON.stringify({
      content: updatedContent,
      commit_message: "E2Eテスト: 追記",
    }),
  });
  assert(updateRes.ok, `PUT /api/documents/${docId} → ${updateRes.status}`);
  const updated = await updateRes.json();
  assert(updated.version === 2, `バージョン: ${updated.version}`);

  // ── 8. list_versions ──
  console.log("\n8. list_versions");
  const versionsRes = await api(hub_url, api_key, `/api/documents/${docId}/versions`);
  assert(versionsRes.ok, `GET /api/documents/${docId}/versions → ${versionsRes.status}`);
  const versionsData = await versionsRes.json();
  assert(versionsData.versions.length === 2, `バージョン数: ${versionsData.versions.length}`);
  const v1 = versionsData.versions.find((v: { version: number }) => v.version === 1);
  const v2 = versionsData.versions.find((v: { version: number }) => v.version === 2);
  assert(!!v1, "v1 が存在する");
  assert(!!v2, "v2 が存在する");
  assert(v1?.commit_message === "E2Eテスト: 初回作成", `v1 コミットメッセージ: "${v1?.commit_message}"`);
  assert(v2?.commit_message === "E2Eテスト: 追記", `v2 コミットメッセージ: "${v2?.commit_message}"`);

  // ── 9. get_document (version=1) ──
  console.log("\n9. get_document (旧バージョン)");
  const getV1Res = await api(hub_url, api_key, `/api/documents/${docId}?version=1`);
  assert(getV1Res.ok, `GET /api/documents/${docId}?version=1 → ${getV1Res.status}`);
  const v1Doc = await getV1Res.json();
  assert(v1Doc.requested_version === 1, `requested_version: ${v1Doc.requested_version}`);
  assert(v1Doc.content === testContent, "v1 のコンテンツは元のまま");
  assert(!v1Doc.content.includes("追記セクション"), "v1 に追記セクションが含まれない");

  // ── 10. クリーンアップ ──
  console.log("\n10. クリーンアップ");
  try {
    await unlink(localPath);
    console.log(`  → ${localPath} を削除`);
  } catch { /* ignore */ }

  // テスト用ドキュメントの削除（APIがあれば）
  // 現状 DELETE API がないためスキップ
  console.log(`  → テストドキュメント "${testTitle}" (${docId}) は手動で削除してください`);

  // ── 結果 ──
  console.log(`\n${"=".repeat(40)}`);
  console.log(`結果: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n予期しないエラー:", err);
  process.exit(1);
});
