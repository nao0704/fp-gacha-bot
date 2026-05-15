// ════════════════════════════════════════════════════════
//  FP ガチャ LINE Bot — Cloudflare Workers
// ════════════════════════════════════════════════════════

const JST             = 9 * 60 * 60 * 1000;
const SLOT_MS         = 3_600_000; // 1時間
const MAX_DAYS        = 30;
const SLOTS_TO_SHOW   = 6;
const KV_TTL          = 3600;
const WEEKDAYS        = ['日','月','火','水','木','金','土'];

const LIFECYCLE_STAGES = [
  { key: 'single',         label: '独身' },
  { key: 'family_child',   label: '世帯・子あり' },
  { key: 'family_nochild', label: '世帯・子なし' },
  { key: 'senior',         label: '高齢者' },
];
const AGE_RANGES = [
  { key: '20s', label: '20代' }, { key: '30s', label: '30代' },
  { key: '40s', label: '40代' }, { key: '50s', label: '50代' },
  { key: '60plus', label: '60代以上' },
];
const SPECIALTIES = [
  { key: 'insurance',   label: '保険・医療保障' },
  { key: 'savings',     label: '貯蓄' },
  { key: 'household',   label: '家計・収支改善' },
  { key: 'cashflow',    label: 'キャッシュフロー表作成' },
  { key: 'asset',       label: '資産形成' },
  { key: 'investment',  label: '投資（NISA・iDeCo）' },
  { key: 'retirement',  label: '老後資金' },
  { key: 'education',   label: '教育資金' },
  { key: 'inheritance', label: '相続' },
  { key: 'biz_succ',    label: '事業承継' },
  { key: 'real_estate', label: '不動産' },
  { key: 'tax',         label: '節税' },
  { key: 'frugal',      label: '節約' },
  { key: 'other',       label: 'その他' },
];

// ── Main Handler ──────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/oauth/start')    return oauthStart(request, env);
    if (url.pathname === '/oauth/callback') return oauthCallback(request, env);
    if (request.method === 'GET')           return new Response('FP Gacha Bot 🎲', { status: 200 });
    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('Not Found', { status: 404 });
    }

    const body = await request.text();
    const sig  = request.headers.get('x-line-signature');
    if (!sig || !(await verifySig(body, sig, env.LINE_CHANNEL_SECRET))) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { events } = JSON.parse(body);
    ctx.waitUntil(Promise.all(events.map(e => {
      if (e.type === 'message'  && e.message.type === 'text') return onMessage(e, env);
      if (e.type === 'postback')  return onPostback(e, env);
      if (e.type === 'follow')    return onFollow(e, env);
    })));
    return new Response('OK', { status: 200 });
  },

  // 毎時cron：評価リクエスト送信
  async scheduled(event, env) {
    await processRatingJobs(env);
  },
};

// ── Follow ────────────────────────────────────────────
async function onFollow(ev, env) {
  await reply(ev.replyToken,
    'FPガチャへようこそ！ 🎲\n\n' +
    'お金に関するお悩みをAIが分析し、最適なFP（ファイナンシャルプランナー）をマッチングします。\n\n' +
    '▶ 相談したい方：悩みをそのまま送ってください\n' +
    '▶ FPとして登録する方：「登録」と送ってください', env);
}

// ── Message Router ────────────────────────────────────
async function onMessage(ev, env) {
  const uid  = ev.source.userId;
  const text = ev.message.text.trim();
  const rt   = ev.replyToken;

  // FP登録開始
  if (text === '登録') { await startFPReg(uid, rt, env); return; }

  // FP登録フロー継続
  const fpReg = await kv(env).get(`fp_reg:${uid}`);
  if (fpReg) { await fpRegStep(uid, text, rt, JSON.parse(fpReg), env); return; }

  // 登録済みFPのメニュー
  const fp = await getFP(uid, env);
  if (fp) { await fpMenu(uid, text, rt, fp, env); return; }

  // クライアント相談フロー継続
  const cs = await kv(env).get(`client:${uid}`);
  if (cs) { await clientStep(uid, text, rt, JSON.parse(cs), env); return; }

  // 新規クライアント
  await startClient(uid, rt, env);
}

