# デプロイフロー

## 現状（2026-10-29時点）
- 本番: Cloudflare Workers (`fp-gacha-bot.parcy0704.workers.dev`)
- Cloudflare Git連携（Workers Builds）を接続済み
  - production branch: `main`
  - `main`へのpush/マージ時に自動ビルド・デプロイ（`npx wrangler deploy`）
- `main`ブランチ保護を有効化（GitHub Branch protection）
  - 直接pushを禁止、PR経由のみに限定
  - 管理者（nao0704）はバイパス可能

## 既知の制限：PRごとのプレビューURLは現在オフ
Cloudflare Workers Builds の「Preview branches」機能（`wrangler versions upload`）を
有効化したところ、ブランチ/PRを変えて複数回検証しても
`The name in your wrangler.toml file (fp-gacha-bot) must match the name of your Worker.`
というエラーで失敗し続けた（`--name`明示でも解消せず）。原因未特定のCloudflare側の
制約・不具合の可能性が高いため、一旦「Builds for Preview branches」をオフにして
運用。プレビューが必要な場合は手元で`npx wrangler versions upload`を実行するか、
後日Cloudflareサポート/コミュニティで原因を確認して再度有効化する。

## 運用フロー（現状）
1. 作業ブランチを作成 → PR作成
2. GitHubモバイルアプリでPRを開き、内容を確認して「Merge pull request」をタップ
3. `main`へのマージをCloudflareが検知して自動で本番反映（数十秒）
4. Cloudflareダッシュボード → Workers & Pages → `fp-gacha-bot` → Deployments で反映を確認

## ロールバック手順
- Cloudflareダッシュボード → Workers & Pages → `fp-gacha-bot` → Deployments から、問題発生前の過去のデプロイを選択し「Rollback to this deployment」
- またはGitHub側で問題のコミットを `git revert` し、新しいPRとしてマージ（mainへの再pushで自動的に以前の状態がデプロイされる）
