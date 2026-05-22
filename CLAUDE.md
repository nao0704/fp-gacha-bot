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

# ユーザーのKV全削除（オールリセット相当）
# LINEで「オールリセット」と送ると allReset() が実行される
```

---

## プロジェクト概要

**FPガチャ LINE Bot**。お金の悩みをAIが分析し、最適なFP（ファイナンシャルプランナー）をガチャ方式でマッチング。Google Meetを自動生成してオンライン相談を予約まで完結させる。

---

## インフラ構成

| レイヤー | サービス | 用途 |
|---|---|---|
| サーバーレス実行 | Cloudflare Workers | LINE Webhookハンドラ・API |
| 静的アセット | Cloudflare Workers Assets | HTML登録フォーム配信 |
| KVストア | Cloudflare KV (`GACHA_STATE`) | セッション状態管理 |
| データベース | Supabase (PostgreSQL) | 会話履歴・FP情報・セッション |
| メッセージング | LINE Messaging API | チャットUI |
| AI | Claude Haiku (`claude-haiku-4-5-20251001`) | 共感応答・悩み分類 |
| カレンダー | Google Calendar API | 空き枠取得・Google Meet生成 |

**Workers URL**: `https://fp-gacha-bot.parcy0704.workers.dev`
**Supabase URL**: `https://spfyisnsjobyaebsradv.supabase.co`

---

## Cloudflare Workers Secrets

以下のすべてが `wrangler secret put` で設定済みであること（★は未設定・要対応）：

| Secret名 | 内容 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API アクセストークン |
| `LINE_CHANNEL_SECRET` | LINE署名検証用シークレット |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `ANTHROPIC_API_KEY` | Claude API キー |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth クライアントID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth クライアントシークレット |
| `ADMIN_LINE_ID` | ★管理者のLINEユーザーID（未設定）`npx wrangler secret put ADMIN_LINE_ID` で設定要 |

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
| id | uuid (PK) | 自動生成 |
| line_user_id | text | LINEユーザーID |
| role | text | `'user'` or `'assistant'` |
| content | text | メッセージ本文 |
| phase | int | 1〜4（会話フェーズ） |
| created_at | timestamptz | 自動 |

**注意**: `onFollow` 関数の既存ユーザーチェック（line 316）のみ古い `user_line_id` を使っている。他は全て `line_user_id`。

---

### `fp_fps` — FP（ファイナンシャルプランナー）情報

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| name | text | FP氏名 |
| email | text (unique) | メールアドレス |
| phone | text | 電話番号（10桁以上） |
| qualification | text | 資格名 |
| line_user_id | text | LINEユーザーID（Web登録直後はNULL） |
| lifecycle_stages | text[] | レガシー用ライフステージキー配列 |
| specialties | text[] | 専門領域キー配列（後述のSPECIALTIES） |
| age_ranges | text[] | 対応年代キー配列（`20s`/`30s`/`40s`/`50s`/`60plus`） |
| family_stages | text[] | 詳細家族構成キー配列 |
| active | bool | 受付中かどうか（default: false） |
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
| id | uuid (PK) | 自動生成 |
| client_line_user_id | text | 相談者のLINEユーザーID |
| fp_line_user_id | text | マッチしたFPのLINEユーザーID |
| selected_fp_id | uuid | マッチしたFPのfp_fps.id |
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
| id | uuid (PK) | 自動生成 |
| session_id | uuid | fp_gacha_sessions.id |
| client_line_user_id | text | 相談者LINEID |
| fp_name | text | FP氏名 |
| send_at | timestamptz | 送信予定時刻（面談終了+1時間） |
| sent | bool | 送信済みフラグ |

---

### `fp_reminders` — リマインダー送信ジョブ

| カラム | 型 | 説明 |
|---|---|---|
| id | uuid (PK) | 自動生成 |
| session_id | uuid | fp_gacha_sessions.id |
| client_line_user_id | text | 相談者LINEID |
| fp_line_user_id | text | FPLINEID |
| consultation_time | timestamptz | 面談日時 |
| send_at | timestamptz | 送信予定（面談1時間前） |
| sent | bool | 送信済みフラグ |

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

### SPECIALTIES（専門領域）

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

### AGE_RANGES

`20s` / `30s` / `40s` / `50s` / `60plus`

### LIFECYCLE_STAGES（レガシー）

`single` / `family_child` / `family_nochild` / `senior`

### family_stages（詳細キー）

`single_marry_yes` / `single_marry_no` / `married_no_child` / `married_child_home` / `married_child_out` / `divorced_child`

---

## 会話フロー（クライアント側）

### Phase 1 — 悩み深掘り（AI共感チャット）