// ── Postback Router ───────────────────────────────────
async function onPostback(ev, env) {
  const uid = ev.source.userId;
  const rt  = ev.replyToken;
  const p   = new URLSearchParams(ev.postback.data);
  const act = p.get('action');

  if (act === 'fp_lc')   return fpLifecycleTap(uid, rt, p, env);
  if (act === 'lc')      return clientLifecycleTap(uid, rt, p, env);
  if (act === 'age')     return clientAgeTap(uid, rt, p, env);
  if (act === 'slot')    return clientSlotTap(uid, rt, p, env);
  if (act === 'rate')    return clientRate(uid, rt, p, env);
}

// ══════════════════════════════════════════════════════
//  FP Registration
// ══════════════════════════════════════════════════════
async function startFPReg(uid, rt, env) {
  const existing = await getFP(uid, env);
  if (existing) {
    await reply(rt, `${existing.name}さん、すでに登録済みです 🌿\n\n「一時停止」や「再開」で受付状態を切り替えられます。`, env);
    return;
  }
  await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ step: 'name' }), { expirationTtl: KV_TTL });
  await reply(rt, 'FP登録を開始します 🌿\n\nお名前（フルネーム）を教えてください。\nクライアントへの表示に使用します。', env);
}

async function fpRegStep(uid, text, rt, state, env) {
  switch (state.step) {
    case 'name': {
      const name = text.trim();
      await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ ...state, step: 'lifecycle', name }), { expirationTtl: KV_TTL });
      await replyQR(rt, `${name}さん、よろしくお願いします！\n\n対応できるライフステージを選んでください。\n複数ある場合は順番にタップし、最後に「完了」を選択してください。`,
        lcQRItems([], 'fp_lc'), env);
      break;
    }
    case 'specialties': {
      const nums = text.split(/[\s,、]+/).map(n => parseInt(n)).filter(n => n >= 1 && n <= SPECIALTIES.length);
      if (!nums.length) { await reply(rt, '番号をスペース区切りで入力してください（例：1 3 5）', env); return; }
      const sps = nums.map(n => SPECIALTIES[n - 1].key);
      await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ ...state, step: 'oauth', specialties: sps }), { expirationTtl: KV_TTL });

      const oauthUrl = `${env.WORKER_URL}/oauth/start?state=${uid}`;
      await reply(rt,
        `専門領域を登録しました ✅\n\n次にGoogleカレンダーを連携してください。\nリンクをタップして「許可」するだけです 👇\n${oauthUrl}`, env);
      break;
    }
    default:
      await reply(rt, 'セッションが切れました。「登録」から再度お試しください。', env);
  }
}

async function fpLifecycleTap(uid, rt, p, env) {
  const key    = p.get('key');
  const raw    = await kv(env).get(`fp_reg:${uid}`);
  if (!raw) return;
  const state  = JSON.parse(raw);
  const stages = state.lifecycle_stages || [];

  if (key === 'done') {
    if (!stages.length) { await reply(rt, '最低1つ選んでください。', env); return; }
    await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ ...state, step: 'specialties', lifecycle_stages: stages }), { expirationTtl: KV_TTL });
    const list = SPECIALTIES.map((s, i) => `${i + 1}. ${s.label}`).join('\n');
    await reply(rt, `ライフステージを登録しました ✅\n\n次に専門領域を選んでください。\n番号をスペース区切りで入力してください。\n\n${list}\n\n例：1 3 5 7`, env);
    return;
  }

  if (!stages.includes(key)) stages.push(key);
  await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ ...state, lifecycle_stages: stages }), { expirationTtl: KV_TTL });
  const labels = stages.map(k => LIFECYCLE_STAGES.find(s => s.key === k)?.label).join('・');
  await replyQR(rt, `選択中：${labels}\n追加するか「完了」を選んでください。`,
    lcQRItems(stages, 'fp_lc'), env);
}

// ライフステージクイックリプライ items（選択済みを除外 + 完了ボタン）
function lcQRItems(selected, action) {
  return [
    ...LIFECYCLE_STAGES.filter(s => !selected.includes(s.key)).map(s => ({
      type: 'action',
      action: { type: 'postback', label: s.label, data: `action=${action}&key=${s.key}`, displayText: s.label },
    })),
    { type: 'action', action: { type: 'postback', label: '✅ 完了', data: `action=${action}&key=done`, displayText: '完了' } },
  ];
}

