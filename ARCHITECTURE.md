# FP ガチャ LINE Bot — アーキテクチャメモ

## 概要

お金の悩みを持つユーザーにAIが専門領域を分析し、最適なFP（ファイナンシャルプランナー）をランダム（ガチャ）でマッチングしてオンライン相談予約まで完結するLINE Bot。

- **インフラ**: Cloudflare Workers
- **LINE**: Messaging API（Webhook受信 / Push送信 / Flex Message）
- **AI**: Claude Haiku（悩みカテゴリ分類）
- **DB**: Supabase（FP情報・セッション・評価ジョブ）
- **状態管理**: Cloudflare KV（`GACHA_STATE`）
- **カレンダー**: Google Calendar API（OAuth2・FPごとの個人アカウント）
- **会議**: Google Meet（カレンダーイベントに自動付与）

---

## ファイル構成

```
fp-gacha-bot/
├── src/index.js          # メインロジック（696行・2026年5月時点）
├── wrangler.toml         # Cloudflare Workers設定
├── supabase_setup.sql    # Supabaseテーブル定義
└── ARCHITECTURE.md       # このファイル
```

---

## wrangler.toml 主要設定

| 項目 | 値 |
|---|---|
| Worker名 | `fp-gacha-bot` |
| KV binding | `GACHA_STATE` |
| Cron | `0 * * * *`（毎時・評価ジョブ送信） |
| SUPABASE_URL | `https://spfyisnsjobyaebsradv.supabase.co` |
| WORKER_URL | `https://fp-gacha-bot.parcy0704.workers.dev` |

Secrets（`wrangler secret put` で設定）:
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `ANTHROPIC_API_KEY`
- `SUPABASE_ANON_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`（FPのGoogleカレンダー連携用OAuth）
- `GOOGLE_OAUTH_CLIENT_SECRET`

---

## 登場人物

| 種別 | 説明 |
|---|---|
| クライアント | お金の悩みを持つ一般ユーザー |
| FP | ファイナンシャルプランナー（登録制） |

---

## KV ステート設計（`GACHA_STATE`）

| キー | 内容 | TTL |
|---|---|---|
| `fp_reg:{userId}` | FP登録フロー途中状態 | 1時間 |
| `client:{userId}` | クライアント相談フロー途中状態 | 1時間 |

---

## Supabase テーブル

### `fp_fps`（FP情報）
| カラム | 説明 |
|---|---|
| `line_user_id` | FPのLINE User ID |
| `name` | FP氏名 |
| `lifecycle_stages` | 対応ライフステージ（配列） |
| `specialties` | 専門領域（配列） |
| `google_calendar_id` | FP個人のGoogleカレンダーID |
| `google_refresh_token` | OAuth2リフレッシュトークン |
| `active` | 受付中フラグ |

### `fp_gacha_sessions`（相談セッション）
| カラム | 説明 |
|---|---|
| `client_line_user_id` | クライアントのLINE User ID |
| `concern` | 悩み文章 |
| `lifecycle_stage` | ライフステージ |
| `age_range` | 年代 |
| `matched_categories` | AIが分類した専門領域 |
| `selected_fp_id` | マッチしたFPのID |
| `scheduled_start/end` | 相談日時 |
| `status` | `started` / `confirmed` / `rated` |
| `rating` | 1〜5の評価 |

### `fp_rating_jobs`（評価リクエスト送信ジョブ）
| カラム | 説明 |
|---|---|
| `session_id` | セッションID |
| `client_line_user_id` | 送信先 |
| `fp_name` | FP名（メッセージ用） |
| `send_at` | 送信予定時刻（相談終了1時間後） |
| `sent` | 送信済みフラグ |

---

## マスターデータ（コード内定数）

### ライフステージ（`LIFECYCLE_STAGES`）
独身 / 世帯・子あり / 世帯・子なし / 高齢者

### 年代（`AGE_RANGES`）
20代 / 30代 / 40代 / 50代 / 60代以上

### 専門領域（`SPECIALTIES`）14種類
保険・医療保障 / 貯蓄 / 家計・収支改善 / キャッシュフロー表作成 / 資産形成 / 投資（NISA・iDeCo）/ 老後資金 / 教育資金 / 相続 / 事業承継 / 不動産 / 節税 / 節約 / その他

---

## 関数一覧（src/index.js）

### エントリーポイント

| 関数 | 役割 |
|---|---|
| `export default.fetch` | Webhook受信・ルーティング |
| `export default.scheduled` | 毎時Cron→評価ジョブ処理 |

### イベントハンドラ

