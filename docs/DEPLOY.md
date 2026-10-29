# デプロイフロー

## 現状
- 本番: Cloudflare Workers (`fp-gacha-bot.parcy0704.workers.dev`)
- デプロイ方法: 手元から `wrangler deploy` を手動実行

## 移行予定（このPRはそのパイロット）
1. Cloudflareダッシュボード → Workers & Pages → `fp-gacha-bot` → Settings → Builds で GitHub連携（Connect to Git）
   - production branch: `main`
   - push時に自動ビルド・デプロイ
   - PRごとにプレビューURLが自動生成される
2. `main` ブランチ保護（GitHub Branch protection）
   - 直接pushを禁止し、PR経由のみに限定
   - 管理者（nao0704）はバイパス可能
3. 運用フロー
   - 作業ブランチを作成 → PR作成
   - CloudflareのプレビューURLで見た目を確認
   - GitHubモバイルアプリでPRを開き「Merge pull request」をタップ
   - `main` へのマージをCloudflareが検知して自動で本番反映

## ロールバック手順
- Cloudflareダッシュボード → Workers & Pages → `fp-gacha-bot` → Deployments から、問題発生前の過去のデプロイを選択し「Rollback to this deployment」
- またはGitHub側で問題のコミットを `git revert` し、新しいPRとしてマージ（mainへの再pushで自動的に以前の状態がデプロイされる）

## 動作確認
- Cloudflare Git連携を接続（2026-10-29）。Preview commandを`wrangler versions upload`に修正・再ビルド確認