// ══════════════════════════════════════════════════════
//  Google OAuth
// ══════════════════════════════════════════════════════
async function oauthStart(request, env) {
  const uid = new URL(request.url).searchParams.get('state');
  if (!uid) return new Response('Missing state', { status: 400 });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     env.GOOGLE_OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',  `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar');
  authUrl.searchParams.set('access_type',   'offline');
  authUrl.searchParams.set('prompt',        'consent');
  authUrl.searchParams.set('state',         uid);
  return Response.redirect(authUrl.toString(), 302);
}

async function oauthCallback(request, env) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');
  const uid  = url.searchParams.get('state');
  if (!code || !uid) return new Response('Missing params', { status: 400 });

  // code → tokens
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, grant_type: 'authorization_code',
      client_id:     env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri:  `${env.WORKER_URL}/oauth/callback`,
    }),
  });
  const tokens = await tokRes.json();
  if (!tokens.refresh_token) {
    console.log('[oauth] no refresh_token:', JSON.stringify(tokens));
    return new Response('OAuth error: refresh_token not returned. Try again.', { status: 400 });
  }

  // プライマリカレンダーID取得
  const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const calData  = await calRes.json();
  const calId    = calData.id || 'primary';

  // FP登録ステートから情報取得 → Supabaseに保存
  const raw   = await kv(env).get(`fp_reg:${uid}`);
  const state = raw ? JSON.parse(raw) : {};

  await saveFP(uid, {
    name:                 state.name || 'FP',
    lifecycle_stages:     state.lifecycle_stages || [],
    specialties:          state.specialties || [],
    google_calendar_id:   calId,
    google_refresh_token: tokens.refresh_token,
  }, env);

  await kv(env).delete(`fp_reg:${uid}`);

  // FPにLINEで完了通知
  await push(uid, `Googleカレンダーの連携が完了しました ✅\n\nFP登録が完了です！\n予約が入り次第LINEでお知らせします 🌿\n\n「一時停止」：受付を一時停止\n「再開」：受付を再開`, env);

  return new Response(`
    <html><head><meta charset="utf-8"></head>
    <body style="font-family:sans-serif;text-align:center;padding:48px 24px">
    <h2>✅ 連携完了！</h2>
    <p>FPガチャへの登録が完了しました。<br>LINEアプリに戻ってご確認ください。</p>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ══════════════════════════════════════════════════════
//  Client Consultation Flow
// ══════════════════════════════════════════════════════
async function startClient(uid, rt, env) {
  await kv(env).put(`client:${uid}`, JSON.stringify({ step: 'concern' }), { expirationTtl: KV_TTL });
  await reply(rt,
    'FPガチャへようこそ！ 🎲\n\n' +
    'どんなお金の悩みでも大丈夫です。\n今のお悩みをそのまま送ってください。\n\n' +
    '（例：老後の資金が心配、保険を見直したい、子どもの教育費が不安　など）', env);
}

async function clientStep(uid, text, rt, state, env) {
  if (state.step === 'concern') {
    await kv(env).put(`client:${uid}`, JSON.stringify({ step: 'lifecycle', concern: text }), { expirationTtl: KV_TTL });
    await replyQR(rt, 'ありがとうございます 🌿\nご自身のライフステージを教えてください。',
      LIFECYCLE_STAGES.map(s => ({ type: 'action', action: { type: 'postback', label: s.label, data: `action=lc&key=${s.key}`, displayText: s.label } })),
      env);
  }
}

async function clientLifecycleTap(uid, rt, p, env) {
  const lcKey = p.get('key');
  const raw   = await kv(env).get(`client:${uid}`);
  if (!raw) return startClient(uid, rt, env);
  const state = JSON.parse(raw);

  await kv(env).put(`client:${uid}`, JSON.stringify({ ...state, step: 'age', lifecycle: lcKey }), { expirationTtl: KV_TTL });
  await replyQR(rt, 'ありがとうございます！\nご年代を教えてください。',
    AGE_RANGES.map(a => ({ type: 'action', action: { type: 'postback', label: a.label, data: `action=age&key=${a.key}`, displayText: a.label } })),
    env);
}

async function clientAgeTap(uid, rt, p, env) {
  const ageKey = p.get('key');
  const raw    = await kv(env).get(`client:${uid}`);
  if (!raw) return startClient(uid, rt, env);
  const { concern, lifecycle } = JSON.parse(raw);

  await reply(rt, 'ありがとうございます ✅\nAIがお悩みを分析して最適なFPを探しています… 🔍\n少しお待ちください。', env);

  // AIで分類 → FP検索 → スロット集計
  const categories = await categorizeConcern(concern, env);
  const fps        = await findFPs(lifecycle, categories, env);

  if (!fps.length) {
    await push(uid, '現在マッチするFPが見つかりませんでした 🙏\nしばらくしてから再度お試しください。', env);
    await kv(env).delete(`client:${uid}`);
    return;
  }

  const slots = await aggregateSlots(fps, env);
  if (!slots.length) {
    await push(uid, `${fps.length}名のFPがマッチしましたが、空き時間が見つかりませんでした 🙏\n後日お試しください。`, env);
    await kv(env).delete(`client:${uid}`);
    return;
  }

  const sessionId = await createSession({ client_line_user_id: uid, concern, lifecycle_stage: lifecycle, age_range: ageKey, matched_categories: categories }, env);
  await kv(env).put(`client:${uid}`, JSON.stringify({ step: 'slots', concern, lifecycle, age: ageKey, slots, session_id: sessionId, fp_ids: fps.map(f => f.id) }), { expirationTtl: KV_TTL });

  await pushFlex(uid, slotFlex(slots, fps.length), env);
}

async function clientSlotTap(uid, rt, p, env) {
  const idx = parseInt(p.get('idx'), 10);
  const raw = await kv(env).get(`client:${uid}`);
  if (!raw) return;
  const { slots, fp_ids, session_id } = JSON.parse(raw);
  const slot = slots[idx];
  if (!slot) { await reply(rt, 'セッションが切れました。最初からお試しください。', env); return; }

  // ガチャ：その時間に空いているFPを再確認してランダム選択
  const avail = await availFPsAtSlot(fp_ids, slot, env);
  if (!avail.length) {
    await reply(rt, 'その時間は埋まってしまいました 😅\n別の時間をお選びください。', env);
    return;
  }
  const winner = avail[Math.floor(Math.random() * avail.length)];

  await updateSession(session_id, { selected_fp_id: winner.id, scheduled_start: slot.start, scheduled_end: slot.end, status: 'confirmed' }, env);
  await kv(env).delete(`client:${uid}`);

  const { m, d, wd, h } = jstParts(slot.start);
  const dateTimeStr = `${m}月${d}日(${wd}) ${h}:00〜${String(parseInt(h)+1).padStart(2,'0')}:00`;

  // FPごとのURL待ちキューに追加
  const queueKey = `fp_url_queue:${winner.line_user_id}`;
  const queueRaw = await kv(env).get(queueKey);
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  queue.push({ clientUserId: uid, clientName: '相談者', dateTimeStr });
  await kv(env).put(queueKey, JSON.stringify(queue));

  await reply(rt, '🎲 ガチャを回しています…', env);
  await pushFlex(uid, resultFlex(winner, m, d, wd, h), env);

  // FPに通知（URLをこのLINEに送るよう案内）
  await notifyFP(winner, slot, env);

  // 評価ジョブ：相談終了1時間後に送信
  const sendAt = new Date(new Date(slot.end).getTime() + SLOT_MS).toISOString();
  await createRatingJob({ session_id, client_line_user_id: uid, fp_name: winner.name, send_at: sendAt }, env);
}

// ── FP URL転送 ────────────────────────────────────────
async function handleFPUrlForward(fpUid, url, rt, fp, env) {
  const queueKey = `fp_url_queue:${fpUid}`;
  const queueRaw = await kv(env).get(queueKey);
  const queue = queueRaw ? JSON.parse(queueRaw) : [];

  if (queue.length === 0) {
    await reply(rt, 'URL待ちの相談者がいません。', env);
    return;
  }

  const next = queue.shift();
  await kv(env).put(queueKey, JSON.stringify(queue));

  await push(next.clientUserId,
    `お待たせしました！\n\n当日のオンライン相談はこちらからご参加ください。\n${url}\n\nご不明な点はお気軽にご連絡ください 🌿`,
    env
  );

  const remaining = queue.length;
  const remainingMsg = remaining > 0 ? `\n\n（残り${remaining}件のURL待ちがあります）` : '';
  await reply(rt, `相談者にURLを送りました ✅\n日程：${next.dateTimeStr}${remainingMsg}`, env);
}

// ── FP Menu ───────────────────────────────────────────
async function fpMenu(uid, text, rt, fp, env) {
  // URL送信の検知（Zoom / Meet / Teams など何でも対応）
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    await handleFPUrlForward(uid, urlMatch[0], rt, fp, env);
    return;
  }

  if (text === '一時停止' || text === '停止') {
    await patchFP(uid, { active: false }, env);
    await reply(rt, '受付を一時停止しました 🙏\n再開するには「再開」と送ってください。', env);
  } else if (text === '再開') {
    await patchFP(uid, { active: true }, env);
    await reply(rt, '受付を再開しました ✅', env);
  } else {
    const lcLabels  = (fp.lifecycle_stages || []).map(k => LIFECYCLE_STAGES.find(s => s.key === k)?.label).join('・');
    const spLabels  = (fp.specialties || []).map(k => SPECIALTIES.find(s => s.key === k)?.label).join('・');
    const status    = fp.active ? '✅ 受付中' : '⏸ 一時停止中';
    await reply(rt,
      `${fp.name}さん ${status}\n\nライフステージ：${lcLabels}\n専門領域：${spLabels}\n\n` +
      '「一時停止」：新規受付を停止\n「再開」：受付を再開', env);
  }
}

// ── Rating ────────────────────────────────────────────
async function clientRate(uid, rt, p, env) {
  const rating    = parseInt(p.get('stars'), 10);
  const sessionId = p.get('sid');
  await updateSession(sessionId, { rating, status: 'rated' }, env);
  await reply(rt, `ご評価ありがとうございます ✅\n${'⭐'.repeat(rating)}（${rating}点）を送りました。\n\nまたいつでもご相談ください 🎲`, env);
}

async function processRatingJobs(env) {
  const now = new Date().toISOString();
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_rating_jobs?sent=eq.false&send_at=lte.${encodeURIComponent(now)}&select=*`,
    { headers: sbHeaders(env) });
  const jobs = await res.json();
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    await pushFlex(job.client_line_user_id, ratingFlex(job), env);
    await fetch(`${env.SUPABASE_URL}/rest/v1/fp_rating_jobs?id=eq.${job.id}`, {
      method: 'PATCH', headers: sbHeaders(env), body: JSON.stringify({ sent: true }),
    });
  }
}

