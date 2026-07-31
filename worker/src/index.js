// キレイン 無人バックエンド（Cloudflare Worker）
// 課金=Stripe Payment Link（checkout実装は不要）。Workerは webhook・監視Cron・データ提供を担う。
// ⚠️ 秘密は wrangler secret / 環境変数に入れる。コードには書かない。
//   env.STRIPE_WEBHOOK_SECRET  … Stripe webhook署名シークレット
//   env.GOOGLE_PLACES_KEY      … サーバー用Places APIキー（HTTPリファラー制限なしのもの）
//   env.DB                     … D1バインド

const CORS = {
  'Access-Control-Allow-Origin': 'https://kirein.net',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/webhook' && request.method === 'POST') return webhook(request, env);
    if (url.pathname === '/api/store'   && request.method === 'GET')  return getStore(url, env);
    if (url.pathname === '/api/respond' && request.method === 'POST') return respond(request, env);
    return json({ error: 'not found' }, 404);
  },
  // 定時：稼働中の各店の口コミを監視→新規ネガをアラート化→店にメール通知
  async scheduled(event, env) {
    const { results } = await env.DB.prepare(
      "SELECT id, place_id, name, email FROM stores WHERE status='active' AND place_id IS NOT NULL AND place_id <> ''"
    ).all();
    for (const store of results || []) {
      try { await monitorStore(store, env); } catch (e) { /* この店はスキップ */ }
    }
  },
};

// ── Stripe webhook：支払い完了→店をactive化（client_reference_id=place_id）──
async function webhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();
  if (!(await verifySig(body, sig, env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 400);
  const ev = JSON.parse(body);
  const now = new Date().toISOString();

  if (ev.type === 'checkout.session.completed') {
    const o = ev.data.object;
    const placeId = o.client_reference_id || (o.metadata && o.metadata.place_id) || null;
    const email = (o.customer_details && o.customer_details.email) || o.customer_email || '';
    if (placeId) {
      await env.DB.prepare(
        `INSERT INTO stores (id, place_id, email, stripe_customer, stripe_sub, status, created)
         VALUES (?,?,?,?,?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET status='active',
           stripe_customer=excluded.stripe_customer, stripe_sub=excluded.stripe_sub,
           email=CASE WHEN excluded.email<>'' THEN excluded.email ELSE stores.email END`
      ).bind(placeId, placeId, email, o.customer || '', o.subscription || '', now).run();
    }
  } else if (ev.type === 'customer.subscription.deleted') {
    await env.DB.prepare(`UPDATE stores SET status='canceled' WHERE stripe_sub=?`)
      .bind(ev.data.object.id).run();
  }
  return json({ received: true });
}

// ── 口コミ監視（Places Details 旧API→清潔ネガ検知→新規だけアラート）──
async function monitorStore(store, env) {
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(store.place_id)}&fields=name,reviews&language=ja&key=${env.GOOGLE_PLACES_KEY}`;
  const data = await (await fetch(u)).json();
  const place = data.result || {};
  const reviews = place.reviews || [];  // 旧API: reviews[].text / rating / author_name
  const placeName = place.name || '';
  const now = new Date().toISOString();

  const fresh = [];   // このrunで新規に検知したネガ（まとめて1通で通知）
  for (const rv of reviews) {
    const f = classify(rv);
    if (f && f.s === 'neg') {
      const q = (f.text || '').slice(0, 200);
      const dup = await env.DB.prepare('SELECT 1 FROM alerts WHERE store_id=? AND quote=? LIMIT 1')
        .bind(store.id, q).first();
      if (!dup) {
        await env.DB.prepare('INSERT INTO alerts (store_id, quote, area, detected) VALUES (?,?,?,?)')
          .bind(store.id, q, f.area, now).run();
        fresh.push({ area: f.area, quote: q });
      }
    }
  }
  await env.DB.prepare(
    "UPDATE stores SET name=CASE WHEN name IS NULL OR name='' THEN ? ELSE name END, last_checked=? WHERE id=?"
  ).bind(placeName, now, store.id).run();

  // Ph2b: 新規ネガがあれば店にメール（鍵/宛先が無ければ黙ってスキップ＝監視は止めない）
  if (fresh.length) {
    try { await notifyStore({ ...store, name: store.name || placeName }, fresh, env); } catch (e) { /* 送信失敗は無視 */ }
  }
}

// ── 新規アラートを店にメール通知（Resend）──
async function notifyStore(store, fresh, env) {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM) return;   // 未設定なら送らない
  const to = store.email;
  if (!to) return;                                       // 宛先不明なら送らない
  const dash = (env.DASHBOARD_URL || 'https://kirein.net/dashboard.html') + '?s=' + encodeURIComponent(store.id);
  const name = store.name || 'お店';
  const rows = fresh.slice(0, 5).map(a =>
    `<tr><td style="padding:8px 12px;font-weight:700;color:#c0392b;white-space:nowrap;vertical-align:top">${escHtml(a.area)}</td>`
    + `<td style="padding:8px 12px;color:#182320;line-height:1.7">「${escHtml(a.quote)}」</td></tr>`).join('');
  const html =
    `<div style="font-family:'Hiragino Kaku Gothic ProN',sans-serif;max-width:560px;margin:0 auto;color:#182320">`
    + `<div style="background:#0e3a33;color:#fff;padding:22px 24px;border-radius:14px 14px 0 0">`
    + `<div style="font-size:13px;opacity:.85">キレイン 清潔アラート</div>`
    + `<div style="font-size:19px;font-weight:700;margin-top:4px">${escHtml(name)}に、新しい清潔の声が届きました</div></div>`
    + `<div style="border:1px solid #e4eae7;border-top:none;border-radius:0 0 14px 14px;padding:20px 24px">`
    + `<p style="font-size:13px;color:#5d6b66;line-height:1.8;margin:0 0 14px">Googleの公開口コミから、清潔に関する気になる声を${fresh.length}件検知しました。悪い評判が広がる前に、対応をお客様ページに公開しましょう。</p>`
    + `<table style="width:100%;border-collapse:collapse;background:#fff5f5;border-radius:10px;overflow:hidden;font-size:13px">${rows}</table>`
    + `<div style="margin-top:20px;text-align:center"><a href="${dash}" style="display:inline-block;background:#25b598;color:#062019;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:14px">ダッシュボードで対応する →</a></div>`
    + `<p style="font-size:11px;color:#9fb3ac;line-height:1.7;margin:18px 0 0">この声の中身・投稿者はお客様には公開されません。公開されるのはあなたが選ぶ「対応状況」だけです。<br>キレイン ｜ 清潔の声の自動見張り</p></div></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.ALERT_FROM, to: [to],
      subject: `【キレイン】${name}に新しい清潔の声（${fresh.length}件）`,
      html,
    }),
  });
  if (!res.ok) throw new Error('resend ' + res.status);
}
function escHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ── 店舗データ取得（dashboard/cert が読む）──
async function getStore(url, env) {
  const id = url.searchParams.get('s');
  if (!id) return json({ error: 'id required' }, 400);
  const store = await env.DB.prepare('SELECT id,name,status,last_checked FROM stores WHERE id=?').bind(id).first();
  if (!store) return json({ error: 'not found', status: 'none' }, 404);
  const resp = await env.DB.prepare('SELECT status,comment,updated FROM responses WHERE store_id=?').bind(id).first();
  const { results: alerts } = await env.DB.prepare(
    'SELECT quote,area,detected FROM alerts WHERE store_id=? ORDER BY id DESC LIMIT 10'
  ).bind(id).all();
  return json({ ...store, response: resp || null, alerts: alerts || [] });
}

