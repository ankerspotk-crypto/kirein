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
  // 定時：稼働中の各店の口コミを監視→新規ネガをアラート化
  async scheduled(event, env) {
    const { results } = await env.DB.prepare(
      "SELECT id, place_id, name FROM stores WHERE status='active' AND place_id IS NOT NULL AND place_id <> ''"
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
    if (placeId) {
      await env.DB.prepare(
        `INSERT INTO stores (id, place_id, stripe_customer, stripe_sub, status, created)
         VALUES (?,?,?,?, 'active', ?)
         ON CONFLICT(id) DO UPDATE SET status='active',
           stripe_customer=excluded.stripe_customer, stripe_sub=excluded.stripe_sub`
      ).bind(placeId, placeId, o.customer || '', o.subscription || '', now).run();
    }
  } else if (ev.type === 'customer.subscription.deleted') {
    await env.DB.prepare(`UPDATE stores SET status='canceled' WHERE stripe_sub=?`)
      .bind(ev.data.object.id).run();
  }
  return json({ received: true });
}

// ── 口コミ監視（Places Details→清潔ネガ検知→新規だけアラート）──
async function monitorStore(store, env) {
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(store.place_id)}&fields=name,reviews&language=ja&key=${env.GOOGLE_PLACES_KEY}`;
  const data = await (await fetch(u)).json();
  const place = data.result || {};
  const reviews = place.reviews || [];
  const now = new Date().toISOString();

  for (const rv of reviews) {
    const f = classify(rv);
    if (f && f.s === 'neg') {
      const q = (f.text || '').slice(0, 200);
      const dup = await env.DB.prepare('SELECT 1 FROM alerts WHERE store_id=? AND quote=? LIMIT 1')
        .bind(store.id, q).first();
      if (!dup) {
        await env.DB.prepare('INSERT INTO alerts (store_id, quote, area, detected) VALUES (?,?,?,?)')
          .bind(store.id, q, f.area, now).run();
        // TODO: ここで email(Resend) or LINE push で店に通知（Ph2b）
      }
    }
  }
  await env.DB.prepare(
    "UPDATE stores SET name=CASE WHEN name IS NULL OR name='' THEN ? ELSE name END, last_checked=? WHERE id=?"
  ).bind(place.name || '', now, store.id).run();
}

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
