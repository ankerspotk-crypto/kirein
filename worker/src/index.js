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
    if (url.pathname === '/api/prospect'    && request.method === 'GET')  return prospect(url, env);
    if (url.pathname === '/api/place-photo' && request.method === 'GET')  return placePhoto(request, url, env);
    if (url.pathname === '/api/vote-counts' && request.method === 'GET')  return voteCounts(url, env);
    return json({ error: 'not found' }, 404);
  },
  // 定時：稼働中の各店の口コミを監視→新規ネガをアラート化→店にメール通知
  async scheduled(event, env) {
    const { results } = await env.DB.prepare(
      "SELECT id, place_id, name, email, token FROM stores WHERE status='active' AND place_id IS NOT NULL AND place_id <> ''"
    ).all();
    for (const store of results || []) {
      try { await monitorStore(store, env); } catch (e) { /* この店はスキップ */ }
    }
    // 消費者アプリ向けの投票集計を作り直す（訪問者ごとの全件読取をなくすため）
    try { await rebuildVoteCounts(env); } catch (e) { /* 次回のCronで作り直す */ }
  },
};

// ── 投票集計：消費者アプリが1リクエストで読むための事前集計 ──────────────
//   ⚠️ これが無いと toilet.html が訪問のたびに Firestore の posts を全件取得する。
//      投稿が増えるほど1人あたりの読取が増える構造＝拡散すると無料枠が枯れる。
//      ここで6時間に1回だけ集計し、結果をD1に置いて配る（訪問者のFirestore読取=0）。
async function voteCounts(url, env) {
  // 手動再集計（初回投入や、Cronを待てない時に使う）。トークン必須。
  if (url.searchParams.get('rebuild') === '1') {
    if (!env.PROSPECT_TOKEN || url.searchParams.get('t') !== env.PROSPECT_TOKEN) return json({ error: 'forbidden' }, 403);
    const r = await rebuildVoteCounts(env);
    return json({ ok: true, ...r });
  }
  const row = await env.DB.prepare("SELECT value, updated FROM kv_cache WHERE key='vote_counts'").first();
  if (!row) return json({ counts: {}, updated: null, note: 'not built yet' }, 200);
  return new Response(JSON.stringify({ counts: JSON.parse(row.value), updated: row.updated }), {
    headers: {
      'Content-Type': 'application/json',
      // エッジに載せて Worker 実行そのものも減らす（集計は6時間おきなので30分保持で十分）
      'Cache-Control': 'public, max-age=1800',
      ...CORS,
    },
  });
}