// ── Google Calendar ───────────────────────────────────
async function refreshToken(refreshToken, env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  return (await res.json()).access_token;
}

async function aggregateSlots(fps, env) {
  const now = Date.now();
  const tMax = new Date(now + MAX_DAYS * 86_400_000).toISOString();

  // 全FPのbusy時間を並列取得
  const busyMap = Object.fromEntries(await Promise.all(fps.map(async fp => {
    try {
      const tok = await refreshToken(fp.google_refresh_token, env);
      const r   = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: new Date(now).toISOString(), timeMax: tMax, timeZone: 'Asia/Tokyo', items: [{ id: fp.google_calendar_id }] }),
      });
      const d = await r.json();
      return [fp.id, (d.calendars?.[fp.google_calendar_id]?.busy ?? []).map(b => ({ s: +new Date(b.start), e: +new Date(b.end) }))];
    } catch { return [fp.id, []]; }
  })));

  const slots = [];
  for (let day = 0; day < MAX_DAYS && slots.length < SLOTS_TO_SHOW; day++) {
    const { y, mo, dy } = jstYMD(now + day * 86_400_000);
    for (let h = 8; h < 22 && slots.length < SLOTS_TO_SHOW; h++) {
      const ss = Date.UTC(y, mo, dy, h - 9);
      const se = ss + SLOT_MS;
      if (ss <= now) continue;
      const fpIds = fps.filter(fp => !busyMap[fp.id]?.some(b => ss < b.e && se > b.s)).map(fp => fp.id);
      if (fpIds.length) slots.push({ start: new Date(ss).toISOString(), end: new Date(se).toISOString(), fpIds });
    }
  }
  return slots;
}