- **AI**: Claude Haiku + `SYSTEM_COMMON` + `SYSTEM_PHASE1`（蔵戸ありさキャラ）
- **フロー**: ユーザーテキスト → DB保存 → **アラートキーワード検知** → AI応答生成 → DB保存 → `PHASE1_QR`（「悩みはそれぐらいです」「まだあります」）付きで返信
- 「悩みはそれぐらいです」→ Phase 2へ移行
- 「まだあります」→ 深掘りを続ける

**アラートキーワード**（Phase1〜4共通）:
`契約` `クソ` `詐欺` `詐欺師` `最悪` `返金` `ひどい` `訴える`
→ `env.ADMIN_LINE_ID` に通知（未設定注意）

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

- `enterPhase3()` でconversationsから悩みを取得（role=user、全フェーズ）
- プロフィール + 悩み箇条書きサマリー表示
- 「はい・お願いします」/「やっぱりお願いします」→ **Phase 4 + doFPMatch()**
- 「今は大丈夫です」→ 再確認QR
- 「それでも大丈夫です」→ Phase 1に戻る

---

### Phase 4 — 面談確定後サポート

**AI**: Claude Haiku + `SYSTEM_PHASE4`（面談前サポート専任、財務アドバイス禁止）

| テキスト | 処理 |
|---|---|
| `日程確認` | セッションからscheduled_start・meet_urlを取得して表示 |
| `日程変更` | FP取得 → aggregateSlots → 空きあり：slotFlex送信 / 空きなし：FPに通知 |
| `キャンセル` | 確認QR（「はい、キャンセルします」「やっぱりやめます」）を表示 |
| `キャンセル確定` | Googleカレンダーイベント削除 → FPにpush → status='cancelled' → phase='1'リセット → WELCOME_MSG |
| `キャンセルしない` | 「そのままお待ちください」 |
| `FPが来ない_{sessionId}` | ノーショー処理（後述） |
| `面談中_{sessionId}` | 「面談をお楽しみください」 |
| `別FP希望` | ドタキャンFP除外して再マッチング・slotFlex送信 |
| `再マッチング不要` | phase='1'リセット |
| その他テキスト | アラートキーワード検知 → AI応答（PHASE4_QR付き） |

---

## FP登録フロー

### Step 1: Webフォーム登録

**URL**: `/fp/register` （`public/fp/register.html`）

フォーム項目：
- STEP1: 氏名 / メールアドレス / 電話番号（10桁以上）
- STEP2: FP資格（checkboxes、複数選択可・1つ以上必須、name="qualifications"）
- STEP3: 専門領域（checkboxes、15種、name="specialties"）
- STEP4: 対応年代（checkboxes）
- STEP5: 家族構成（checkboxes）
- hidden: `formats=online`（送信はするが保存しない）

バリデーション順: name → email → phone(10桁) → qualifications(1つ以上) → specialty

**資格選択肢**: CFP / 1級FP技能士 / AFP / 2級FP技能士 / 3級FP技能士 / 生命保険協会認定FP（生保大学全課程修了）/ 3ヶ月以内に3級取得予定 / 半年以内に2級・AFP取得予定 / 1年以内に1級・CFP取得予定

**handleFPWebRegStart の資格処理**: `data.getAll('qualifications')` で配列取得 → `join('・')` で結合して `qualification`（text型）に保存

`/fp/register-submit` POST → `handleFPWebRegStart()` → Supabase `fp_fps` にINSERT（`active=false`, `line_user_id=null`）

---

### Step 2: LINE照合（FP側）

LINEで「登録」と送信 → `startFPReg()` → メールアドレス入力を促す → fp_fpsから照合 → マッチで `line_user_id` をPATCH update → Googleカレンダー連携URLをpush

---

### Step 3: Googleカレンダー連携

1. FPがLINEでOAuth URLをタップ
2. `/oauth/start` → Google OAuth認証画面（stateにLINEユーザーID）
3. `/oauth/callback` → `refresh_token` + `calendar_id` を取得
4. `fp_fps` を PATCH update（`google_calendar_id`, `google_refresh_token`, `active=true`）

---

### 登録変更

LINEで「登録変更」と送信 → ワンタイムトークン生成（UUID）→ KVに `fp_edit_token:{token}` → uid（TTL 1800秒）→ 変更URL（`/fp/edit?token={token}`）をpush

**変更可能項目** (`public/fp/edit.html`): 資格 / 専門領域 / 対応年代 / 家族構成
**変更不可**（管理者連絡要）: 氏名 / メールアドレス / 電話番号

---

## FP管理コマンド（fpMenu）

