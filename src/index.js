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

// 詳細ライフステージ（クライアント用 / FP登録フォーム用）
const CLIENT_LIFECYCLE_DETAIL = [
  { key: 'single_marry_yes',   label: '独身・結婚予定あり',    legacy: 'single' },
  { key: 'single_marry_no',    label: '独身・結婚予定なし',    legacy: 'single' },
  { key: 'married_no_child',   label: '既婚・子なし',         legacy: 'family_nochild' },
  { key: 'married_child_home', label: '既婚・子あり（同居）',  legacy: 'family_child' },
  { key: 'married_child_out',  label: '既婚・子あり（独立）',  legacy: 'family_child' },
  { key: 'divorced_child',     label: '離別・子あり',         legacy: 'family_child' },
];

// 詳細キー → legacy lifecycle_stage へのマッピング
const FAMILY_STAGE_LEGACY = {
  single_marry_yes:   'single',
  single_marry_no:    'single',
  married_no_child:   'family_nochild',
  married_child_home: 'family_child',
  married_child_out:  'family_child',
  divorced_child:     'family_child',
};
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

// ── AI System Prompts（フェーズ別） ───────────────────
// ルール共通注意事項
const SYSTEM_COMMON =
  '【ルール】' +
  '①会話履歴を参照し、既に収集した情報（悩み・ライフステージ・年代）は絶対に再質問しないこと。' +
  '②既存ユーザーに「はじめまして」を使わないこと。会話履歴があれば続きから始めること。' +
  '③共感だけで終わらず、必ず次のステップへの案内（質問か提案）をセットにすること。' +
  '④1つのメッセージで複数質問しないこと。' +
  '⑤返答にMarkdownを使用しないこと。** や * などの装飾は使わず、プレーンテキストで返すこと。';

const SYSTEM_PHASE1 =
  'あなたはFPガチャのAIカウンセラー「蔵戸ありさ」です。' +
  'ユーザーのお金に関する悩みに温かく共感を示し、そのうえで家族構成を自然に1つ確認してください。' +
  '例：「〇〇についてのお悩み、よくわかります。少し教えていただけますか？今おひとりでいらっしゃいますか、それともご家族がいらっしゃいますか？」' +
  '【禁止】解決策・FP紹介はまだしないこと。' +
  SYSTEM_COMMON +
  '日本語150文字以内。絵文字は1〜2個まで。';

const SYSTEM_PHASE2_AGE = familyLabel =>
  'あなたはFPガチャのAIカウンセラー「蔵戸ありさ」です。' +
  `ユーザーが家族構成（${familyLabel}）を教えてくれました。` +
  '共感・承認を一言添えてから、年代を自然に1つだけ確認してください。' +
  '例：「ありがとうございます。よろしければ、ご年代もお聞きしてもよいですか？」' +
  SYSTEM_COMMON +
  '日本語100文字以内。絵文字は1つまで。';

const SYSTEM_PHASE3 = (concern, familyLabel, ageLabel) =>
  'あなたはFPガチャのAIカウンセラー「蔵戸ありさ」です。' +
  `ユーザーの状況（悩み：${concern.slice(0, 30)}、家族構成：${familyLabel}、年代：${ageLabel}）を踏まえ、` +
  '押しつけにならない提案をしてください。「〇〇さんの状況に合ったFPをご紹介できますが、一度お話だけでも聞いてみませんか？もちろん、まだ考えたいということでも大丈夫です」のように提案し、' +
  '次のメッセージでYES/NOのボタンが表示される旨を自然に伝えてください。' +
  SYSTEM_COMMON +
  '日本語150文字以内。';

// ── Main Handler ──────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/oauth/start')    return oauthStart(request, env);
    if (url.pathname === '/oauth/callback') return oauthCallback(request, env);

    // 静的ページ
    if (request.method === 'GET' && url.pathname === '/') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', url)));
    }
    if (url.pathname === '/fp' || url.pathname === '/fp/') {
      return Response.redirect(`${env.WORKER_URL}/fp/register`, 301);
    }
    if (url.pathname === '/fp/register' && request.method === 'GET') {
      return env.ASSETS.fetch(new Request(new URL('/fp/register.html', url)));
    }
    if (url.pathname === '/fp/register-submit' && request.method === 'POST') {
      return handleFPWebRegStart(request, env);
    }

    // リマインダー設定エンドポイント
    // NOTE: Cloudflare Workers Durable Objects Alarms を使う場合はここをDO呼び出しに変更すること
    // 現在はDBにレコードを保存し、cronで1時間前に送信する設計
    if (url.pathname === '/api/set-reminder' && request.method === 'POST') {
      return handleSetReminder(request, env);
    }

    // 未マッチのGETリクエスト（/images/ 等）は静的アセットとして配信
    if (request.method === 'GET') return env.ASSETS.fetch(request);

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

  // 毎時cron：評価リクエスト送信 / 毎朝9時JST(0時UTC)：相談後フォローアップ / リマインダー処理
  async scheduled(event, env) {
    if (event.cron === '0 0 * * *') await processFollowUps(env);
    if (event.cron === '0 * * * *') {
      await processRatingJobs(env);
      await processReminders(env);
    }
  },
};

const WELCOME_MSG =
  'FPガチャへようこそ！ 🎲\n\n' +
  'お金に関するお悩みをAIが分析し、最適なFP（ファイナンシャルプランナー）をマッチングします。\n\n' +
  '今のお悩みをそのまま送ってください。\n\n' +
  '（例：老後の資金が心配、保険を見直したい、子どもの教育費が不安　など）';

// ════════════════════════════════════════════════════════
//  新フロー定数・データ
// ════════════════════════════════════════════════════════

// フェーズ1 完了キーワード（いずれかが含まれていたら即Phase 2へ）
const COMPLETION_KEYWORDS = [
  'それぐらい', 'そのぐらい', '以上', 'ないです', '特にない', 'とくにない',
  '大丈夫です', 'それだけ', '結構です', 'ありません', '特にないです',
];