async function availFPsAtSlot(fpIds, slot, env) {
  const ss = +new Date(slot.start), se = +new Date(slot.end);
  const fps = (await Promise.all(fpIds.map(id => getFPById(id, env)))).filter(Boolean);
  const results = await Promise.all(fps.map(async fp => {
    try {
      const tok = await refreshToken(fp.google_refresh_token, env);
      const r   = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: slot.start, timeMax: slot.end, timeZone: 'Asia/Tokyo', items: [{ id: fp.google_calendar_id }] }),
      });
      const d    = await r.json();
      const busy = d.calendars?.[fp.google_calendar_id]?.busy ?? [];
      return busy.some(b => +new Date(b.start) < se && +new Date(b.end) > ss) ? null : fp;
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function createMeetEvent(fp, slot, clientUid, env) {
  const tok = await refreshToken(fp.google_refresh_token, env);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(fp.google_calendar_id)}/events?conferenceDataVersion=1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary:     'FPガチャ 個別相談',
        description: `クライアントID: ${clientUid}`,
        start: { dateTime: slot.start, timeZone: 'Asia/Tokyo' },
        end:   { dateTime: slot.end,   timeZone: 'Asia/Tokyo' },
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }),
    }
  );
  const ev = await res.json();
  const url = ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ?? ev.hangoutLink ?? '';
  console.log(`[createMeetEvent] status=${res.status} url=${url}`);
  return url;
}