FPとして登録済みのLINEユーザーが送るテキスト：

| テキスト | 処理 |
|---|---|
| `一時停止` / `停止` | `active=false` にPATCH |
| `再開` | `active=true` にPATCH |
| `登録変更` | ワンタイムトークン発行 → 編集URL送信 |
| `キャンセル` | 直近セッションの相談者にQR通知（「はい→日程変更」「いいえ→キャンセルしない」）→ status='fp_cancelled' |
| `日程変更` | 相談者のKVにslots保存 → slotFlex送信 |
| URL送信（https://...） | `handleFPUrlForward()` → fp_url_queueの相談者に転送 |
| その他 | 登録状態・ライフステージ・専門領域を表示 |

---

## マッチングロジック（doFPMatch）

1. `fp_gacha_sessions` からセッション属性を取得
2. `conversations` から全悩みテキストを取得（role=user、全フェーズ）
3. 年代変換: `'20代'→'20s'` ... `'60代以上'→'60plus'`
4. 婚姻×子ども → lifecycle + familyDetail 変換:

| marital | children | lifecycle | familyDetail |
|---|---|---|---|
| 既婚 | あり | family_child | married_child_home |
| 既婚 | なし | family_nochild | married_no_child |
| 離別・死別 | あり | family_child | divorced_child |
| その他 | - | single | null |

5. `categorizeConcern()`: Claude Haikuで悩みテキストをSPECIALTIESキーに分類（最大3つ）
6. `findFPs()`: active=true のFPを全取得してフィルタ

**findFPs フィルタ条件**:
- `specialties` に categories のどれかが含まれる（必須）
- `family_stages` 設定済みFP → familyDetailで照合 / 未設定 → legacy lifecycle_stagesで照合
- `age_ranges` 設定済みFP → ageKeyで照合

7. 0件の場合 → フォールバック：active=true の全FPからランダム選出
8. FPが見つからない場合 → 「調整中」メッセージ

**スロット確認あり（google_refresh_token設定済み）**:
→ `aggregateSlots()` → 空きあり: slotFlex / 空きなし: FPに連絡

**スロット確認なし**:
→ 「近日中にご連絡」メッセージ

---

## Google Meet自動生成フロー（clientSlotTap）

1. 相談者がslotFlexでスロット選択（postback: `action=slot&idx=N`）
2. KVから `client:{uid}` 取得（slots, fp_ids, session_id）
3. `availFPsAtSlot()` でリアルタイム空き確認
4. 空きFPからランダム選出（winner）
5. **`createMeetEvent(winner, slot, uid, env)`** でGoogleカレンダーにイベント作成
   - conferenceDataVersion=1 で Google Meet URL を自動生成
   - イベントサマリー: `'FPガチャ 個別相談'`
6. セッション更新: `scheduled_start`, `scheduled_end`, `meet_url`, `status='confirmed'`
7. resultFlex（Flex Message）を相談者に送信
8. meetUrl取得成功 → 相談者・FP双方にMeet URLをpush
   失敗 → fp_url_queueに積んでFPにnotifyFP()
9. `createRatingJob()` で面談終了+1時間後の評価ジョブを登録

---

## ノーショー検知・自動バンシステム

### 検知（毎時cronで processNoShowCheck）

- 対象: `status=confirmed` かつ `no_show_checked=false` かつ `scheduled_start` が15〜90分前
- `no_show_checked=true` に更新
- 相談者に確認QR送信:
  - 「FPが来ない」→ `FPが来ない_{session_id}` を送信
  - 「面談中です」→ `面談中_{session_id}` を送信

### ノーショー報告処理（handlePhase4 内）

**`FPが来ない_{sessionId}` 受信時**:
1. 管理者（ADMIN_LINE_ID）に通知
2. FPの `no_show_count` を+1
3. `no_show_count >= 2` の場合:
   - `active=false`, `banned=true`, `banned_reason='2回連続ノーショーによる自動バン'`
   - 管理者に自動バン通知
   - 相談者に謝罪 → Phase1リセット → WELCOME_MSG
4. バンなしの場合: セッション `status='fp_noshow'` → 再マッチング提案QR（「別のFPに繋いでほしい」「今日は結構です」）

**`別FP希望` 受信時**:
- ドタキャンFP（selected_fp_id）を除外 + `google_refresh_token` 必須でフィルタ
- 残りFPからランダム選出 → aggregateSlots → slotFlex送信

**`再マッチング不要` 受信時**:
- Phase1リセット

---

## Cronスケジュール

| cron | 処理 |
|---|---|
| `0 * * * *`（毎時0分） | processRatingJobs / processReminders / processNoShowCheck |
| `0 0 * * *`（毎日0:00 UTC = 9:00 JST） | processFollowUps |