// カテゴリー別悩みカード（Flex Message カルーセル用）
const WORRY_CARDS = [
  {
    emoji: '🛡️', category: '保険',
    worries: ['保険料が高すぎる気がする','本当に必要な保険に入れているか不安','家族に何かあったときに備えられているか心配'],
    color: '#1A4A7A',
  },
  {
    emoji: '💰', category: '貯金・投資',
    worries: ['お金が全然貯まらない','資産運用を始めたいけど何から手を付ければいいかわからない','NISAやiDeCoをうまく活用できていない'],
    color: '#1A6B3C',
  },
  {
    emoji: '💳', category: '借金・ローン',
    worries: ['カードローンや消費者金融の返済がしんどい','住宅ローンの返済が家計を圧迫している','借り換えや一本化を考えているが方法がわからない'],
    color: '#7A2E1A',
  },
  {
    emoji: '🏠', category: '住宅',
    worries: ['マイホームを買うべきか賃貸のままがいいか迷っている','住宅ローンをどう組めばいいかわからない','老後の住まいが心配'],
    color: '#4A3B1A',
  },
  {
    emoji: '👴', category: '老後・年金',
    worries: ['老後に必要なお金がいくらか見当がつかない','年金だけでは生活できないと思っている','退職後の生活費が不安'],
    color: '#2A1A6B',
  },
  {
    emoji: '📚', category: '教育費',
    worries: ['子どもの学費をどう準備すればいいかわからない','学資保険の見直しをしたい','教育費と老後資金のバランスがわからない'],
    color: '#1A5A4A',
  },
  {
    emoji: '📊', category: '家計・収支',
    worries: ['毎月の収支がプラスにならない','家計の見直しをしたいが何から始めればいいかわからない','支出を把握できていない'],
    color: '#3A1A7A',
  },
  {
    emoji: '🚗', category: '大きな出費',
    worries: ['車の購入や買い替えのタイミングで迷っている','リフォームの費用をどう用意するか悩んでいる','急な大きな出費に対応できるか不安'],
    color: '#1A3A5A',
  },
  {
    emoji: '🏥', category: '医療費',
    worries: ['病気やケガをしたときの医療費が心配','医療保険や入院保険の内容が適切かわからない','介護になったときの費用が不安'],
    color: '#5A1A1A',
  },
  {
    emoji: '💔', category: '人生の転機',
    worries: ['結婚・離婚・相続などでお金の整理が必要','転職や独立に際してお金の不安がある','家族が亡くなりお金の管理をどうすればいいかわからない'],
    color: '#5A2A5A',
  },
  {
    emoji: '📈', category: 'お金を増やしたい',
    worries: ['投資を始めたいが元本割れが怖い','株・投信・不動産、どれが自分に向いているか知りたい','少ない元手でも増やせる方法を知りたい'],
    color: '#1A5A2A',
  },
  {
    emoji: '🎓', category: '自己投資',
    worries: ['スキルアップのための費用を捻出したい','副業や独立のための資金計画が立てられていない','資格取得やキャリアアップに向けた資金の準備方法がわからない'],
    color: '#3A3A1A',
  },
];

// ユーザーのメッセージから主要フレーズを抽出
function extractKeyPhrase(text) {
  const clean = text
    .replace(/[。！!？?…\n]+$/, '')
    .replace(/(です|ます|ました|ません|たい|したい|ている|てる|ますが|ですが)$/, '')
    .trim();
  const firstChunk = clean.split(/[がをにでもはといったというって、]/)[0];
  const phrase = (firstChunk || clean).trim();
  return phrase.length > 15 ? phrase.slice(0, 15) : phrase;
}

// フェーズ1 共感返答（ユーザーの言葉を1〜2語引用）
function getEmpathy(text) {
  const phrase = extractKeyPhrase(text);

  if (/退職|セカンドライフ/.test(text)) {
    return `${phrase}への不安、先のことを考えると心配になりますよね。`;
  }
  if (/老後|年金|定年/.test(text)) {
    return `${phrase}のこと、将来のお金の不安はなるべく早めに整理しておきたいですよね。`;
  }
  if (/保険料|保険/.test(text)) {
    return `${phrase}と感じているんですね。長く払い続けるものだから、見直せると家計が楽になりますよね。`;
  }
  if (/収支|家計|支出|節約/.test(text)) {
    return `${phrase}、毎月のお金の流れを整えたいというお気持ちよくわかります。`;
  }
  if (/貯金|貯蓄|貯め/.test(text)) {
    return `${phrase}、将来のために少しずつ積み上げていきたいお気持ちよくわかります。`;
  }
  if (/投資|NISA|iDeCo|株|運用/.test(text)) {
    return `${phrase}、うまく活用できると将来の選択肢がぐっと広がりますよね。`;
  }
  if (/ローン|借金|返済|債務/.test(text)) {
    return `${phrase}、毎月の返済が気になると生活に余裕が持ちにくいですよね。`;
  }
  if (/住宅|マイホーム|持ち家|賃貸/.test(text)) {
    return `${phrase}、大きな決断だからこそ慎重に考えたいですよね。`;
  }
  if (/教育|学費|子ども|こども|習い事/.test(text)) {
    return `${phrase}、お子さんの将来のためにしっかり備えておきたいですよね。`;
  }
  if (/相続|遺産|資産/.test(text)) {
    return `${phrase}、家族のためにも早めに整理しておきたいですよね。`;
  }
  if (/不安|心配|怖|こわ/.test(text)) {
    return `${phrase}、漠然としていても気になってしまいますよね。`;
  }
  if (/見直し|改善|整理/.test(text)) {
    return `${phrase}、今の状況を少し変えるだけで楽になることもあります。`;
  }
  return `${phrase}というお悩み、ひとりで抱えているとなかなか答えが出にくいですよね。`;
}

