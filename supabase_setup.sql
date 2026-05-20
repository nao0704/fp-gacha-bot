-- ════════════════════════════════════════
--  FPガチャ Supabase スキーマ
-- ════════════════════════════════════════

-- FP マスター
create table if not exists fps (
  id                   uuid primary key default gen_random_uuid(),
  line_user_id         text unique not null,
  name                 text not null,
  lifecycle_stages     text[] not null default '{}',
  specialties          text[] not null default '{}',
  google_calendar_id   text,
  google_refresh_token text,
  active               boolean not null default true,
  registered_at        timestamptz not null default now()
);

-- ガチャセッション
create table if not exists gacha_sessions (
  id                   uuid primary key default gen_random_uuid(),
  client_line_user_id  text not null,
  concern              text,
  lifecycle_stage      text,
  age_range            text,
  matched_categories   text[] default '{}',
  selected_fp_id       uuid references fps(id),
  scheduled_start      timestamptz,
  scheduled_end        timestamptz,
  status               text not null default 'started',
  -- started → categorized → slots_shown → confirmed → completed → rated
  rating               integer check (rating between 1 and 5),
  -- 相談後フォローアップ用（migration_follow_up.sql で追加）
  consultation_date    timestamptz,
  fp_line_user_id      text,
  fp_result            text,             -- 成約 / 失注 / 継続中
  client_result        text,             -- 契約予定 / 未契約 / 検討中
  commission_flag      boolean default false,
  result_notified_at   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 評価送信ジョブ（毎時cronで確認）
create table if not exists rating_jobs (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid references gacha_sessions(id),
  client_line_user_id  text not null,
  fp_name              text not null,
  send_at              timestamptz not null,
  sent                 boolean not null default false
);

-- インデックス
create index if not exists idx_fps_active on fps(active);
create index if not exists idx_gacha_sessions_client on gacha_sessions(client_line_user_id);
create index if not exists idx_rating_jobs_pending on rating_jobs(send_at) where sent = false;