| 関数 | 役割 |
|---|---|
| `onFollow` | 友だち追加時のウェルカムメッセージ |
| `onMessage` | テキストメッセージの振り分け |
| `onPostback` | Postbackの振り分け |

### FP登録フロー

| 関数 | 役割 |
|---|---|
| `startFPReg` | 登録開始・名前入力誘導 |
| `fpRegStep` | 名前→ライフステージ→専門領域→OAuth順に進む |
| `fpLifecycleTap` | ライフステージ選択Postback処理 |
| `lcQRItems` | ライフステージクイックリプライ生成（選択済みを除外） |
| `fpMenu` | 登録済みFPの一時停止・再開・状態確認 |

### Google OAuth（FPカレンダー連携）

| 関数 | 役割 |
|---|---|
| `oauthStart` | `/oauth/start` → Google認証画面へリダイレクト |
| `oauthCallback` | `/oauth/callback` → code→token交換→FP情報保存 |

### クライアント相談フロー

| 関数 | 役割 |
|---|---|
| `startClient` | 相談開始・悩み入力誘導 |
| `clientStep` | 悩み受付→ライフステージ選択へ |
| `clientLifecycleTap` | ライフステージ選択→年代選択へ |
| `clientAgeTap` | 年代選択→AI分析→FP検索→スロット表示 |
| `clientSlotTap` | 日時選択→ガチャ抽選→GCal予約→結果表示 |

### Google Calendar

| 関数 | 役割 |
|---|---|
| `refreshToken` | OAuth2リフレッシュトークンでアクセストークン取得 |
| `aggregateSlots` | 全マッチFPのbusy時間を並列取得→空き枠6件を返す |
| `availFPsAtSlot` | 選択スロットで空いているFPを再確認 |
| `createMeetEvent` | FPカレンダーにイベント作成＋Google Meet URL自動生成 |

### AI

| 関数 | 役割 |
|---|---|
| `categorizeConcern` | 悩み文章をClaude Haikuで専門領域に分類（最大3つ） |
| `findFPs` | ライフステージ＋専門領域でSupabaseからFPを絞り込み |

### 通知・評価

| 関数 | 役割 |
|---|---|
| `notifyFP` | マッチしたFPに予約通知をLINEで送信 |
| `clientRate` | 星評価をセッションに保存 |
| `processRatingJobs` | 毎時Cronで`send_at`を過ぎたジョブを送信 |

### Flex Messageビルダー

| 関数 | 役割 |
|---|---|
| `slotFlex` | 空き時間選択Flex（何名対応可かを表示） |
| `resultFlex` | マッチ結果Flex（FP名・日時・Meetリンク） |
| `ratingFlex` | 5段階評価Flex |

### ユーティリティ

| 関数 | 役割 |
|---|---|
| `verifySig` | LINE署名検証 |
| `jstParts` | ISO文字列→JST（月・日・曜日・時）に変換 |
| `jstYMD` | msタイムスタンプ→JST（年・月・日）に変換 |
| `reply` / `replyQR` / `push` / `pushFlex` | LINE送信系 |
| `kv` | KVネームスペース参照のショートハンド |
| `sbHeaders` | Supabaseリクエストヘッダー生成 |
| `getFP` / `getFPById` / `saveFP` / `patchFP` | FP CRUD |
| `createSession` / `updateSession` | セッションCRUD |
| `createRatingJob` | 評価ジョブ作成 |

---

## マッチングロジック

1. 悩み文章をClaude Haikuで専門領域（最大3つ）に分類
2. Supabaseから「ライフステージ一致 かつ 専門領域いずれか一致 かつ active=true」のFPを取得
3. 全FPのGoogleカレンダーをfreeBusy APIで並列取得
4. 空き枠（8:00〜22:00、1時間単位）を最大6件抽出
5. ユーザーが日時を選択 → その枠で空いているFPを再確認
6. 空いているFPからランダム1名を選出（ガチャ）
7. そのFPのカレンダーにGoogle Meetイベントを作成

---

## 評価フロー

- 相談終了予定時刻（`slot.end`）の1時間後に`fp_rating_jobs`にジョブを登録
- 毎時Cronが`send_at <= 現在時刻`のジョブを検索してFlex送信
- ユーザーが1〜5の星をタップ → セッションに保存

---

## 今後の技術的検討事項

### ファイル分割（処理負担軽減）

現在約700行。機能追加に伴い1500行を超えてきた段階でファイル分割を検討する。

分割候補：
- `src/handlers/fp.js` — FP登録・メニュー
- `src/handlers/client.js` — クライアント相談フロー
- `src/services/calendar.js` — Google Calendar API
- `src/services/supabase.js` — Supabase CRUD
- `src/services/line.js` — LINE送信ユーティリティ