// カルーセル Flex Message 生成
function buildWorryCarousel() {
  const bubbles = WORRY_CARDS.map(card => ({
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: card.color,
      paddingAll: 'md',
      contents: [{
        type: 'text',
        text: `${card.emoji} ${card.category}`,
        color: '#ffffff',
        weight: 'bold',
        size: 'sm',
        wrap: true,
      }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'md',
      contents: card.worries.map(w => ({
        type: 'text',
        text: `・${w}`,
        size: 'xxs',
        color: '#555555',
        wrap: true,
      })),
    },
  }));

  return {
    type: 'flex',
    altText: 'どんなお金の悩みがありますか？',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

// ── Follow ────────────────────────────────────────────
async function onFollow(ev, env) {
  const uid = ev.source.userId;

  // conversationsテーブルで既存ユーザー確認 → 既存ならスキップ
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/conversations?user_line_id=eq.${encodeURIComponent(uid)}&limit=1&select=id`,
    { headers: sbHeaders(env) }
  );
  const rows = await r.json();
  if (Array.isArray(rows) && rows.length > 0) return;

  // 新規ユーザー: ウェルカムメッセージ → カルーセル → 誘導テキスト（3メッセージ）
  // replyは1回しか使えないのでpushで追加送信
  await reply(ev.replyToken, WELCOME_MSG, env);
  await pushFlex(uid, buildWorryCarousel(), env);
  await push(uid, '気になるものはありますか？そのまま悩みをテキストで送っていただければ大丈夫です 😊', env);

  // フェーズを1に初期化
  await kv(env).put(`phase:${uid}`, '1');
}

// ── Message Router ────────────────────────────────────
async function onMessage(ev, env) {
  const uid  = ev.source.userId;
  const text = ev.message.text.trim();
  const rt   = ev.replyToken;

  // オールリセット（完全一致のみ）
  if (text === 'オールリセット') { await allReset(uid, rt, env); return; }

  // FP登録開始
  if (text === '登録') { await startFPReg(uid, rt, env); return; }

  // FP登録フロー継続
  const fpReg = await kv(env).get(`fp_reg:${uid}`);
  if (fpReg) { await fpRegStep(uid, text, rt, JSON.parse(fpReg), env); return; }

  // 登録済みFPのメニュー
  const fp = await getFP(uid, env);
  if (fp) { await fpMenu(uid, text, rt, fp, env); return; }

  // ── 新フェーズベースのクライアントフロー ──
  const phase = await kv(env).get(`phase:${uid}`);

  if (!phase || phase === '1') {
    await handlePhase1(uid, text, rt, env);
    return;
  }
  if (phase === '2') {
    await handlePhase2Text(uid, text, rt, env);
    return;
  }
  if (phase === '3') {
    await handlePhase3Text(uid, text, rt, env);
    return;
  }

  // フェーズ不明 → Phase1として扱う
  await handlePhase1(uid, text, rt, env);
}

// ── Postback Router ───────────────────────────────────
async function onPostback(ev, env) {
  const uid = ev.source.userId;
  const rt  = ev.replyToken;
  const p   = new URLSearchParams(ev.postback.data);
  const act = p.get('action');

  if (act === 'fp_lc')         return fpLifecycleTap(uid, rt, p, env);
  if (act === 'lc')            return clientLifecycleTap(uid, rt, p, env);   // 旧フロー互換
  if (act === 'lc_detail')     return clientLifecycleDetailTap(uid, rt, p, env);
  if (act === 'age')           return clientAgeTap(uid, rt, p, env);
  if (act === 'fp_consent')    return clientConsentTap(uid, rt, p, env);
  if (act === 'slot')          return clientSlotTap(uid, rt, p, env);
  if (act === 'rate')          return clientRate(uid, rt, p, env);
  if (act === 'fp_result')     return saveFPResult(uid, rt, p, env);
  if (act === 'client_result') return saveClientResult(uid, rt, p, env);
  // 新フロー
  if (act === 'p2_job')        return phase2JobTap(uid, rt, p, env);
  if (act === 'p2_age')        return phase2AgeTap(uid, rt, p, env);
  if (act === 'p2_marital')    return phase2MaritalTap(uid, rt, p, env);
  if (act === 'p2_children')   return phase2ChildrenTap(uid, rt, p, env);
  if (act === 'p3_consent')    return phase3ConsentTap(uid, rt, p, env);
  if (act === 'p3_retry')      return phase3RetryTap(uid, rt, p, env);
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
  await kv(env).put(`fp_reg:${uid}`, JSON.stringify({ step: 'email_verify' }), { expirationTtl: KV_TTL });
  await reply(rt,
    'ウェブページでのご登録ありがとうございます 🌿\n\n' +
    '登録時に入力したメールアドレスをこちらに送ってください。', env);
}

async function fpRegStep(uid, text, rt, state, env) {
  switch (state.step) {
    case 'email_verify': {
      const email = text.trim().toLowerCase();
      // fp_fpsテーブルでメールアドレスを照合
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/fp_fps?email=eq.${encodeURIComponent(email)}&limit=1&select=*`,
        { headers: sbHeaders(env) }
      );
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) {
        await reply(rt,
          'メールアドレスが見つかりませんでした。\nウェブページでの登録をご確認ください。', env);
        return;
      }
      const fp = rows[0];
      if (fp.line_user_id) {
        await reply(rt, 'このメールアドレスはすでにLINEと連携済みです 🌿', env);
        await kv(env).delete(`fp_reg:${uid}`);
        return;
      }
      // line_user_idを更新してアクティブ化
      await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?id=eq.${fp.id}`, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({ line_user_id: uid, active: true }),
      });
      await kv(env).delete(`fp_reg:${uid}`);
      await reply(rt,
        `連携が完了しました ✅\nこれでFPとして活動できます！\n\n` +
        `「一時停止」：新規受付を停止\n「再開」：受付を再開`, env);
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
//  FP Web Registration（/fp/register POST）
// ══════════════════════════════════════════════════════
async function handleFPWebRegStart(request, env) {
  const data = await request.formData();
  const name          = (data.get('name') || '').trim();
  const email         = (data.get('email') || '').trim().toLowerCase();
  const specialties   = data.getAll('specialties');
  const formats       = data.getAll('formats');
  const age_ranges    = data.getAll('age_ranges');
  const family_stages = data.getAll('family_stages');

  if (!name)  return Response.redirect(`${env.WORKER_URL}/fp/register?error=name`, 302);
  if (!email || !email.includes('@')) return Response.redirect(`${env.WORKER_URL}/fp/register?error=email`, 302);
  if (!specialties.length) return Response.redirect(`${env.WORKER_URL}/fp/register?error=specialty`, 302);
  if (!formats.length)     return Response.redirect(`${env.WORKER_URL}/fp/register?error=format`, 302);

  const legacyStages = [...new Set(family_stages.map(k => FAMILY_STAGE_LEGACY[k]).filter(Boolean))];

  // fp_fpsテーブルに直接保存（line_user_idはNULL・activeはfalse）
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({
      name,
      email,
      line_user_id:     null,
      lifecycle_stages: legacyStages.length ? legacyStages : ['single', 'family_child', 'family_nochild', 'senior'],
      specialties,
      formats,
      age_ranges,
      family_stages,
      active: false,
    }),
  });

  if (res.status === 409) {
    return Response.redirect(`${env.WORKER_URL}/fp/register?error=email_dup`, 302);
  }
  if (!res.ok) {
    console.log('[webReg] save error:', res.status);
    return Response.redirect(`${env.WORKER_URL}/fp/register?error=save`, 302);
  }

  return new Response(`
    <!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>登録完了｜FPガチャ</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      body{font-family:'Noto Sans JP',sans-serif;background:#07111f;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
      .card{background:rgba(26,74,122,0.25);border:1px solid rgba(126,232,200,0.2);border-radius:24px;padding:48px 36px;max-width:480px;width:100%}
      .icon{font-size:3.5rem;margin-bottom:20px}
      h1{font-size:1.6rem;font-weight:900;color:#7ee8c8;margin-bottom:16px}
      p{font-size:0.95rem;line-height:1.85;color:rgba(255,255,255,0.78);margin-bottom:16px}
      .step-box{background:rgba(126,232,200,0.08);border:1px solid rgba(126,232,200,0.25);border-radius:16px;padding:20px 24px;margin:20px 0;text-align:left}
      .step-box p{margin-bottom:10px;font-size:0.9rem}
      .step-box p:last-child{margin-bottom:0}
      .step-num{display:inline-block;background:#7ee8c8;color:#07111f;font-weight:900;font-size:0.75rem;padding:2px 8px;border-radius:999px;margin-right:6px}
      .line-btn{display:inline-flex;align-items:center;gap:10px;background:#06C755;color:#fff;font-weight:900;font-size:1rem;padding:16px 36px;border-radius:999px;text-decoration:none;margin-top:8px}
      footer{margin-top:48px;font-size:0.8rem;color:rgba(255,255,255,0.25)}
    </style></head>
    <body>
      <div class="card">
        <div class="icon">✅</div>
        <h1>登録情報を受け付けました！</h1>
        <p>次のステップでLINEアカウントと連携してください。</p>
        <div class="step-box">
          <p><span class="step-num">STEP 1</span>下のボタンからFPガチャのLINEを友だち追加</p>
          <p><span class="step-num">STEP 2</span>LINEで「<strong>登録</strong>」と送信</p>
          <p><span class="step-num">STEP 3</span>登録したメールアドレス（<strong>${email}</strong>）を送信</p>
        </div>
        <a href="https://lin.ee/7OS8Lib" class="line-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.105.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
          LINEで連携する
        </a>
      </div>
      <footer>&copy; 2025 FPガチャ</footer>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
    age_ranges:           state.age_ranges || [],
    family_stages:        state.family_stages || [],
  }, env);

  await kv(env).delete(`fp_reg:${uid}`);

  const isWebReg = uid.startsWith('web_');

  if (isWebReg) {
    // Web登録：LINE通知なし、専用完了ページを表示
    return new Response(`
      <!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>登録完了｜FPガチャ</title>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700;900&display=swap" rel="stylesheet">
      <style>
        body{font-family:'Noto Sans JP',sans-serif;background:#07111f;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
        .card{background:rgba(26,74,122,0.25);border:1px solid rgba(126,232,200,0.2);border-radius:24px;padding:48px 36px;max-width:480px;width:100%}
        .icon{font-size:3.5rem;margin-bottom:20px}
        h1{font-size:1.6rem;font-weight:900;color:#7ee8c8;margin-bottom:12px}
        p{font-size:0.95rem;line-height:1.85;color:rgba(255,255,255,0.78);margin-bottom:16px}
        .line-btn{display:inline-flex;align-items:center;gap:10px;background:#06C755;color:#fff;font-weight:900;font-size:1rem;padding:16px 36px;border-radius:999px;text-decoration:none;margin-top:8px}
        .note{font-size:0.8rem;color:rgba(255,255,255,0.35);margin-top:20px}
        footer{margin-top:48px;font-size:0.8rem;color:rgba(255,255,255,0.25)}
      </style></head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h1>Googleカレンダー連携完了！</h1>
          <p>FPガチャへのパートナー登録が完了しました。</p>
          <p>予約通知をLINEで受け取るには、FPガチャのLINE公式アカウントを<br>友だち追加して「登録」と送ってください。</p>
          <a href="https://lin.ee/7OS8Lib" class="line-btn">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.105.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.281.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
            LINEで通知設定を完了する
          </a>
          <p class="note">※ LINE連携は任意です。カレンダー連携のみでも相談受付は始まります。</p>
        </div>
        <footer>&copy; 2025 FPガチャ</footer>
      </body></html>
    `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // LINE登録フロー：LINEで完了通知を送る
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
//  新フェーズベース クライアントフロー
// ══════════════════════════════════════════════════════

// ── Phase 1: 悩み深掘りループ ────────────────────────

async function handlePhase1(uid, text, rt, env) {
  // 悩みをDBに保存（phase=1 として）
  await fetch(`${env.SUPABASE_URL}/rest/v1/conversations`, {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify({ user_line_id: uid, role: 'user', content: text, phase: 1 }),
  });

  // 完了キーワード検出（文字列チェック最優先、AI判断なし）→ Phase 2へ移行
  const normalized = text.trim().replace(/[。！!？?…\s]+$/, '');
  const isComplete = COMPLETION_KEYWORDS.some(kw => normalized.includes(kw));
  if (isComplete) {
    await kv(env).put(`phase:${uid}`, '2');
    await enterPhase2(uid, rt, env);
    return;
  }

  // 共感返答 + 続きを促す
  const empathy = getEmpathy(text);
  const followUp = '他にも気になっていることはありますか？\nもしあればそのまま送ってください。';
  await reply(rt, `${empathy}\n\n${followUp}`, env);
}

// ── Phase 2: 属性収集（Quick Reply） ─────────────────

async function enterPhase2(uid, rt, env) {
  const bridge = 'ありがとうございます。そうしましたら、あなたにぴったりのFPを探すお手伝いをするのに、もう少し質問させてください。';
  const jobQuestion = 'あなたの今のお仕事は以下のどれに当てはまりますか？';
  const jobQR = makeQR([
    '会社員・公務員','個人事業主','フリーランス','主婦・主夫','学生','無職・休職中','その他','答えたくない',
  ], 'p2_job', 'job');

  await kv(env).put(`attr_step:${uid}`, 'job');
  // bridgeメッセージをreplyで送り、jobをpushで送る
  await reply(rt, bridge, env);
  await replyQR(null, jobQuestion, jobQR, env, uid);
}

function makeQR(labels, action, param) {
  return labels.map(label => ({
    type: 'action',
    action: { type: 'message', label: label.length > 20 ? label.slice(0, 20) : label, text: label },
  }));
}

// Phase 2 テキスト受信（クイックリプライは message タイプなのでテキストとして届く）
async function handlePhase2Text(uid, text, rt, env) {
  const step = await kv(env).get(`attr_step:${uid}`);

  if (step === 'job') {
    await saveAttr(uid, { job_status: text }, env);
    await kv(env).put(`attr_step:${uid}`, 'age');
    const ageQR = makeQR(['20代','30代','40代','50代','60代以上','答えたくない'], 'p2_age', 'age');
    await replyQR(rt, 'ありがとうございます。差し支えなければご年代も教えていただけますか？', ageQR, env);
    return;
  }
  if (step === 'age') {
    await saveAttr(uid, { age_range: text }, env);
    await kv(env).put(`attr_step:${uid}`, 'marital');
    const maritalQR = makeQR(['独身','既婚','離別・死別','答えたくない'], 'p2_marital', 'marital');
    await replyQR(rt, '最後にもう一つだけ。現在おひとりですか、ご家族はいらっしゃいますか？', maritalQR, env);
    return;
  }
  if (step === 'marital') {
    await saveAttr(uid, { marital_status: text }, env);
    if (text === '既婚') {
      await kv(env).put(`attr_step:${uid}`, 'children');
      const childrenQR = makeQR(['子なし','1人','2人','3人以上','答えたくない'], 'p2_children', 'children');
      await replyQR(rt, 'お子さんはいらっしゃいますか？', childrenQR, env);
    } else {
      await kv(env).put(`attr_step:${uid}`, 'done');
      await kv(env).put(`phase:${uid}`, '3');
      await enterPhase3(uid, rt, env);
    }
    return;
  }
  if (step === 'children') {
    await saveAttr(uid, { children_count: text }, env);
    await kv(env).put(`attr_step:${uid}`, 'done');
    await kv(env).put(`phase:${uid}`, '3');
    await enterPhase3(uid, rt, env);
    return;
  }

  // stepが不明 → jobから再開
  await kv(env).put(`attr_step:${uid}`, 'job');
  const jobQR = makeQR(['会社員・公務員','個人事業主','フリーランス','主婦・主夫','学生','無職・休職中','その他','答えたくない'], 'p2_job', 'job');
  await replyQR(rt, 'あなたの今のお仕事は以下のどれに当てはまりますか？', jobQR, env);
}

// Phase 2 postbackハンドラ（フォールバック、実際はtextが届く）
async function phase2JobTap(uid, rt, p, env) { await handlePhase2Text(uid, p.get('val') || '', rt, env); }
async function phase2AgeTap(uid, rt, p, env) { await handlePhase2Text(uid, p.get('val') || '', rt, env); }
async function phase2MaritalTap(uid, rt, p, env) { await handlePhase2Text(uid, p.get('val') || '', rt, env); }
async function phase2ChildrenTap(uid, rt, p, env) { await handlePhase2Text(uid, p.get('val') || '', rt, env); }

// ── Phase 3: サマリー + FP紹介提案 ────────────────────

async function enterPhase3(uid, rt, env) {
  // セッションから属性を取得
  const sessRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?uid=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1&select=*`,
    { headers: sbHeaders(env) }
  );
  const sessions = await sessRes.json();
  const sess = Array.isArray(sessions) && sessions.length ? sessions[0] : {};

  // 悩みリストを取得
  const worriesRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/conversations?user_line_id=eq.${encodeURIComponent(uid)}&role=eq.user&phase=eq.1&order=created_at.asc&select=content`,
    { headers: sbHeaders(env) }
  );
  const worryRows = await worriesRes.json();
  const worries = Array.isArray(worryRows) ? worryRows.map(r => r.content) : [];

  const ageRange  = sess.age_range  || '';
  const job       = sess.job_status || '';
  const marital   = sess.marital_status || '';
  const children  = sess.children_count;
  const childInfo = marital === '既婚' && children ? `・子ども${children}` : '';

  // 悩みサマリー（ユーザーが実際に送ったテキストのみ使用、カルーセル文言は使わない）
  let worrySummary;
  if (worries.length === 0) {
    worrySummary = 'お金に関することへのお悩み';
  } else if (worries.length === 1) {
    worrySummary = `「${worries[0]}」`;
  } else {
    const allButLast = worries.slice(0, -1).map(w => `「${w}」`).join('、');
    worrySummary = `${allButLast}、そして「${worries[worries.length - 1]}」`;
  }

  // 状況テキスト（名前は使わず属性のみ）
  const profileParts = [job, ageRange, marital + childInfo].filter(Boolean);
  const profileText = profileParts.length
    ? `${profileParts.join('で、')}なんですね。`
    : 'ありがとうございます。';

  const summary =
    `${profileText}\n\n` +
    `${worrySummary}についてお悩みなんですね。\n\n` +
    'こうしたお悩みは、FPに相談することで改善できる可能性がとても高いです。\n\n' +
    'あなたの状況にぴったりのFPをご紹介できます。お話だけでも聞いてみませんか？もちろん無料です。';

  const consentQR = [
    { type: 'action', action: { type: 'message', label: 'はい・お願いします', text: 'はい・お願いします' } },
    { type: 'action', action: { type: 'message', label: '今は大丈夫です', text: '今は大丈夫です' } },
  ];

  await replyQR(rt, summary, consentQR, env);
}

async function handlePhase3Text(uid, text, rt, env) {
  if (text === 'はい・お願いします' || text === 'やっぱりお願いします') {
    await kv(env).put(`phase:${uid}`, '4');
    await doFPMatch(uid, rt, env);
    return;
  }
  if (text === '今は大丈夫です') {
    const retryQR = [
      { type: 'action', action: { type: 'message', label: 'やっぱりお願いします', text: 'やっぱりお願いします' } },
      { type: 'action', action: { type: 'message', label: 'それでも大丈夫です', text: 'それでも大丈夫です' } },
    ];
    await replyQR(rt, 'お気持ちはわかります。ただ、早めに動くほど選択肢が広がります。いかがでしょうか？', retryQR, env);
    return;
  }
  if (text === 'それでも大丈夫です') {
    await kv(env).put(`phase:${uid}`, '1');
    await reply(rt, 'いつでも声がけください。', env);
    return;
  }
  // その他テキスト → 誘導を再表示
  const consentQR = [
    { type: 'action', action: { type: 'message', label: 'はい・お願いします', text: 'はい・お願いします' } },
    { type: 'action', action: { type: 'message', label: '今は大丈夫です', text: '今は大丈夫です' } },
  ];
  await replyQR(rt, 'ご紹介しましょうか？いかがでしょうか？', consentQR, env);
}

async function phase3ConsentTap(uid, rt, p, env) {
  const val = p.get('val');
  if (val === 'yes') {
    await kv(env).put(`phase:${uid}`, '4');
    await doFPMatch(uid, rt, env);
  } else {
    const retryQR = [
      { type: 'action', action: { type: 'message', label: 'やっぱりお願いします', text: 'やっぱりお願いします' } },
      { type: 'action', action: { type: 'message', label: 'それでも大丈夫です', text: 'それでも大丈夫です' } },
    ];
    await replyQR(rt, 'お気持ちはわかります。ただ、早めに動くほど選択肢が広がります。いかがでしょうか？', retryQR, env);
  }
}

async function phase3RetryTap(uid, rt, p, env) {
  const val = p.get('val');
  if (val === 'yes') {
    await kv(env).put(`phase:${uid}`, '4');
    await doFPMatch(uid, rt, env);
  } else {
    await kv(env).put(`phase:${uid}`, '1');
    await reply(rt, 'いつでも声がけください。', env);
  }
}

// ── Phase 4: FP マッチング ────────────────────────────

async function doFPMatch(uid, rt, env) {
  await reply(rt, '最適なFPを探しています... 🔍', env);

  // アクティブなFPを1件取得
  const fpRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_fps?active=eq.true&limit=1&select=*`,
    { headers: sbHeaders(env) }
  );
  const fps = await fpRes.json();
  const fp  = Array.isArray(fps) && fps.length ? fps[0] : null;

  // セッション属性を取得
  const sessRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?uid=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1&select=*`,
    { headers: sbHeaders(env) }
  );
  const sessions = await sessRes.json();
  const sess = Array.isArray(sessions) && sessions.length ? sessions[0] : {};

  // 悩みリスト取得
  const worriesRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/conversations?user_line_id=eq.${encodeURIComponent(uid)}&role=eq.user&phase=eq.1&order=created_at.asc&select=content`,
    { headers: sbHeaders(env) }
  );
  const worryRows = await worriesRes.json();
  const worries = Array.isArray(worryRows) ? worryRows.map(r => r.content) : [];

  const ageRange  = sess.age_range      || '不明';
  const job       = sess.job_status     || '不明';
  const marital   = sess.marital_status || '不明';
  const children  = sess.children_count;
  const childInfo = marital === '既婚' && children ? `（子ども${children}）` : '';
  const worryLines = worries.map(w => `・${w}`).join('\n');

  if (fp && fp.line_user_id) {
    // FPへのプッシュ通知
    const fpMsg =
      '新規相談者のご紹介です 📋\n\n' +
      `お名前（匿名）：相談者さん\n` +
      `年代：${ageRange}\n` +
      `職業：${job}\n` +
      `家族構成：${marital}${childInfo}\n` +
      `お悩み：\n${worryLines}\n\n` +
      '相談日時：調整中\n連絡方法：LINEにて';
    await push(fp.line_user_id, fpMsg, env);

    // セッション更新
    if (sess.id) {
      await updateSession(sess.id, { matched: true, selected_fp_id: fp.id, fp_line_user_id: fp.line_user_id }, env);
    }
  }

  // ユーザーへのマッチング完了通知
  await push(uid,
    'マッチングしました！担当のFPから近日中にLINEでご連絡いたします。\n\nそれまでの間に何か気になることがあれば、いつでもご連絡ください。',
    env
  );
}

// ── 属性保存ヘルパー（fp_gacha_sessionsにupsert） ─────

async function saveAttr(uid, data, env) {
  // 既存セッション確認
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?uid=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1&select=id`,
    { headers: sbHeaders(env) }
  );
  const rows = await r.json();
  if (Array.isArray(rows) && rows.length) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?id=eq.${rows[0].id}`, {
      method: 'PATCH',
      headers: sbHeaders(env),
      body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
    });
  } else {
    await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions`, {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ uid, client_line_user_id: uid, status: 'collecting', ...data }),
    });
  }
}

