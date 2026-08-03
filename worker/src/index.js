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
    if (url.pathname === '/api/webhook'     && request.method === 'POST') return webhook(request, env);
    if (url.pathname === '/api/store'       && request.method === 'GET')  return getStore(url, env);
    if (url.pathname === '/api/respond'     && request.method === 'POST') return respond(request, env);
    if (url.pathname === '/api/kirein-post' && request.method === 'POST') return kireinPost(request, env);
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
        await env.DB.prepare('INSERT INTO alerts (store_id, quote, area, detected, source) VALUES (?,?,?,?,?)')
          .bind(store.id, q, f.area, now, 'google').run();
        fresh.push({ area: f.area, quote: q, source: 'google' });
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
  const srcAllKirein = fresh.every(a => a.source === 'kirein');
  const srcLabel = srcAllKirein ? 'キレインのユーザー' : 'Googleの公開口コミ';
  const rows = fresh.slice(0, 5).map(a =>
    `<tr><td style="padding:8px 12px;font-weight:700;color:#c0392b;white-space:nowrap;vertical-align:top">${escHtml(a.area)}</td>`
    + `<td style="padding:8px 12px;color:#182320;line-height:1.7">「${escHtml(a.quote)}」</td></tr>`).join('');
  const html =
    `<div style="font-family:'Hiragino Kaku Gothic ProN',sans-serif;max-width:560px;margin:0 auto;color:#182320">`
    + `<div style="background:#0e3a33;color:#fff;padding:22px 24px;border-radius:14px 14px 0 0">`
    + `<div style="font-size:13px;opacity:.85">キレイン 清潔アラート</div>`
    + `<div style="font-size:19px;font-weight:700;margin-top:4px">${escHtml(name)}に、新しい清潔の声が届きました</div></div>`
    + `<div style="border:1px solid #e4eae7;border-top:none;border-radius:0 0 14px 14px;padding:20px 24px">`
    + `<p style="font-size:13px;color:#5d6b66;line-height:1.8;margin:0 0 14px">${srcLabel}から、清潔に関する気になる声を${fresh.length}件検知しました。悪い評判が広がる前に、対応をお客様ページに公開しましょう。</p>`
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
    'SELECT quote,area,detected,source FROM alerts WHERE store_id=? ORDER BY id DESC LIMIT 10'
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

// ── キレイン独自アプリの清潔ネガ投稿を受ける（消費者アプリ index.html から）──
// 濫用面を絞るため「稼働中の店だけ」扱い、それ以外は黙って無視。重複はスキップ。
async function kireinPost(request, env) {
  let b; try { b = JSON.parse(await request.text()); } catch { return json({ error: 'bad json' }, 400); }
  const placeId = (b.place_id || '').toString().trim();
  if (!placeId) return json({ error: 'place_id required' }, 400);

  const store = await env.DB.prepare("SELECT id,name,email,status FROM stores WHERE id=?").bind(placeId).first();
  if (!store || store.status !== 'active') return json({ ok: true, skipped: 'not-active' });  // 非契約は無視（通知しない）

  const rating = Number(b.rating);
  const area = (b.area || '').toString().slice(0, 40) || '清潔全般';
  const hasArea = !!(b.area && b.area !== '清潔全般');
  const isNeg = (!isNaN(rating) && rating <= 2) || hasArea;   // 低評価 or 具体的なネガ項目あり
  if (!isNeg) return json({ ok: true, skipped: 'not-negative' });

  const q = ((b.quote || '').toString().slice(0, 200).trim()) || (area + 'について気になる声が届きました');
  const dup = await env.DB.prepare('SELECT 1 FROM alerts WHERE store_id=? AND quote=? LIMIT 1').bind(store.id, q).first();
  if (dup) return json({ ok: true, skipped: 'dup' });

  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO alerts (store_id, quote, area, detected, source) VALUES (?,?,?,?,?)')
    .bind(store.id, q, area, now, 'kirein').run();
  try { await notifyStore(store, [{ area, quote: q, source: 'kirein' }], env); } catch (e) { /* 送信失敗は無視 */ }
  return json({ ok: true });
}

// ── 清潔ワード解析 v2（精度優先・近接ルール／店内＋店外。prospect.mjs・diagnose.html と同一）──
const AREAS = [
  { k: 'トイレ',           re: /トイレ|お手洗|化粧室|洗面所?|便所/ },
  { k: '席・テーブル',     re: /テーブル|座席|カウンター|お?席|シート/ },
  { k: '床・店内',         re: /床|店内|通路|内装|階段/ },
  { k: '食器・グラス',     re: /食器|グラス|コップ|お皿|カトラリー|お?箸|おしぼり/ },
  { k: '手洗い・衛生',     re: /手洗|石鹸|石けん|消毒/ },
  { k: '店前・入口',       re: /店[のの　 ]?前|店頭|入口|入り口|玄関|軒先|外観|外壁/, ext: true },
  { k: 'ゴミ置き場',       re: /ゴミ|ごみ|生ゴミ|ゴミ袋|ゴミ置|ゴミ捨/, ext: true },
  { k: '裏・バックヤード', re: /裏[口手にのを　 ]|バックヤード|路地|側溝|排水溝|溝/, ext: true },
  { k: '外の匂い・排気',   re: /排気|換気扇|ダクト|近隣|ご近所|住民/, ext: true },
];
const HARD_NEG = /汚[いくれかっ]|きたな|不潔|べたべた|ベタベタ|べたつ|ぬめ|ぬる|ほこり|埃|カビ|かび|虫|ゴキブリ|コバエ|ハエ|ネズミ|散らか|放置|溜ま|山積|べとべと/;
const NEG_SMELL = /悪臭|異臭|カビ臭|かび臭|下水.{0,3}臭|ドブ臭|生ゴミ.{0,3}臭|排水.{0,3}臭|臭[いくかっ]|くさ[いくかっ]|におい.{0,5}(気にな|きつ|ひど|する)|匂い.{0,5}(気にな|きつ|ひど)|タバコ.{0,5}(臭|きつ|ひど|充満)|煙.{0,5}(充満|きつ|ひど)/;
const NEG_SMELL_STANDALONE = /悪臭|異臭|カビ臭|かび臭|下水.{0,3}臭|ドブ臭|生ゴミ.{0,3}臭/;
const POS = /(きれい|綺麗|キレイ|清潔|ピカピカ|衛生的|行き届|手入れ.{0,3}(され|行き届)|清潔感)/;
function classify(rv) {
  const text = rv && rv.text;
  if (!text) return null;
  const N = 16;
  for (const a of AREAS) {
    const re = new RegExp(a.re.source, 'g'); let m;
    while ((m = re.exec(text))) {
      const win = text.slice(Math.max(0, m.index - N), m.index + m[0].length + N);
      if (HARD_NEG.test(win) || NEG_SMELL.test(win)) return { s: 'neg', area: a.k, ext: !!a.ext, text };
    }
  }
  if (NEG_SMELL_STANDALONE.test(text)) return { s: 'neg', area: '外の匂い・排気', ext: true, text };
  if (POS.test(text)) return { s: 'pos', area: '清潔全般', ext: false, text };
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