async function rebuildVoteCounts(env) {
  const KEY = env.FIREBASE_API_KEY;
  if (!KEY) return { skipped: 'FIREBASE_API_KEY 未設定' };
  const endpoint = `https://firestore.googleapis.com/v1/projects/kirein-ac148/databases/(default)/documents:runQuery?key=${KEY}`;
  const fv = (o) => (o ? (o.stringValue ?? o.integerValue ?? o.doubleValue ?? '') : '');
  const counts = {};
  let offset = 0, scanned = 0, truncated = false;
  const PAGE = 1000, MAX = 50000;   // 上限に当たったら黙って切らずに報告する

  while (true) {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'posts' }],
        // 必要な項目だけ取り出す＝投稿が増えても転送量が膨らまない
        select: { fields: [
          { fieldPath: 'place_id' }, { fieldPath: 'shop_id' },
          { fieldPath: 'vote' },     { fieldPath: 'cleanliness_rating' },
        ] },
        offset, limit: PAGE,
      },
    };
    // ⚠️ FIREBASE_API_KEY は kirein.net のリファラー制限付き。サーバー(Worker)からは
    //    Referer を明示しないと弾かれる（付けないと 403 で集計が永久に空になる）。
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://kirein.net/' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: 'firestore ' + res.status };
    const rows = await res.json();
    const list = Array.isArray(rows) ? rows.filter(r => r.document) : [];
    for (const r of list) {
      const f = r.document.fields || {};
      const key = fv(f.place_id) || fv(f.shop_id);
      if (!key) continue;
      if (!counts[key]) counts[key] = { clean: 0, dirty: 0 };
      const vote = String(fv(f.vote) || '');
      if (vote === 'clean')      counts[key].clean++;
      else if (vote === 'dirty') counts[key].dirty++;
      else {
        // ⚠️ vote はクイック投票でしか入らない。通常投稿を一律 dirty に数えると
        //    星5の投稿まで「気になる」に計上され、店に不当な評価が付く。評価点で判定する。
        const r5 = Number(fv(f.cleanliness_rating));
        if (!isNaN(r5) && r5 >= 4)      counts[key].clean++;
        else if (!isNaN(r5) && r5 <= 2) counts[key].dirty++;
        // 3（どちらとも言えない）はどちらにも数えない
      }
    }
    scanned += list.length;
    if (list.length < PAGE) break;
    offset += PAGE;
    if (offset >= MAX) { truncated = true; break; }
  }

  await env.DB.prepare(
    "INSERT INTO kv_cache (key, value, updated) VALUES ('vote_counts', ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated"
  ).bind(JSON.stringify(counts), new Date().toISOString()).run();

  return { scanned, stores: Object.keys(counts).length, truncated };
}

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
      const newToken = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO stores (id, place_id, email, stripe_customer, stripe_sub, status, created, token)
         VALUES (?,?,?,?,?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET status='active',
           stripe_customer=excluded.stripe_customer, stripe_sub=excluded.stripe_sub,
           email=CASE WHEN excluded.email<>'' THEN excluded.email ELSE stores.email END,
           token=CASE WHEN stores.token IS NULL OR stores.token='' THEN excluded.token ELSE stores.token END`
      ).bind(placeId, placeId, email, o.customer || '', o.subscription || '', now, newToken).run();
      // 決済直後：本人専用ダッシュボードリンク（?s=&t=）をメールで渡す＝認証の受け渡し
      try {
        const st = await env.DB.prepare('SELECT id,name,email,token FROM stores WHERE id=?').bind(placeId).first();
        if (st) await notifyWelcome(st, env);
      } catch (e) { /* 送信失敗は監視に影響させない */ }
      // 契約前にキレインアプリに溜まっていた過去のネガ投稿(Firestore)を一度だけD1へ取り込む
      try { await backfillKireinPosts(placeId, env); } catch (e) { /* バックフィル失敗は無視 */ }
    }
  } else if (ev.type === 'customer.subscription.deleted') {
    await env.DB.prepare(`UPDATE stores SET status='canceled' WHERE stripe_sub=?`)
      .bind(ev.data.object.id).run();
  }
  return json({ received: true });
}

// ── 店の写真プロキシ：クライアントにPlacesキーを一切露出させず、Worker(秘密キー GOOGLE_PLACES_KEY)経由で画像を返す ──
//   ・ref（保存済み photo_reference）優先。無ければ place_id から Details で取得（参照のプロジェクト依存を回避）。
//   ・将来 Places API(新) へ移す時は本関数の中だけ差し替えればよく、アプリ(toilet.html)は無改修。
//   ・濫用抑制：kirein.net 以外の明示リファラーは拒否＋1日キャッシュで呼び出し削減。
async function placePhoto(request, url, env) {
  if (!env.GOOGLE_PLACES_KEY) return new Response('', { status: 503, headers: CORS });

  // ⚠️ ホットリンク防止。以前は「Refererが有る時だけ」判定していたため、
  //    Refererを送らなければ素通りし、誰でもループでPlaces課金を焼けた。
  //    Referer必須にすると Referrer-Policy 次第で正規ユーザーの画像が消えるので、
  //    ブラウザだけが送る Sec-Fetch-* も許可条件に含めて二重で判定する。
  const ref0 = request.headers.get('referer') || '';
  const site = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  const dest = (request.headers.get('sec-fetch-dest') || '').toLowerCase();
  const okReferer = /^https?:\/\/([a-z0-9-]+\.)?kirein\.net(\/|$)/i.test(ref0);
  const okFetch   = (site === 'same-origin' || site === 'same-site') && (dest === 'image' || dest === 'empty');
  if (!okReferer && !okFetch) {
    return new Response('', { status: 403, headers: CORS });   // 無断ホットリンク・スクリプトからの直叩きを拒否
  }

  let w = parseInt(url.searchParams.get('w') || '400', 10);
  if (!Number.isFinite(w) || w < 40) w = 400;
  if (w > 800) w = 800;

  let photoRef = url.searchParams.get('ref') || '';
  const placeId = url.searchParams.get('place_id') || '';

  if (!photoRef && placeId) {
    try {
      const d = await (await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=photos&language=ja&key=${env.GOOGLE_PLACES_KEY}`
      )).json();
      photoRef = (d.result && d.result.photos && d.result.photos[0] && d.result.photos[0].photo_reference) || '';
    } catch (e) { /* 取れなければ写真なし */ }
  }
  if (!photoRef || photoRef.length > 2000) return new Response('', { status: 404, headers: CORS });

  let resp;
  try {
    resp = await fetch(
      `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photoreference=${encodeURIComponent(photoRef)}&key=${env.GOOGLE_PLACES_KEY}`,
      { redirect: 'follow' }
    );
  } catch (e) { return new Response('', { status: 502, headers: CORS }); }

  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok || !ct.startsWith('image/')) return new Response('', { status: 404, headers: CORS });

  const headers = new Headers(CORS);
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=86400');   // 1日キャッシュ
  return new Response(resp.body, { status: 200, headers });
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
  const dash = (env.DASHBOARD_URL || 'https://kirein.net/dashboard.html') + '?s=' + encodeURIComponent(store.id)
    + (store.token ? '&t=' + encodeURIComponent(store.token) : '');
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