// ══════════════════════════════════════════════════════
//  旧フロー互換ハンドラ（postbackから呼ばれる可能性あり）
// ══════════════════════════════════════════════════════

// ── クイックリプライ部品（旧フロー用） ──────────────────
function familyQR() {
  return CLIENT_LIFECYCLE_DETAIL.map(s => ({
    type: 'action',
    action: { type: 'postback', label: s.label, data: `action=lc_detail&key=${s.key}`, displayText: s.label },
  }));
}
function ageQR() {
  return AGE_RANGES.map(a => ({
    type: 'action',
    action: { type: 'postback', label: a.label, data: `action=age&key=${a.key}`, displayText: a.label },
  }));
}
function consentQR() {
  return [
    { type: 'action', action: { type: 'postback', label: 'はい、話を聞く', data: 'action=fp_consent&val=yes', displayText: 'はい' } },
    { type: 'action', action: { type: 'postback', label: '後で考えます',   data: 'action=fp_consent&val=no',  displayText: '後で考えます' } },
  ];
}

// KV切れ時のフォールバック
async function startClient(uid, rt, env) {
  await kv(env).put(`phase:${uid}`, '1');
  await reply(rt,
    'どんなお金の悩みでも大丈夫です。\n今のお悩みをそのまま送ってください。\n\n' +
    '（例：老後の資金が心配、保険を見直したい、子どもの教育費が不安　など）', env);
}

