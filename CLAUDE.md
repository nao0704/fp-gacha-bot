# FPガチャ LINE Bot — Claude 作業指示書

## 最重要ルール

**`src/index.js` または `wrangler.toml` を変更したら、必ず本ファイル（CLAUDE.md）も同時に更新すること。**

---

## コマンド集

```bash
# デプロイ（作業ディレクトリから）
npx wrangler deploy

# ログ確認
npx wrangler tail

# KV確認
npx wrangler kv key list --namespace-id e5dd2bd4c8c047cca1e1e7eec46ce7e7

# Secretの設定
npx wrangler secret put <SECRET_NAME>

# git push（大容量ファイル含む場合はバッファ設定が必要）
git config http.postBuffer 524288000
git push origin main

# LINEで「オールリセット」と送ると allReset() が実行される
```

---

## プロジェクト概要

**FPガチャ LINE Bot**。お金の悩みをAIが分析し、最適なFP（ファイナンシャルプランナー）をガチャ方式でマッチング。Google Meetを自動生成してオンライン相談を予約まで完結させる。

---

## ビジネス設計

### 料金プラン（相談者向け）
- 初回相談：無料
- 継続利用：有料プランへ誘導（Stripe実装予定）

### エージェント報酬体系
- エージェントコード経由でLINE登録した相談者1名につき **¥1,000** 報酬
- `agent_referrals.registered_at` に記録された登録者数を集計
- エージェント管理ページ（`/agent/`）で報酬額・登録者数を確認可能

---

## URLページ一覧

| URL | 内容 |
|---|---|
| `https://fp-gacha-bot.parcy0704.workers.dev/` | LP（ランディングページ） |
| `https://fp-gacha-bot.parcy0704.workers.dev/fp/register` | FP登録フォーム |
| `https://fp-gacha-bot.parcy0704.workers.dev/fp/edit?token={token}` | FP登録変更フォーム（ワンタイムURL） |
| `https://fp-gacha-bot.parcy0704.workers.dev/agent/` | エージェント管理ページ（PW: `fpgacha2025`） |
| `https://fp-gacha-bot.parcy0704.workers.dev/liff/ref?ref={code}` | LIFF追跡ページ（エージェント経由流入） |
| `https://liff.line.me/2010168612-sAEWwrFD?ref={code}` | エージェント追跡URL（外部公開用） |
| `https://fp-gacha-bot.parcy0704.workers.dev/privacy.html` | プライバシーポリシー |
| `https://fp-gacha-bot.parcy0704.workers.dev/tokusho.html` | 特定商取引法に基づく表記 |

---

## インフラ構成

| レイヤー | サービス | 用途 |
|---|---|---|
| サーバーレス実行 | Cloudflare Workers | LINE Webhookハンドラ・API |
| 静的アセット | Cloudflare Workers Assets | HTML配信（LP・フォーム等） |
| KVストア | Cloudflare KV (`GACHA_STATE`) | セッション状態管理 |
| データベース | Supabase (PostgreSQL) | 会話履歴・FP情報・セッション等 |
| メッセージング | LINE Messaging API | チャットUI |
| AI | Claude Haiku (`claude-haiku-4-5-20251001`) | 共感応答・悩み分類 |
| カレンダー | Google Calendar API | 空き枠取得・Google Meet生成 |
| LIFF | LINE Front-end Framework | エージェント追跡・プロフィール取得 |

**Workers URL**: `https://fp-gacha-bot.parcy0704.workers.dev`
**Supabase URL**: `https://spfyisnsjobyaebsradv.supabase.co`
**LIFF ID**: `2010168612-sAEWwrFD`

---

## Cloudflare Workers Secrets

★ = 未設定・要対応

| Secret名 | 内容 | 状態 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API アクセストークン | ✅ 設定済 |
| `LINE_CHANNEL_SECRET` | LINE署名検証用シークレット | ✅ 設定済 |
| `SUPABASE_ANON_KEY` | Supabase anon key | ✅ 設定済 |
| `ANTHROPIC_API_KEY` | Claude API キー | ✅ 設定済 |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth クライアントID | ✅ 設定済 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth クライアントシークレット | ✅ 設定済 |
| `ADMIN_LINE_ID` | 管理者のLINEユーザーID | ★ 未設定 → `npx wrangler secret put ADMIN_LINE_ID` |