// ── 決済直後の歓迎メール：本人専用ダッシュボードリンク（?s=&t=）を渡す ──
async function notifyWelcome(store, env) {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM || !store.email || !store.token) return;
  const dash = (env.DASHBOARD_URL || 'https://kirein.net/dashboard.html')
    + '?s=' + encodeURIComponent(store.id) + '&t=' + encodeURIComponent(store.token);
  const name = store.name || 'お店';
  const html =
    `<div style="font-family:'Hiragino Kaku Gothic ProN',sans-serif;max-width:560px;margin:0 auto;color:#182320">`
    + `<div style="background:#0e3a33;color:#fff;padding:22px 24px;border-radius:14px 14px 0 0">`
    + `<div style="font-size:13px;opacity:.85">キレイン｜見張りを開始しました</div>`
    + `<div style="font-size:19px;font-weight:700;margin-top:4px">${escHtml(name)}の清潔の評判を、24時間見張ります</div></div>`
    + `<div style="border:1px solid #e4eae7;border-top:none;border-radius:0 0 14px 14px;padding:20px 24px">`
    + `<p style="font-size:13px;color:#5d6b66;line-height:1.8;margin:0 0 14px">お申し込みありがとうございます。下のボタンから、あなたのお店専用のダッシュボードを開けます。<b>このリンクはあなた（店舗）だけのものです。第三者には共有しないでください。</b></p>`
    + `<div style="margin:18px 0;text-align:center"><a href="${dash}" style="display:inline-block;background:#25b598;color:#062019;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:999px;font-size:14px">ダッシュボードを開く →</a></div>`
    + `<p style="font-size:12px;color:#5d6b66;line-height:1.8">ダッシュボードでは、届いた清潔の声の確認と、お客様への対応の公開ができます。届いた声の中身・投稿者はお客様には公開されません。</p>`
    + `<p style="font-size:11px;color:#9fb3ac;line-height:1.7;margin:18px 0 0">解約はStripeからの明細メールでいつでも／お問い合わせ kirein.jp@gmail.com<br>キレイン ｜ 清潔の声の自動見張り</p></div></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [store.email], subject: `【キレイン】${name}の見張りを開始しました（ダッシュボードのご案内）`, html }),
  });
  if (!res.ok) throw new Error('resend ' + res.status);
}
function escHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ── 店舗データ取得（dashboard/cert が読む）──
async function getStore(url, env) {
  const id = url.searchParams.get('s');
  if (!id) return json({ error: 'id required' }, 400);
  const token = url.searchParams.get('t') || '';
  const store = await env.DB.prepare('SELECT id,name,status,last_checked,token FROM stores WHERE id=?').bind(id).first();
  if (!store) return json({ error: 'not found', status: 'none' }, 404);
  const resp = await env.DB.prepare('SELECT status,comment,updated FROM responses WHERE store_id=?').bind(id).first();
  // 生ネガ(alerts)は本人トークン一致時だけ返す。cert.html(公開)は token 無し＝alertsは出ない。
  const authed = !!(token && store.token && token === store.token);
  let alerts = [];
  if (authed) {
    const r = await env.DB.prepare(
      'SELECT quote,area,detected,source FROM alerts WHERE store_id=? ORDER BY id DESC LIMIT 60'
    ).bind(id).all();
    alerts = r.results || [];
  }
  const { token: _t, ...pub } = store;   // token 自体はレスポンスに含めない
  return json({ ...pub, response: resp || null, alerts, authed });
}

// ── 店舗が対応コメントを更新（dashboardから）──
async function respond(request, env) {
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { storeId, status, comment, token } = b || {};
  if (!storeId) return json({ error: 'storeId required' }, 400);
  // 稼働中の店＋本人トークン一致時だけ更新可
  const s = await env.DB.prepare("SELECT status,token FROM stores WHERE id=?").bind(storeId).first();
  if (!s || s.status !== 'active') return json({ error: 'not active' }, 403);
  if (!token || token !== s.token) return json({ error: 'forbidden' }, 403);
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

  const store = await env.DB.prepare("SELECT id,name,email,status,token FROM stores WHERE id=?").bind(placeId).first();
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

// ── claim時のバックフィル：既存のキレイン投稿(Firestore・公開読取)からネガをD1へ一度だけ取り込む ──
// これで dashboard は Firestore を直読みせず D1(トークン施錠済)だけで過去の声を出せる＝将来 Firestore を施錠しても壊れない。
async function backfillKireinPosts(placeId, env) {
  const KEY = env.FIREBASE_API_KEY;
  if (!KEY || !placeId) return;
  const url = `https://firestore.googleapis.com/v1/projects/kirein-ac148/databases/(default)/documents:runQuery?key=${KEY}`;
  const body = { structuredQuery: { from: [{ collectionId: 'posts' }],
    where: { fieldFilter: { field: { fieldPath: 'place_id' }, op: 'EQUAL', value: { stringValue: placeId } } } } };
  // ⚠️ キーは kirein.net のリファラー制限付き＝Refererを付けないと弾かれる
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': 'https://kirein.net/' }, body: JSON.stringify(body) });
  if (!res.ok) return;
  const rows = await res.json();
  const fv = (o) => o ? (o.stringValue ?? o.integerValue ?? o.doubleValue ?? o.timestampValue ?? '') : '';
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const f = r.document && r.document.fields; if (!f) continue;
    const rating = Number(fv(f.cleanliness_rating));
    const negItems = ((f.negative_items && f.negative_items.arrayValue && f.negative_items.arrayValue.values) || [])
      .map(v => fv(v)).filter(Boolean);
    const isNeg = (!isNaN(rating) && rating <= 2) || negItems.length > 0;
    if (!isNeg) continue;
    const area = negItems[0] || '清潔全般';
    const quote = (fv(f.negative_comment) || fv(f.comment) || (area + 'について気になる声が届きました')).toString().slice(0, 200);
    const detected = (fv(f.created_at) || new Date().toISOString()).toString();
    const dup = await env.DB.prepare('SELECT 1 FROM alerts WHERE store_id=? AND quote=? LIMIT 1').bind(placeId, quote).first();
    if (dup) continue;
    await env.DB.prepare('INSERT INTO alerts (store_id, quote, area, detected, source) VALUES (?,?,?,?,?)')
      .bind(placeId, quote, area, detected, 'kirein').run();
  }
}