// ── 旧フロー互換: clientLifecycleDetailTap ──────────────
async function clientLifecycleDetailTap(uid, rt, p, env) {
  const key = p.get('key');
  const detail = CLIENT_LIFECYCLE_DETAIL.find(d => d.key === key);
  if (!detail) return;
  // 旧フロー互換として新フローのPhase2に橋渡し
  await saveAttr(uid, { marital_status: detail.label }, env);
  await kv(env).put(`attr_step:${uid}`, 'age');
  await kv(env).put(`phase:${uid}`, '2');
  const ageQRItems = makeQR(['20代','30代','40代','50代','60代以上','答えたくない'], 'p2_age', 'age');
  await replyQR(rt, 'ありがとうございます。差し支えなければご年代も教えていただけますか？', ageQRItems, env);
}

// 旧フロー互換（lc アクション）
async function clientLifecycleTap(uid, rt, p, env) {
  const lcKey   = p.get('key');
  const lcLabel = LIFECYCLE_STAGES.find(s => s.key === lcKey)?.label ?? lcKey;
  await saveAttr(uid, { marital_status: lcLabel }, env);
  await kv(env).put(`attr_step:${uid}`, 'age');
  await kv(env).put(`phase:${uid}`, '2');
  const ageQRItems = makeQR(['20代','30代','40代','50代','60代以上','答えたくない'], 'p2_age', 'age');
  await replyQR(rt, 'ありがとうございます。差し支えなければご年代も教えていただけますか？', ageQRItems, env);
}