**wrangler.toml の vars（公開値）**：
```toml
SUPABASE_URL = "https://spfyisnsjobyaebsradv.supabase.co"
WORKER_URL   = "https://fp-gacha-bot.parcy0704.workers.dev"
```

---

## Supabaseテーブル構成

### `conversations` — LINE会話履歴

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| line_user_id | text | LINEユーザーID |
| role | text | `'user'` / `'assistant'` |
| content | text | メッセージ本文 |
| phase | int | 1〜4 |
| created_at | timestamptz | 自動 |

**注意**: `onFollow` (line 316) のみ古い `user_line_id` カラムを参照している。他は全て `line_user_id`。

---

### `fp_fps` — FP情報

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| name | text | FP氏名 |
| email | text UNIQUE | メールアドレス |
| phone | text | 電話番号（10桁以上） |
| qualification | text | 資格名 |
| line_user_id | text | LINEユーザーID（Web登録直後はNULL） |
| lifecycle_stages | text[] | レガシー用ライフステージキー |
| specialties | text[] | 専門領域キー（SPECIALTIES参照） |
| age_ranges | text[] | 対応年代キー（`20s`〜`60plus`） |
| family_stages | text[] | 詳細家族構成キー |
| active | bool | 受付中フラグ（default: false） |
| google_calendar_id | text | GoogleカレンダーID |
| google_refresh_token | text | Google OAuthリフレッシュトークン |
| no_show_count | int | ノーショー回数（2回で自動バン） |
| banned | bool | バン済みフラグ |
| banned_reason | text | バン理由 |
| created_at | timestamptz | 自動 |

---

### `fp_gacha_sessions` — マッチングセッション

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| client_line_user_id | text | 相談者LINEID |
| fp_line_user_id | text | FP LINEID |
| selected_fp_id | uuid | fp_fps.id |
| status | text | `started`/`collecting`/`confirmed`/`cancelled`/`fp_cancelled`/`fp_noshow`/`rated` |
| matched | bool | マッチング完了フラグ |
| gender | text | 性別 |
| job_status | text | 職業 |
| age_range | text | 年代（`20代`〜`60代以上`） |
| marital_status | text | 婚姻状況 |
| children_count | text | 子ども状況 |
| scheduled_start | timestamptz | 面談開始日時（UTC） |
| scheduled_end | timestamptz | 面談終了日時（UTC） |
| meet_url | text | Google Meet URL |
| no_show_checked | bool | ノーショー確認送信済みフラグ |
| rating | int | 1〜5の評価 |
| updated_at | timestamptz | 更新時自動設定 |
| created_at | timestamptz | 自動 |

---

### `fp_rating_jobs` — 評価送信ジョブ

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| session_id | uuid | fp_gacha_sessions.id |
| client_line_user_id | text | 相談者LINEID |
| fp_name | text | FP氏名 |
| send_at | timestamptz | 送信予定（面談終了+1時間） |
| sent | bool | 送信済みフラグ |

---

### `fp_reminders` — リマインダー送信ジョブ

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| session_id | uuid | fp_gacha_sessions.id |
| client_line_user_id | text | 相談者LINEID |
| fp_line_user_id | text | FP LINEID |
| consultation_time | timestamptz | 面談日時 |
| send_at | timestamptz | 送信予定（面談1時間前） |
| sent | bool | 送信済みフラグ |

---

### `agents` — エージェント情報

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| company_name | text | 会社名 |
| contact_name | text | 担当者名 |
| email | text UNIQUE | メールアドレス |
| code | text UNIQUE | エージェントコード（8文字英数字） |
| created_at | timestamptz | 自動 |

---

### `agent_referrals` — エージェント経由流入記録

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid PK | 自動生成 |
| agent_code | text | agents.code |
| line_user_id | text | 訪問者のLINEユーザーID |
| visited_at | timestamptz | LIFF訪問日時 |
| registered_at | timestamptz | LINE友だち追加日時（onFollow時に記録） |
| created_at | timestamptz | 自動 |

**報酬計算**: `registered_at IS NOT NULL` の件数 × ¥1,000

---

## マイグレーション（未適用の場合に実行）