// ── AI Categorization ─────────────────────────────────
async function categorizeConcern(concern, env) {
  const list = SPECIALTIES.map(s => `${s.key}: ${s.label}`).join('\n');
  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      system: `以下の専門領域リストから、ユーザーの悩みに最も関連するキーを最大3つ選び、カンマ区切りのみで返してください。\n\n${list}`,
      messages: [{ role: 'user', content: concern }],
    }),
  });
  const raw  = (await res.json()).content?.[0]?.text ?? '';
  const keys = raw.split(',').map(k => k.trim()).filter(k => SPECIALTIES.some(s => s.key === k));
  console.log(`[categorize] "${concern.slice(0,30)}" → ${keys}`);
  return keys.length ? keys : ['other'];
}

async function findFPs(lifecycle, categories, env) {
  const res  = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?active=eq.true&select=*`, { headers: sbHeaders(env) });
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.filter(fp =>
    fp.lifecycle_stages?.includes(lifecycle) &&
    fp.specialties?.some(s => categories.includes(s))
  );
}

// ── FP Notification ───────────────────────────────────
async function notifyFP(fp, slot, env) {
  if (!fp.line_user_id) return;
  const { m, d, wd, h } = jstParts(slot.start);
  await push(fp.line_user_id,
    `📅 FPガチャで予約が入りました！\n\n` +
    `日時：${m}月${d}日(${wd}) ${h}:00〜${String(parseInt(h)+1).padStart(2,'0')}:00\n\n` +
    `ZoomまたはGoogle MeetなどのURLを発行したら、\nこのトークにURLを貼り付けてください。\n相談者に自動で転送されます 🔗\n\n` +
    `※ 初回はオンライン相談のみ。対面はクライアント承認後に限ります。`, env);
}

// ── Flex Message Builders ─────────────────────────────
function slotFlex(slots, fpCount) {
  const buttons = slots.map((slot, i) => {
    const { m, d, wd, h } = jstParts(slot.start);
    const n = slot.fpIds?.length ?? 1;
    return {
      type: 'button', style: 'secondary', margin: 'sm',
      action: { type: 'postback', label: `${m}/${d}(${wd}) ${h}:00  [${n}名対応可]`, data: `action=slot&idx=${i}`, displayText: `${m}月${d}日(${wd}) ${h}:00を選択` },
    };
  });
  return {
    type: 'flex', altText: 'ご希望の日時を選んでください 🎲',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1A4A7A', paddingAll: 'lg',
        contents: [
          { type: 'text', text: `🎲 ${fpCount}名のFPがマッチ！`, color: '#ffffff', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: 'ご希望の日時をお選びください', color: '#aaccee', size: 'sm' },
        ] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
}

function resultFlex(fp, m, d, wd, h) {
  const spLabels = (fp.specialties || []).slice(0, 4).map(k => SPECIALTIES.find(s => s.key === k)?.label).filter(Boolean).join('・');
  return {
    type: 'flex', altText: `🎉 ${fp.name}FPとマッチしました！`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1A6B3C', paddingAll: 'lg',
        contents: [{ type: 'text', text: '🎉 マッチしました！', color: '#ffffff', weight: 'bold', size: 'xl' }] },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: `担当FP：${fp.name}`, weight: 'bold', size: 'lg' },
          { type: 'text', text: `専門：${spLabels}`, size: 'sm', color: '#555555', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `📅 ${m}月${d}日(${wd}) ${h}:00〜${String(parseInt(h)+1).padStart(2,'0')}:00`, weight: 'bold', margin: 'md' },
          { type: 'text', text: 'オンライン相談（Zoom / Google Meet など）', size: 'sm', color: '#555555' },
          { type: 'text', text: '参加URLはFPより追ってご連絡します 🔗', size: 'sm', color: '#1A6B3C', wrap: true, margin: 'sm' },
          { type: 'text', text: 'カメラ顔出しは任意です 🌿', size: 'xs', color: '#888888' },
        ],
      },
    },
  };
}

function ratingFlex(job) {
  return {
    type: 'flex', altText: '相談の評価をお願いします ⭐',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '相談はいかがでしたか？ 🌿', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: `${job.fp_name}FPとのご相談の評価をお願いします。`, size: 'sm', color: '#555555', wrap: true },
          { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'lg',
            contents: [1,2,3,4,5].map(n => ({
              type: 'button', style: 'secondary', flex: 1,
              action: { type: 'postback', label: `${n}⭐`, data: `action=rate&stars=${n}&sid=${job.session_id}`, displayText: `${n}つ星` },
            })) },
        ],
      },
    },
  };
}

// ── Supabase ──────────────────────────────────────────
const sbHeaders = env => ({
  apikey:        env.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

async function getFP(uid, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?line_user_id=eq.${uid}&limit=1`, { headers: sbHeaders(env) });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}
async function getFPById(id, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?id=eq.${id}&limit=1`, { headers: sbHeaders(env) });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}
async function saveFP(uid, data, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ line_user_id: uid, ...data }),
  });
}
async function patchFP(uid, data, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?line_user_id=eq.${uid}`, {
    method: 'PATCH', headers: sbHeaders(env), body: JSON.stringify(data),
  });
}
async function createSession(data, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify({ ...data, status: 'started' }),
  });
  return (await r.json())[0]?.id;
}
async function updateSession(id, data, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?id=eq.${id}`, {
    method: 'PATCH', headers: sbHeaders(env),
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
}
async function createRatingJob(data, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/fp_rating_jobs`, {
    method: 'POST', headers: sbHeaders(env), body: JSON.stringify(data),
  });
}

// ── LINE Helpers ──────────────────────────────────────
const kv = env => env.GACHA_STATE;
async function reply(rt, text, env) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken: rt, messages: [{ type: 'text', text }] }),
  });
}
async function replyQR(rt, text, items, env) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken: rt, messages: [{ type: 'text', text, quickReply: { items } }] }),
  });
}
async function push(uid, text, env) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: uid, messages: [{ type: 'text', text }] }),
  });
}
async function pushFlex(uid, flex, env) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: uid, messages: [flex] }),
  });
}

// ── Signature Verification ────────────────────────────
async function verifySig(body, sig, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s   = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return sig === btoa(String.fromCharCode(...new Uint8Array(s)));
}

// ── Date Helpers ──────────────────────────────────────
function jstParts(isoStr) {
  const d = new Date(new Date(isoStr).getTime() + JST);
  return { m: d.getUTCMonth()+1, d: d.getUTCDate(), wd: WEEKDAYS[d.getUTCDay()], h: String(d.getUTCHours()).padStart(2,'0') };
}
function jstYMD(ms) {
  const d = new Date(ms + JST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), dy: d.getUTCDate() };
}