// 旧フロー互換（age アクション）
async function clientAgeTap(uid, rt, p, env) {
  const ageKey   = p.get('key');
  const ageLabel = AGE_RANGES.find(a => a.key === ageKey)?.label ?? ageKey;
  await saveAttr(uid, { age_range: ageLabel }, env);
  await kv(env).put(`phase:${uid}`, '3');
  await enterPhase3(uid, rt, env);
}

// 旧フロー互換（fp_consent アクション）
async function clientConsentTap(uid, rt, p, env) {
  const val = p.get('val');
  if (val === 'no') {
    const retryQR = [
      { type: 'action', action: { type: 'message', label: 'やっぱりお願いします', text: 'やっぱりお願いします' } },
      { type: 'action', action: { type: 'message', label: 'それでも大丈夫です', text: 'それでも大丈夫です' } },
    ];
    await replyQR(rt, 'お気持ちはわかります。ただ、早めに動くほど選択肢が広がります。いかがでしょうか？', retryQR, env);
    return;
  }
  await kv(env).put(`phase:${uid}`, '4');
  await doFPMatch(uid, rt, env);
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

  await updateSession(session_id, {
    selected_fp_id:   winner.id,
    scheduled_start:  slot.start,
    scheduled_end:    slot.end,
    status:           'confirmed',
    fp_line_user_id:  winner.line_user_id,
    consultation_date: slot.end,
  }, env);
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

// ── 相談後フォローアップ（毎朝9時JST） ─────────────────────
async function processFollowUps(env) {
  // 前日（JST）の開始・終了をUTCで算出
  const nowMs = Date.now();
  const jstMs = nowMs + JST;
  const jstToday = new Date(jstMs);
  jstToday.setUTCHours(0, 0, 0, 0);
  const todayStartUtc     = new Date(jstToday.getTime() - JST);
  const yesterdayStartUtc = new Date(todayStartUtc.getTime() - 86_400_000);

  // 前日セッションで未通知のものを取得
  const gte = encodeURIComponent(yesterdayStartUtc.toISOString());
  const lt  = encodeURIComponent(todayStartUtc.toISOString());
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?consultation_date=gte.${gte}&consultation_date=lt.${lt}&result_notified_at=is.null&select=*`,
    { headers: sbHeaders(env) }
  );
  const sessions = await res.json();
  if (!Array.isArray(sessions)) return;

  for (const s of sessions) {
    // FPにQuick Replyプッシュ
    if (s.fp_line_user_id) {
      await pushFollowUpQR(s.fp_line_user_id, s.id, 'fp', env);
    }
    // 相談者にQuick Replyプッシュ
    if (s.client_line_user_id) {
      await pushFollowUpQR(s.client_line_user_id, s.id, 'client', env);
    }
    // 通知済みマーク
    await updateSession(s.id, { result_notified_at: new Date().toISOString() }, env);
  }

  // 72時間無回答を失注として自動処理
  await processNoResponse(env);

  // 新フロー：前日にマッチングしたセッションへの翌日フォローアップ
  await processNewFlowFollowUps(env, yesterdayStartUtc, todayStartUtc);
}

// 新フロー翌日フォローアップ（matched=true & followup_sent=false & 前日作成）
async function processNewFlowFollowUps(env, yesterdayStartUtc, todayStartUtc) {
  const gte = encodeURIComponent(yesterdayStartUtc.toISOString());
  const lt  = encodeURIComponent(todayStartUtc.toISOString());
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?matched=eq.true&followup_sent=eq.false&created_at=gte.${gte}&created_at=lt.${lt}&select=*`,
    { headers: sbHeaders(env) }
  );
  const sessions = await res.json();
  if (!Array.isArray(sessions)) return;

  for (const s of sessions) {
    // ユーザーへ
    if (s.client_line_user_id) {
      await push(s.client_line_user_id,
        '昨日のご相談はいかがでしたか？もし何かご不明な点があればお気軽にご連絡ください。', env);
    }
    // FPへ
    if (s.fp_line_user_id) {
      await push(s.fp_line_user_id,
        '昨日の相談者さまはいかがでしたでしょうか？結果などお聞かせいただけますか？', env);
    }
    // followup_sent = true にマーク
    await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?id=eq.${s.id}`, {
      method: 'PATCH',
      headers: sbHeaders(env),
      body: JSON.stringify({ followup_sent: true, updated_at: new Date().toISOString() }),
    });
  }
}

async function processNoResponse(env) {
  const cutoff = encodeURIComponent(new Date(Date.now() - 72 * 3_600_000).toISOString());
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?result_notified_at=lte.${cutoff}&fp_result=is.null&select=*`,
    { headers: sbHeaders(env) }
  );
  const sessions = await res.json();
  if (!Array.isArray(sessions)) return;

  for (const s of sessions) {
    await updateSession(s.id, { fp_result: '失注' }, env);
    if (s.fp_line_user_id) {
      await push(s.fp_line_user_id,
        '72時間ご回答がなかったため、先日の相談を「失注」として自動処理しました。\n' +
        '実際と異なる場合はお手数ですが事務局までご連絡ください。', env);
    }
    console.log(`[followup] 72h no-response → 失注 session=${s.id}`);
  }
}

