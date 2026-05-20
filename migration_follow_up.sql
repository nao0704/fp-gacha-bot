-- ════════════════════════════════════════
--  相談後フォローアップ用カラム追加
--  対象テーブル: fp_gacha_sessions
-- ════════════════════════════════════════

ALTER TABLE fp_gacha_sessions
  ADD COLUMN IF NOT EXISTS consultation_date   timestamptz,
  ADD COLUMN IF NOT EXISTS fp_line_user_id     text,
  ADD COLUMN IF NOT EXISTS fp_result           text,
  ADD COLUMN IF NOT EXISTS client_result       text,
  ADD COLUMN IF NOT EXISTS commission_flag     boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS result_notified_at  timestamptz;

-- フォローアップクエリ用インデックス（未通知の前日セッションを高速検索）
CREATE INDEX IF NOT EXISTS idx_fp_gacha_sessions_followup
  ON fp_gacha_sessions(consultation_date)
  WHERE result_notified_at IS NULL;
