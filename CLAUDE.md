# Claude へのプロジェクト作業指示

## 最重要ルール

**`src/index.js` または `wrangler.toml` を変更したら、必ず `ARCHITECTURE.md` も同時に更新すること。**

更新が必要な箇所の例：
- 関数を追加・削除・リネームした → 関数一覧を更新
- Supabaseテーブル・カラムを変更した → テーブル定義を更新
- KVキーの構造を変えた → KVステート設計を更新
- マスターデータ（SPECIALTIES等）を変更した → マスターデータを更新
- 新しいSecretが必要になった → Secrets一覧を更新
- Cronスケジュールを変えた → wrangler.toml設定表を更新
- マッチングロジックを変えた → マッチングロジックセクションを更新

## デプロイ

変更後は必ずデプロイする：

```bash
cd /tmp/fp-gacha-bot && npx wrangler deploy
```

## プロジェクト概要

FPガチャ LINE Bot。お金の悩みをAIが分析し、最適なFP（ファイナンシャルプランナー）をガチャ方式でマッチング。Google Meetを自動生成してオンライン相談を予約まで完結させる。
詳細は `ARCHITECTURE.md` を参照。