async function pushFollowUpQR(uid, sessionId, role, env) {
  const isFP = role === 'fp';
  const text = isFP
    ? '昨日の相談はいかがでしたか？ 🌿\n結果をお知らせください。'
    : '昨日のFP相談はいかがでしたか？ 🌿\n相談後のご状況をお聞かせください。';
  const act = isFP ? 'fp_result' : 'client_result';
  const choices = isFP
    ? ['成約', '失注', '継続中']
    : ['契約予定', '未契約', '検討中'];

  const items = choices.map(val => ({
    type: 'action',
    action: { type: 'postback', label: val, data: `action=${act}&sid=${sessionId}&val=${encodeURIComponent(val)}`, displayText: val },
  }));

  await replyQR(null, text, items, env, uid);
}

// ── フォローアップ回答保存 ────────────────────────────────
async function saveFPResult(uid, rt, p, env) {
  const sid = p.get('sid');
  const val = p.get('val');
  if (!sid || !val) return;
  await updateSession(sid, { fp_result: val }, env);
  await reply(rt, `回答ありがとうございます ✅\n結果「${val}」を記録しました。`, env);
  await checkCommissionFlag(sid, env);
}

async function saveClientResult(uid, rt, p, env) {
  const sid = p.get('sid');
  const val = p.get('val');
  if (!sid || !val) return;
  await updateSession(sid, { client_result: val }, env);
  await reply(rt, `ご回答ありがとうございます ✅\n「${val}」を記録しました。`, env);
  await checkCommissionFlag(sid, env);
}