```sql
-- fp_gacha_sessions
ALTER TABLE fp_gacha_sessions ADD COLUMN IF NOT EXISTS no_show_checked boolean DEFAULT false;
ALTER TABLE fp_gacha_sessions ADD COLUMN IF NOT EXISTS meet_url text;

-- fp_fps
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS no_show_count integer DEFAULT 0;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS banned boolean DEFAULT false;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS banned_reason text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS qualification text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS age_ranges text[];
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS family_stages text[];

-- agents テーブル
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  contact_name text NOT NULL,
  email text UNIQUE NOT NULL,
  code text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- agent_referrals テーブル
CREATE TABLE IF NOT EXISTS agent_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_code text NOT NULL,
  line_user_id text,
  visited_at timestamptz,
  registered_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

---

## KVステート設計（GACHA_STATE）

| KVキー | 値 | TTL | 説明 |
|---|---|---|---|
| `phase:{uid}` | `'1'`〜`'4'` | なし | 現在の会話フェーズ |
| `attr_step:{uid}` | `'gender'`/`'job'`/`'age'`/`'marital'`/`'children'` | なし | Phase2の現在ステップ |
| `fp_reg:{uid}` | JSON | なし | FP登録フロー途中状態 |
| `client:{uid}` | JSON `{slots, fp_ids, session_id}` | なし | スロット選択待ち状態 |
| `fp_url_queue:{fpUserId}` | JSON配列 | なし | Google Calendar未連携FPへのURL待ちキュー |
| `fp_edit_token:{token}` | uid (text) | 1800秒 | 登録変更ワンタイムトークン |

---

## マスターデータ

### SPECIALTIES（専門領域）15種

| key | label |
|---|---|
| insurance | 保険・医療保障 |
| savings | 貯蓄 |
| household | 家計・収支改善 |
| cashflow | CF表・ライフイベント表作成 |
| asset | 資産形成 |
| investment | 投資（NISA・iDeCo） |
| retirement | 老後資金 |
| education | 教育資金 |
| inheritance | 相続 |
| biz_succ | 事業承継 |
| real_estate | 不動産 |
| tax | 節税 |
| tax_return | 税務・確定申告 |
| frugal | 節約 |
| other | その他 |

### AGE_RANGES: `20s` / `30s` / `40s` / `50s` / `60plus`

### LIFECYCLE_STAGES（レガシー）: `single` / `family_child` / `family_nochild` / `senior`

### family_stages（詳細キー）
`single_marry_yes` / `single_marry_no` / `married_no_child` / `married_child_home` / `married_child_out` / `divorced_child`

---

## 会話フロー（クライアント側）

### Phase 1 — 悩み深掘り（AI共感チャット）

- **AI**: Claude Haiku + `SYSTEM_COMMON` + `SYSTEM_PHASE1`（蔵戸ありさキャラ）
- **フロー**: ユーザーテキスト → DB保存 → アラートキーワード検知 → AI応答生成 → DB保存 → `PHASE1_QR` 付き返信
- 「悩みはそれぐらいです」→ Phase 2へ移行
- 「まだあります」→ 深掘りを続ける

---

### Phase 2 — 属性収集（Quick Reply）

ステップ順: **gender → job → age → marital → children**

| ステップ | 選択肢 |
|---|---|
| gender | 男性 / 女性 / その他 / 答えたくない |
| job | 会社員・公務員 / 自営業・フリーランス / パート・アルバイト / 専業主婦・主夫 / 学生 / 無職・求職中 / その他 |
| age | 20代 / 30代 / 40代 / 50代 / 60代以上 / 答えたくない |
| marital | 独身 / 既婚 / 離別・死別 / 答えたくない |
| children | 子なし / 1人 / 2人 / 3人以上 / 答えたくない |

全ステップ完了 → `saveAttr()` で `fp_gacha_sessions` にupsert → Phase 3へ

---

### Phase 3 — FP紹介同意

- `enterPhase3()` でconversations（全フェーズ・role=user）から悩みを取得
- プロフィール + 悩み箇条書きサマリー表示
- 「はい・お願いします」/「やっぱりお願いします」→ Phase 4 + `doFPMatch()`
- 「今は大丈夫です」→ 再確認QR
- 「それでも大丈夫です」→ Phase 1に戻る

---

### Phase 4 — 面談確定後サポート

**AI**: Claude Haiku + `SYSTEM_PHASE4`

**SYSTEM_PHASE4 要旨**:
- 面談前の不安解消・準備サポート専任
- 財務アドバイス・具体的提案は一切禁止（「FPの面談でご相談ください」）
- 日程変更・キャンセルは「このトーク上で承れます」と案内（メール・問い合わせ窓口への誘導禁止）
- 自分がFPであるかのような発言禁止

| テキスト | 処理 |
|---|---|
| `日程確認` | セッションから `scheduled_start` / `meet_url` を取得して表示 |
| `日程変更` | FP取得 → `aggregateSlots`（**翌日以降**のみ） → 空きあり：`slotFlex`送信 / 空きなし：FPに通知 |
| `キャンセル` | 確認QR（「はい、キャンセルします」「やっぱりやめます」）を表示 |
| `キャンセル確定` | Googleカレンダーイベント削除 → FPに通知 → `status='cancelled'` → `phase='1'` → `WELCOME_MSG` |
| `キャンセルしない` | 「そのままお待ちください😊」 |
| `FPが来ない_{sessionId}` | ノーショー処理（下記参照） |
| `面談中_{sessionId}` | 「面談をお楽しみください😊」 |
| `別FP希望` | ドタキャンFP除外・再マッチング・`slotFlex`送信 |
| `再マッチング不要` | `phase='1'` リセット |
| 日程変更系ワード | `text.includes('日程変更' / '変更したい' / '日程を変えたい')` → 日程変更フローへリダイレクト |
| その他テキスト | アラートキーワード検知 → AI応答（`PHASE4_QR`付き） |

---

## アラートキーワード検知（Phase1・Phase4共通）

検知ワード: `契約` `クソ` `詐欺` `詐欺師` `最悪` `返金` `ひどい` `訴える`

→ `env.ADMIN_LINE_ID` に通知（未設定の場合は無音で失敗）

---

## FP登録フロー

### Step 1: Webフォーム登録（`/fp/register`）

フォーム項目: 氏名 / メールアドレス / 電話番号(10桁以上) / FP資格 / 専門領域 / 対応年代 / 家族構成
バリデーション順: name → email → phone(10桁) → qualification → specialty

→ `fp_fps` にINSERT（`active=false`, `line_user_id=null`）

### Step 2: LINE照合

LINEで「登録」と送信 → メールアドレス入力 → `fp_fps` から照合 → `line_user_id` をPATCH → GoogleカレンダーOAuth URLをpush

### Step 3: Googleカレンダー連携（`/oauth/start` → `/oauth/callback`）

→ `google_calendar_id` + `google_refresh_token` を PATCH → `active=true`

### 登録変更（`/fp/edit?token={token}`）

「登録変更」とLINE送信 → ワンタイムトークン生成（UUID, TTL 1800秒）→ 変更URL push
変更可: 資格 / 専門領域 / 対応年代 / 家族構成
変更不可（管理者連絡要）: 氏名 / メール / 電話番号

---

## FP管理コマンド（fpMenu）

登録済みFPがLINEに送信するコマンド:

| テキスト | 処理 |
|---|---|
| `一時停止` / `停止` | `active=false` |
| `再開` | `active=true` |
| `登録変更` | ワンタイムトークン発行 → 編集URL送信 |
| `キャンセル` | 直近セッション相談者にQR通知（はい→`日程変更`/いいえ→`キャンセルしない`）→ `status='fp_cancelled'` |
| `日程変更` | 相談者に新スロット（`aggregateSlots`）送信 |
| URL送信（https://...） | `fp_url_queue` の相談者にURL転送 |
| その他 | 登録状態・ライフステージ・専門領域を表示 |

---

## マッチングロジック（doFPMatch）

1. `fp_gacha_sessions` からセッション属性取得
2. `conversations`（全フェーズ・role=user）から悩みテキスト取得
3. 年代変換: `'20代'→'20s'` ... `'60代以上'→'60plus'`
4. 婚姻×子ども → lifecycle + familyDetail 変換:

| marital | children | lifecycle | familyDetail |
|---|---|---|---|
| 既婚 | あり | family_child | married_child_home |
| 既婚 | なし | family_nochild | married_no_child |
| 離別・死別 | あり | family_child | divorced_child |
| その他 | - | single | null |

5. `categorizeConcern()`: Claude Haikuで悩みを SPECIALTIES キーに分類（最大3つ）
6. `findFPs()` フィルタ: specialties一致（必須）→ family_stages / lifecycle 照合 → age_ranges 照合
7. 0件 → フォールバック: active=true 全FPからランダム
8. FP未発見 → 「調整中」メッセージ

---

## Google Meet自動生成フロー（clientSlotTap）

1. 相談者がスロット選択（postback: `action=slot&idx=N`）
2. KV `client:{uid}` から `{slots, fp_ids, session_id}` 取得
3. `availFPsAtSlot()` でリアルタイム空き確認
4. `updateSession()` でスケジュール確定
5. `getSession()` でセッション属性（gender/age_range/job_status/marital_status）取得
6. `createMeetEvent(winner, slot, uid, env, sess)` でGoogleカレンダーイベント作成
   - **summary**: `FPガチャ 個別相談（{gender}・{age_range}・{job_status}）`
   - **description**: `相談者属性：{gender} / {age_range} / {job_status} / {marital_status}\nクライアントID: {uid}`
   - `conferenceDataVersion=1` で Google Meet URL 自動生成
7. 成功 → 相談者・FP双方にMeet URLをpush
   失敗 → `fp_url_queue` に積んで `notifyFP()`
8. 評価ジョブ登録（面談終了+1時間後）

### スロット表示ルール
- `aggregateSlots()` のループは `day = 1` 開始（**当日除外・翌日以降のみ**）
- 最大30日先、最大6スロット表示

---

## ノーショー検知・自動バンシステム

### 検知タイミング（毎時 cron: `processNoShowCheck`）

対象: `status=confirmed` & `no_show_checked=false` & `scheduled_start` が15〜90分前
→ `no_show_checked=true` に更新 → 相談者に確認QR送信

### ノーショー報告処理（`FPが来ない_{sessionId}`）

1. 管理者（`ADMIN_LINE_ID`）に通知
2. FP `no_show_count` +1
3. `no_show_count >= 2` → `active=false` / `banned=true` / 管理者に自動バン通知 → 相談者に謝罪 → Phase1リセット
4. バンなし → セッション `status='fp_noshow'` → 再マッチング提案QR（「別FP希望」「再マッチング不要」）

---

## LIFFエージェント追跡システム

### フロー

```
エージェント → 追跡URL（https://liff.line.me/2010168612-sAEWwrFD?ref={code}）
  → /liff/ref.html で LIFF 初期化
  → refパラメータ取得 + getProfile() で lineUserId 取得
  → POST /liff/track → agent_referrals に {agent_code, line_user_id, visited_at} INSERT
  → LINEボットへ遷移（isInClient: closeWindow / 外部: line.me/R/ti/p/@7OS8Lib）
  → onFollow() で registered_at を PATCH 更新
