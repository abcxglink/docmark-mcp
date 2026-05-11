# docmark-mcp 学び・改善点

## 2026-05-11

### npm publish は別ターミナルで行う

**発生事象**
Claude Code上で `npm publish` を実行したが、OTP/セキュリティキー認証のプロンプトを正しく処理できず、何度も失敗した。

**原因**
`npm publish` はセキュリティキー（Touch ID）やOTPの対話的認証が必要。Claude CodeのBashツールではこれらの認証フローをハンドルできない。

**対処**
別ターミナルで `npm publish` を実行して成功。

**教訓**
`npm publish`、`npm login`、`npm profile enable-2fa` 等の対話的なnpmコマンドは別ターミナルで実行すること。コミット・pushまではClaude Codeで行い、publishだけ別ターミナルに誘導する。

### MCP改善のHub API/MCP両面対応パターン

**発生事象**
docmark-mcpにlist_organizationsやslug対応を追加する際、Hub API側のエンドポイント追加とMCP側のツール追加の両方が必要だった。

**教訓**
- Hub APIに `GET /api/orgs` は既にコミット済みだった（過去セッションで対応済み）。変更前にgit diffで現状確認すべきだった
- MCP側でslug→UUID解決を行うことで、Hub APIの変更を最小限に抑えられた
- credentials.jsonのデフォルトorg_idを活用することで、ユーザーの引数指定を省略可能にできた