async function checkCommissionFlag(sessionId, env) {
  const s = await getSession(sessionId, env);
  if (!s) return;
  // FP=失注 かつ 相談者=契約予定 → commission_flag=true
  if (s.fp_result === '失注' && s.client_result === '契約予定') {
    await updateSession(sessionId, { commission_flag: true }, env);
    console.log(`[followup] commission_flag=true session=${sessionId}`);
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
async function categorizeConcern(concern, history, env) {
  const list = SPECIALTIES.map(s => `${s.key}: ${s.label}`).join('\n');
  const res  = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 100,
      system: `以下の専門領域リストから、会話の文脈をもとにユーザーの悩みに最も関連するキーを最大3つ選び、カンマ区切りのみで返してください。\n\n${list}`,
      messages: [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: concern },
      ],
    }),
  });
  const raw  = (await res.json()).content?.[0]?.text ?? '';
  const keys = raw.split(',').map(k => k.trim()).filter(k => SPECIALTIES.some(s => s.key === k));
  console.log(`[categorize] "${concern.slice(0,30)}" → ${keys}`);
  return keys.length ? keys : ['other'];
}

async function generateChatResponse(userMessage, history, systemPrompt, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage },
      ],
    }),
  });
  const d = await res.json();
  return d.content?.[0]?.text ?? 'ありがとうございます 🌿';
}

async function findFPs(lifecycle, ageRange, categories, familyDetail, env) {
  const res  = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_fps?active=eq.true&select=*`, { headers: sbHeaders(env) });
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];
  return rows.filter(fp => {
    // 専門領域マッチ（必須）
    if (!fp.specialties?.some(s => categories.includes(s))) return false;

    // 家族構成マッチ
    // - family_stages 設定済みFP → 詳細キーで照合
    // - 未設定（LINE登録など旧来FP）→ legacy lifecycle_stages で照合
    if (fp.family_stages?.length) {
      if (familyDetail && !fp.family_stages.includes(familyDetail)) return false;
    } else {
      if (!fp.lifecycle_stages?.includes(lifecycle)) return false;
    }

    // 年代マッチ（FPが age_ranges を設定している場合のみ）
    if (fp.age_ranges?.length && !fp.age_ranges.includes(ageRange)) return false;

    return true;
  });
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
async function getSession(id, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?id=eq.${id}&limit=1&select=*`, { headers: sbHeaders(env) });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
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

// ── リマインダー ──────────────────────────────────────
// NOTE: Cloudflare Durable Objects Alarmsが使える場合は、
//       consultation_time - 1時間 にDO.alarm を設定すること。
//       現在はcronベース（毎時実行）で fp_reminders テーブルを検索する設計。
//
// POST /api/set-reminder  { session_id, client_line_user_id, fp_line_user_id, consultation_time }
async function handleSetReminder(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
  const { session_id, client_line_user_id, fp_line_user_id, consultation_time } = body;
  if (!session_id || !consultation_time) return new Response('Missing fields', { status: 400 });

  const reminderTime = new Date(new Date(consultation_time).getTime() - 3_600_000).toISOString();
  await fetch(`${env.SUPABASE_URL}/rest/v1/fp_reminders`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ session_id, client_line_user_id, fp_line_user_id, send_at: reminderTime, sent: false }),
  });
  return new Response('OK', { status: 200 });
}

// cronで毎時実行：1時間前リマインダー送信
async function processReminders(env) {
  const now = new Date().toISOString();
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/fp_reminders?sent=eq.false&send_at=lte.${encodeURIComponent(now)}&select=*`,
    { headers: sbHeaders(env) }
  );
  const reminders = await res.json();
  if (!Array.isArray(reminders)) return;

  for (const r of reminders) {
    const timeStr = r.consultation_time
      ? (() => {
          const { m, d, wd, h } = jstParts(r.consultation_time);
          return `${m}月${d}日(${wd}) ${h}:00`;
        })()
      : 'まもなく';
    const msg = `本日 ${timeStr} から相談のお時間です。準備はよろしいでしょうか？`;
    if (r.client_line_user_id) await push(r.client_line_user_id, msg, env);
    if (r.fp_line_user_id)     await push(r.fp_line_user_id, msg, env);
    await fetch(`${env.SUPABASE_URL}/rest/v1/fp_reminders?id=eq.${r.id}`, {
      method: 'PATCH', headers: sbHeaders(env), body: JSON.stringify({ sent: true }),
    });
  }
}

// ── オールリセット ────────────────────────────────────
async function allReset(uid, rt, env) {
  await Promise.all([
    // 会話履歴を削除
    fetch(`${env.SUPABASE_URL}/rest/v1/conversations?user_line_id=eq.${encodeURIComponent(uid)}`, {
      method: 'DELETE', headers: sbHeaders(env),
    }),
    // 相談セッションを削除
    fetch(`${env.SUPABASE_URL}/rest/v1/fp_gacha_sessions?client_line_user_id=eq.${encodeURIComponent(uid)}`, {
      method: 'DELETE', headers: sbHeaders(env),
    }),
    // KVのステートを削除（旧・新両方）
    kv(env).delete(`client:${uid}`),
    kv(env).delete(`fp_reg:${uid}`),
    kv(env).delete(`phase:${uid}`),
    kv(env).delete(`attr_step:${uid}`),
  ]);
  await reply(rt, 'リセットが完了しました 🔄\n\n' + WELCOME_MSG, env);
}

// ── Conversation History ───────────────────────────────
async function getHistory(uid, env) {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/conversations?user_line_id=eq.${encodeURIComponent(uid)}&order=created_at.asc&limit=30&select=role,content`,
    { headers: sbHeaders(env) }
  );
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return [];

  // user/assistant が交互になるよう整形（連続する同一roleを除去）
  const normalized = [];
  for (const row of rows) {
    if (!normalized.length || normalized[normalized.length - 1].role !== row.role) {
      normalized.push({ role: row.role, content: row.content });
    }
  }
  return normalized;
}

async function saveMessage(uid, role, content, env) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/conversations`, {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify({ user_line_id: uid, role, content }),
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
async function replyQR(rt, text, items, env, pushUid) {
  const msg = { type: 'text', text, quickReply: { items } };
  if (pushUid) {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushUid, messages: [msg] }),
    });
  } else {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken: rt, messages: [msg] }),
    });
  }
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