---

## HTTPエンドポイント一覧

| パス | メソッド | 処理 |
|---|---|---|
| `/` | GET | index.html配信 |
| `/fp/register` | GET | register.html配信 |
| `/fp/register-submit` | POST | FP Webフォーム登録処理 |
| `/fp/edit` | GET | edit.html配信 |
| `/fp/edit-submit` | POST | 登録変更処理（トークン検証） |
| `/oauth/start` | GET | Google OAuth開始（state=LINE uid） |
| `/oauth/callback` | GET | Google OAuthコールバック |
| `/api/set-reminder` | POST | リマインダー登録 |
| `/webhook` | POST | LINE Webhook受信 |

---

## AIシステムプロンプト（src/prompts.js）

| 定数 | 用途 |
|---|---|
| `SYSTEM_COMMON` | 全フェーズ共通ルール（再質問禁止・Markdown禁止等） |
| `SYSTEM_PHASE1` | Phase1専用：蔵戸ありさキャラ・共感・深掘り |
| `SYSTEM_PHASE2` | Phase2専用：属性回答への共感 |
| `SYSTEM_PHASE3` | Phase3専用：テンプレート出力（関数形式）|
| `SYSTEM_PHASE4` | Phase4専用：面談前サポート専任・財務アドバイス禁止 |

---

## 残課題・注意事項

### 必須対応（未設定）
- `ADMIN_LINE_ID` secretを設定する: `npx wrangler secret put ADMIN_LINE_ID`
  - 未設定の場合、アラートキーワード検知・ノーショー通知・自動バン通知が全て無音で失敗する

### Supabaseマイグレーション要確認
`fp_gacha_sessions` に以下のカラムが存在しない場合は追加:
```sql
ALTER TABLE fp_gacha_sessions ADD COLUMN IF NOT EXISTS no_show_checked boolean DEFAULT false;
ALTER TABLE fp_gacha_sessions ADD COLUMN IF NOT EXISTS meet_url text;
```

`fp_fps` に以下のカラムが存在しない場合は追加:
```sql
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS no_show_count integer DEFAULT 0;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS banned boolean DEFAULT false;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS banned_reason text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS qualification text;
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS age_ranges text[];
ALTER TABLE fp_fps ADD COLUMN IF NOT EXISTS family_stages text[];
```

### 既知の不整合
- `onFollow()` (line 316) が `user_line_id` を使っている（古いカラム名）。他は全て `line_user_id`。
- `fpMenu` の「キャンセル」「日程変更」は直近1件のセッションのみ対象（複数セッション未対応）

### 今後の実装候補
- Phase4「日程変更」後のslotTapでGoogleカレンダーの旧イベント削除
- FPバン後の代替マッチングにfindFPs()を使った条件付き再マッチング
- キャンセル確定時のfp_rating_jobsの削除
- 管理者向けダッシュボード

---

## 関数一覧（src/index.js）

```
onFollow          フォローイベント処理
onMessage         メッセージルーター
onPostback        ポストバックルーター
startFPReg        FP登録開始（LINE側）
fpRegStep         FP登録フロー継続
fpLifecycleTap    FP登録：ライフステージ選択
handleFPWebRegStart Webフォーム登録処理
handleFPEditSubmit  登録変更処理
oauthStart        Google OAuth開始
oauthCallback     Google OAuthコールバック
handlePhase1      Phase1：AI共感チャット
enterPhase2       Phase2開始（gender質問）
handlePhase2Text  Phase2：属性テキスト処理
enterPhase3       Phase3開始（サマリー表示）
handlePhase3Text  Phase3：同意処理
handlePhase4      Phase4：面談後サポート
doFPMatch         FPマッチング実行
saveAttr          fp_gacha_sessionsへ属性保存
clientSlotTap     スロット選択・Meet生成
fpMenu            FP管理コマンド処理
clientRate        評価受信
processRatingJobs 評価ジョブ処理（cron）
processNoShowCheck ノーショー確認送信（cron）
processFollowUps  フォローアップ処理（cron）
aggregateSlots    Google Calendar空き枠集計
availFPsAtSlot    スロット空き再確認
createMeetEvent   Google Meetイベント作成
categorizeConcern AI悩み分類
generateChatResponse AI応答生成
findFPs           FP条件マッチング
getHistory        会話履歴取得
saveMessage       会話履歴保存
refreshToken      Google OAuthトークンリフレッシュ
getFP / getFPById FP取得
patchFP           FP情報PATCH更新
updateSession     セッション更新
createSession     セッション作成
createRatingJob   評価ジョブ作成
```