// ── 見込み店 抽出（社内営業ツール）──
// WorkerがGOOGLE_PLACES_KEYで動く＝ローカルにPlacesキー不要。t=PROSPECT_TOKEN で保護（公開リポに値は置かない）。
async function prospect(url, env) {
  if (!env.PROSPECT_TOKEN || url.searchParams.get('t') !== env.PROSPECT_TOKEN) return json({ error: 'forbidden' }, 403);
  const q = (url.searchParams.get('area') || '').trim();
  if (!q) return json({ error: 'area required（?area=難波 居酒屋）' }, 400);
  const soft   = url.searchParams.get('strict') !== '1';                 // 既定soft・&strict=1で厳格
  const nearby = url.searchParams.get('nearby') === '1';                 // &nearby=1 で低評価店も拾うモード
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 20);
  const minr   = parseFloat(url.searchParams.get('minr') || '2.5');      // 評価バンド下限
  const maxr   = parseFloat(url.searchParams.get('maxr') || '5');        // 評価バンド上限（低評価狙いは3.9等）
  const mint   = parseInt(url.searchParams.get('mint') || '10', 10);     // 最低レビュー数
  const key = env.GOOGLE_PLACES_KEY;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  let cands = [];
  if (nearby) {
    // area→中心座標を取得→Nearby(rankby=distance)で低評価店も含めて拾う
    const ts = await (await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=ja&region=jp&key=${key}`)).json();
    const loc = ts.results && ts.results[0] && ts.results[0].geometry && ts.results[0].geometry.location;
    if (!loc) return json({ error: 'center not found', status: ts.status || '' }, 502);
    const parts = q.split(/\s+/); const genre = parts.length > 1 ? parts[parts.length - 1] : '';
    let token = null, page = 0;
    do {
      const nu = token
        ? `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${token}&key=${key}`
        : `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${loc.lat},${loc.lng}&rankby=distance&type=restaurant${genre ? '&keyword=' + encodeURIComponent(genre) : ''}&language=ja&key=${key}`;
      const ns = await (await fetch(nu)).json();
      for (const r of (ns.results || [])) cands.push(r);
      token = ns.next_page_token || null; page++;
      if (token && cands.length < 60) await wait(1800);
    } while (token && page < 3 && cands.length < 60);
  } else {
    const ts = await (await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&language=ja&region=jp&type=restaurant&key=${key}`)).json();
    if (ts.status && ts.status !== 'OK' && ts.status !== 'ZERO_RESULTS') return json({ error: 'places', status: ts.status, message: ts.error_message || '' }, 502);
    cands = ts.results || [];
  }

  // 評価バンド＋レビュー数で絞り、低評価優先で limit 件だけ詳細取得
  let filtered = cands.filter(c => { const r = c.rating || 0, tot = c.user_ratings_total || 0; return r >= minr && r <= maxr && tot >= mint; });
  filtered.sort((a, b) => (a.rating || 9) - (b.rating || 9));
  filtered = filtered.slice(0, limit);

  const prospects = [];
  for (const c of filtered) {
    try {
      const d = await (await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(c.place_id)}&fields=name,formatted_address,rating,user_ratings_total,reviews&language=ja&key=${key}`)).json();
      const p = d.result; if (!p) continue;
      const negs = [];
      for (const rv of (p.reviews || [])) { const f = classify(rv, soft); if (f && f.s === 'neg') negs.push(f); }
      if (!negs.length) continue;
      const areas = [...new Set(negs.map(n => n.area))];
      const extCount = negs.filter(n => n.ext).length;
      prospects.push({
        place_id: c.place_id, name: p.name, addr: p.formatted_address || '',
        rating: p.rating ?? '', total: p.user_ratings_total ?? '',
        negCount: negs.length, negAreas: areas, extCount,
        score: negs.length * 2 + areas.length + extCount * 3,
        diagnose: `https://kirein.net/diagnose.html?s=${c.place_id}`,
        hook: prospectHook(p.name, areas, negs.length, extCount, c.place_id),
      });
    } catch (e) { /* この店はスキップ */ }
  }
  prospects.sort((a, b) => b.score - a.score);
  return json({ area: q, mode: nearby ? 'nearby' : 'textsearch', candidates: cands.length, filtered: filtered.length, count: prospects.length, prospects });
}
function prospectHook(name, areas, negCount, extCount, placeId) {
  const areaPhrase = areas.filter(a => a !== '清潔全般').join('・') || '清潔面';
  const extLine = extCount > 0
    ? '特に店外（店前・ゴミ置き場・裏・匂い）に関する記述は、お客様だけでなく通行人・近隣の方の目にも触れ、近隣トラブルや行政への相談に発展しやすい点です。'
    : 'こうした声は、女性・デート・高単価のお客様が“何も言わず二度と来ない”きっかけになりがちです。';
  return [
    `【${name} ご担当者様】`,
    '突然のご連絡失礼します。飲食店の清潔の評判を可視化する第三者サービス「キレイン」です。',
    `貴店の公開されている口コミを拝見したところ、${areaPhrase}に関して清潔面で気になる記述が見られました（${negCount}件）。`,
    extLine,
    'キレインは、この手の声を24時間自動で見張り、対応した事実をお客様に見える化します（晒しではなく改善の可視化）。',
    'まずは無料の清潔リスク診断をご用意しました（現地訪問なし・公開口コミからの簡易分析）。ご確認ください：',
    `https://kirein.net/diagnose.html?s=${placeId}`,
    '※ご不要でしたら本メッセージは破棄してください。／キレイン運営 kirein.jp@gmail.com',
  ].join('\n');
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
// 弱いネガ（清潔エリア語の近くにある時＝低評価レビューに限り拾う。営業リード発掘用の recall）
const SOFT_NEG = /残念|気にな|いまひとつ|イマイチ|微妙|不衛生|清潔感.{0,3}(な|欠|薄)|綺麗とは|きれいとは|古[いくかっ]/;
const POS = /(きれい|綺麗|キレイ|清潔|ピカピカ|衛生的|行き届|手入れ.{0,3}(され|行き届)|清潔感)/;
// soft=true で弱いネガ(近接＋★4以下)も拾う。監視アラート(店に通知)は soft=false で厳格。
function classify(rv, soft) {
  const text = rv && rv.text;
  if (!text) return null;
  const rating = Number(rv && rv.rating) || 0;
  const N = 16;
  for (const a of AREAS) {
    const re = new RegExp(a.re.source, 'g'); let m;
    while ((m = re.exec(text))) {
      const win = text.slice(Math.max(0, m.index - N), m.index + m[0].length + N);
      if (HARD_NEG.test(win) || NEG_SMELL.test(win)) return { s: 'neg', area: a.k, ext: !!a.ext, text };
      if (soft && (!rating || rating <= 4) && SOFT_NEG.test(win)) return { s: 'neg', area: a.k, ext: !!a.ext, soft: true, text };
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
