// キレイン 無人バックエンド（Cloudflare Worker）
// Phase 1: 課金の無人化（Stripe Checkout + webhook + D1）
// ⚠️ Stripeの秘密鍵は wrangler secret / Cloudflare の環境変数に入れる。コードには書かない。
//    env.STRIPE_SECRET_KEY / env.STRIPE_WEBHOOK_SECRET / env.STRIPE_PRICE_ID

const CORS = {
  'Access-Control-Allow-Origin': 'https://kirein.net',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/checkout' && request.method === 'POST') return checkout(request, env);
    if (url.pathname === '/api/webhook'  && request.method === 'POST') return webhook(request, env);
    if (url.pathname === '/api/store'    && request.method === 'GET')  return getStore(url, env);
    return json({ error: 'not found' }, 404);
  },
  // Phase 2 でここに口コミ監視Cronを実装（scheduled）
  async scheduled(event, env) {
    // TODO Ph2: 稼働中storeごとにPlaces getDetails→清潔ネガ検知→アラート
  },
};

// ── ① セルフ登録→Stripe Checkout（サブスク¥3,000/月）─────────────
async function checkout(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { storeId, storeName, placeId, email } = b || {};
  if (!storeId) return json({ error: 'storeId required' }, 400);

  const p = new URLSearchParams();
  p.set('mode', 'subscription');
  p.append('line_items[0][price]', env.STRIPE_PRICE_ID);
  p.append('line_items[0][quantity]', '1');
  p.set('success_url', 'https://kirein.net/dashboard.html?s=' + encodeURIComponent(storeId) + '&welcome=1');
  p.set('cancel_url', 'https://kirein.net/business.html#price');
  if (email) p.set('customer_email', email);
  p.set('client_reference_id', storeId);
  p.append('metadata[store_id]', storeId);
  p.append('metadata[store_name]', storeName || '');
  p.append('metadata[place_id]', placeId || '');
  p.append('subscription_data[metadata][store_id]', storeId);

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: p,
  });
  const s = await r.json();
  if (s.error) return json({ error: s.error.message }, 400);
  return json({ url: s.url });
}

// ── ② Stripe webhook（支払い完了→稼働中／解約→停止）──────────────
async function webhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();
  if (!(await verifySig(body, sig, env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad signature' }, 400);
  const ev = JSON.parse(body);
  const now = new Date().toISOString();

  if (ev.type === 'checkout.session.completed') {
    const o = ev.data.object, m = o.metadata || {};
    await env.DB.prepare(
      `INSERT INTO stores (id,name,place_id,stripe_customer,stripe_sub,status,created)
       VALUES (?,?,?,?,?, 'active', ?)
       ON CONFLICT(id) DO UPDATE SET status='active',
         stripe_customer=excluded.stripe_customer, stripe_sub=excluded.stripe_sub`
    ).bind(m.store_id, m.store_name || '', m.place_id || '', o.customer, o.subscription, now).run();
  } else if (ev.type === 'customer.subscription.deleted') {
    await env.DB.prepare(`UPDATE stores SET status='canceled' WHERE stripe_sub=?`)
      .bind(ev.data.object.id).run();
  }
  return json({ received: true });
}

// ── ③ 店舗データ取得（dashboard/cert が読む）────────────────────
async function getStore(url, env) {
  const id = url.searchParams.get('s');
  if (!id) return json({ error: 'id required' }, 400);
  const store = await env.DB.prepare(
    `SELECT s.id,s.name,s.status, r.status AS resp_status, r.comment AS resp_comment, r.updated AS resp_updated
     FROM stores s LEFT JOIN responses r ON r.store_id=s.id WHERE s.id=?`
  ).bind(id).first();
  if (!store) return json({ error: 'not found' }, 404);
  return json(store);
}

// Stripe署名検証（Web Crypto・HMAC-SHA256）
async function verifySig(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + payload));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  // 長さ一致のうえで定数時間比較
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
