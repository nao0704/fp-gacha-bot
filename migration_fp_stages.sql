-- ════════════════════════════════════════
--  FPの対応世代・家族構成、クライアントの詳細ライフステージ追加
-- ════════════════════════════════════════

-- FPマスター: 対応世代と得意な家族構成を追加
ALTER TABLE fp_fps
  ADD COLUMN IF NOT EXISTS age_ranges    text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS family_stages text[] DEFAULT '{}';

-- ガチャセッション: クライアントの詳細ライフステージを追加
ALTER TABLE fp_gacha_sessions
  ADD COLUMN IF NOT EXISTS lifecycle_detail text;

-- インデックス
CREATE INDEX IF NOT EXISTS idx_fp_fps_age_ranges    ON fp_fps USING GIN(age_ranges);
CREATE INDEX IF NOT EXISTS idx_fp_fps_family_stages ON fp_fps USING GIN(family_stages);