// ── 店舗が対応コメントを更新（dashboardから）──
async function respond(request, env) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { storeId, status, comment } = b || {};
  if (!storeId) return json({ error: 'storeId required' }, 400);
  // 稼働中の店だけ更新可
  const s = await env.DB.prepare("SELECT status FROM stores WHERE id=?").bind(storeId).first();
  if (!s || s.status !== 'active') return json({ error: 'not active' }, 403);
  await env.DB.prepare(
    `INSERT INTO responses (store_id,status,comment,updated) VALUES (?,?,?,?)
     ON CONFLICT(store_id) DO UPDATE SET status=excluded.status, comment=excluded.comment, updated=excluded.updated`
  ).bind(storeId, status || 'responded', comment || '', new Date().toISOString()).run();
  return json({ ok: true });
}

// ── 清潔ワード解析（diagnose.html と同じロジックを移植）──
const AREAS = [
  { k: 'トイレ',        re: /トイレ|お手洗|化粧室|洗面|便所/ },
  { k: 'におい・換気',  re: /にお|匂|臭|ニオイ|香り|煙|タバコ|たばこ|喫煙|換気|空気/ },
  { k: '席・テーブル',  re: /席|テーブル|座席|シート|カウンター/ },
  { k: '床・店内',      re: /床|店内|通路|壁|内装|入口|階段/ },
  { k: '食器・グラス',  re: /食器|グラス|コップ|お皿|カトラリー|箸|おしぼり/ },
  { k: '手洗い・衛生',  re: /手洗|石鹸|石けん|消毒|衛生/ },
];
const NEG = /汚[いくれ]|きたな|不潔|くさ[いく]|臭[いく]|ベタベタ|べたつ|ぬめ|ほこり|埃|カビ|かび|虫|ゴキブリ|コバエ|ハエ|散らか|落ちて(い|た)|古[くび].{0,3}汚|残念|気にな|清掃.{0,5}(され|してな|不足|甘)|掃除.{0,5}(され|してな|不足|甘)/;
const POS = /(きれい|綺麗|キレイ|清潔|ピカピカ|衛生的|行き届|清潔感)/;
function classify(rv) {
  const text = rv && rv.text;
  if (!text) return null;
  const hasArea = AREAS.some(a => a.re.test(text));
  const neg = NEG.test(text), pos = POS.test(text);
  if (!hasArea && !neg && !pos) return null;
  const area = (AREAS.find(a => a.re.test(text)) || {}).k || '清潔全般';
  if (neg) return { s: 'neg', area, text };
  if (pos) return { s: 'pos', area, text };
  return null;
}

// Stripe署名検証（Web Crypto・HMAC-SHA256・定数時間比較）
async function verifySig(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + payload));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