```

### エージェント管理ページ（`/agent/`）

- パスワード: `fpgacha2025`（sessionStorage で管理）
- API認証: リクエストヘッダー `X-Admin-Password: fpgacha2025`
- 機能: エージェント登録（POST `/api/agents`）/ 一覧表示（GET `/api/agents`）/ 削除（DELETE `/api/agents/{id}`）
- 登録者数・報酬額をリアルタイム集計表示
- データはSupabase `agents` テーブルに保存（localStorageは不使用）

---

## Cronスケジュール

| cron | 処理 |
|---|---|
| `0 * * * *`（毎時） | `processRatingJobs` / `processReminders` / `processNoShowCheck` |
| `0 0 * * *`（毎日0:00 UTC = 9:00 JST） | `processFollowUps` |

---

## HTTPエンドポイント一覧

| パス | メソッド | 処理 |
|---|---|---|
| `/` | GET | index.html（LP） |
| `/fp/register` | GET | register.html |
| `/fp/register-submit` | POST | FP Webフォーム登録 |
| `/fp/edit` | GET | edit.html |
| `/fp/edit-submit` | POST | 登録変更（トークン検証） |
| `/api/agents` | GET | エージェント一覧（認証要） |
| `/api/agents` | POST | エージェント登録（認証要） |
| `/api/agents/{id}` | DELETE | エージェント削除（認証要） |
| `/liff/ref` | GET | liff/ref.html（追跡ページ） |
| `/liff/track` | POST | agent_referrals にINSERT |
| `/oauth/start` | GET | Google OAuth開始 |
| `/oauth/callback` | GET | Google OAuthコールバック |
| `/api/set-reminder` | POST | リマインダー登録 |
| `/webhook` | POST | LINE Webhook受信 |

---

## AIシステムプロンプト（src/prompts.js）

| 定数 | 用途 |
|---|---|
| `SYSTEM_COMMON` | 全フェーズ共通ルール（再質問禁止・Markdown禁止等） |
| `SYSTEM_PHASE1` | Phase1: 蔵戸ありさキャラ・共感・深掘り（150文字以内・絵文字1〜2個） |
| `SYSTEM_PHASE2` | Phase2: 属性回答への共感（100文字以内・絵文字1個） |
| `SYSTEM_PHASE3` | Phase3: テンプレート出力（関数形式で concerns/jobLabel/ageLabel/familyLabel を受け取る） |
| `SYSTEM_PHASE4` | Phase4: 面談前サポート専任・財務アドバイス禁止・日程変更はトーク内対応（150文字以内・絵文字1〜2個） |

---

## 残課題・今後の実装候補

### 優先度高
- `ADMIN_LINE_ID` Secret を設定する: `npx wrangler secret put ADMIN_LINE_ID`
- **Stripe決済**: 相談者の有料プラン課金フロー
- **コーポレートサイト**: FPガチャの会社・サービス説明ページ

### 既知の不整合
- `onFollow()` (line 316) が `user_line_id` を使っている（古いカラム名）— 他は全て `line_user_id`

### 今後の実装候補
- Phase4「日程変更」後のslotTapでGoogleカレンダー旧イベント削除
- キャンセル確定時の `fp_rating_jobs` 削除
- ノーショー後の再マッチングに `findFPs()` による条件付きマッチング
- エージェントへの報酬振込フロー

---

## 関数一覧（src/index.js）

```
onFollow               フォローイベント処理・agent_referrals registered_at記録
onMessage              メッセージルーター
onPostback             ポストバックルーター
startFPReg             FP登録開始（LINE側）
fpRegStep              FP登録フロー継続
fpLifecycleTap         FP登録：ライフステージ選択
handleFPWebRegStart    Webフォーム登録処理
handleFPEditSubmit     登録変更処理（トークン検証）
oauthStart             Google OAuth開始
oauthCallback          Google OAuthコールバック
checkAdminPassword     X-Admin-Passwordヘッダー検証
handleGetAgents        GET /api/agents（登録者数集計付き）
handleCreateAgent      POST /api/agents
handleDeleteAgent      DELETE /api/agents/{id}
handleLiffTrack        POST /liff/track（agent_referrals INSERT）
handlePhase1           Phase1: AI共感チャット・アラートキーワード検知
enterPhase2            Phase2開始（gender質問）
handlePhase2Text       Phase2: 属性収集テキスト処理
enterPhase3            Phase3開始（サマリー表示）
handlePhase3Text       Phase3: 同意処理
handlePhase4           Phase4: 面談後サポート・各種分岐
doFPMatch              FPマッチング実行
saveAttr               fp_gacha_sessionsへ属性保存（upsert）
clientSlotTap          スロット選択・Meet URL生成・セッション確定
fpMenu                 FP管理コマンド処理（7コマンド）
clientRate             評価受信
processRatingJobs      評価ジョブ処理（cron）
processNoShowCheck     ノーショー確認送信（cron）
processFollowUps       フォローアップ処理（cron）
aggregateSlots         Google Calendar空き枠集計（day=1〜翌日以降）
availFPsAtSlot         スロット空き再確認
createMeetEvent        Google Meetイベント作成（セッション属性をsummary/descriptionに含める）
categorizeConcern      AI悩み分類（Claude Haiku）
generateChatResponse   AI応答生成（Claude Haiku）
findFPs                FP条件マッチング
getHistory             会話履歴取得（直近30件・ロール交互正規化）
saveMessage            会話履歴保存
refreshToken           Google OAuthトークンリフレッシュ
notifyFP               FP通知（URLキュー方式フォールバック）
getFP / getFPById      FP取得
patchFP                FP情報PATCH更新
getSession             セッション取得
updateSession          セッション更新（updated_at自動設定）
createSession          セッション作成
createRatingJob        評価ジョブ作成
handleSetReminder      リマインダー登録
processReminders       リマインダー送信処理（cron）
allReset               ユーザーKV全削除
```
