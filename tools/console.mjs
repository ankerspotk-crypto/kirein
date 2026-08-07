#!/usr/bin/env node
// キレイン 管理コンソール（ローカル専用）
//
//   起動: node tools/console.mjs   → http://127.0.0.1:8788
//
// ⚠️ このツールは Firestore のセキュリティルールを迂回する（IAM権限で直接読む）。
//    そのため 127.0.0.1 にだけ待ち受け、外部からは一切繋がらない。
//    認証は gcloud のログイン（kirein.jp@gmail.com）をそのまま使う。
//    鍵ファイルを作らないので、置き忘れ・流出の心配がない。
//
// 何ができるか:
//   ・利用者が「気になった点」として書いた非公開の中身を読む（他のどこからも見えない）
//   ・投稿を削除する（利用規約で約束した削除請求への対応手段）
//   ・数字を見る（投稿数・声のある店・日別の伸び）

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

const PROJECT = 'kirein-ac148';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PORT = 8788;
const GCLOUD = '/opt/homebrew/share/google-cloud-sdk/bin/gcloud';
const BACKUP_DIR = path.join(process.cwd(), 'tools', '_deleted_backup');

// ── 認証（gcloudのトークンを使い回す。50分で取り直す）────────────────
let _tok = null, _tokAt = 0;
async function token() {
  if (_tok && Date.now() - _tokAt < 50 * 60 * 1000) return _tok;
  try {
    const { stdout } = await execFileP(GCLOUD, ['auth', 'print-access-token']);
    _tok = stdout.trim(); _tokAt = Date.now();
    return _tok;
  } catch (e) {
    throw new Error('gcloudの認証が切れています。ターミナルで `gcloud auth login` を実行してください。');
  }
}
async function fs_(url, init = {}) {
  const t = await token();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 200 ? res.json() : {};
}

// ── Firestoreの値を素のJSに直す ───────────────────────────────
const val = (v) => {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)]));
  return null;
};
const fields = (d) => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, val(v)]));

// ── 投稿を集める（公開ぶんと非公開ぶんを突き合わせる）──────────────
async function loadPosts() {
  // 公開ぶん
  const pub = [];
  let pageToken = '';
  do {
    const url = `${BASE}/posts?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const j = await fs_(url);
    for (const d of j.documents || []) {
      pub.push({ id: d.name.split('/').pop(), ...fields(d), _updated: d.updateTime });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);

  // 非公開ぶん（ここが本題。ルール上どのクライアントからも読めない）
  const priv = {};
  const q = await fs_(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'private', allDescendants: true }], limit: 2000 } }),
  });
  for (const r of Array.isArray(q) ? q : []) {
    if (!r.document) continue;
    const parts = r.document.name.split('/');       // .../posts/{postId}/private/detail
    const postId = parts[parts.indexOf('posts') + 1];
    priv[postId] = fields(r.document);
  }

  const rows = pub.map((p) => ({ ...p, _private: priv[p.id] || null }));
  // 新しい順
  const ts = (x) => new Date(x.created_at || x._updated || 0).getTime() || 0;
  rows.sort((a, b) => ts(b) - ts(a));
  return rows;
}

// ── 削除（⚠️ 元に戻せないので、必ず先に控えを取る）──────────────────
async function deletePost(id) {
  const one = await fs_(`${BASE}/posts/${encodeURIComponent(id)}`).catch(() => null);
  let detail = null;
  try { detail = await fs_(`${BASE}/posts/${encodeURIComponent(id)}/private/detail`); } catch (e) {}

  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `${stamp}_${id}.json`);
  await fs.writeFile(file, JSON.stringify({ post: one, private: detail }, null, 2), 'utf8');

  try { await fs_(`${BASE}/posts/${encodeURIComponent(id)}/private/detail`, { method: 'DELETE' }); } catch (e) {}
  await fs_(`${BASE}/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: true, backup: file };
}

// ── 画面 ────────────────────────────────────────────────
const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>キレイン 管理コンソール</title>
<style>
 :root{--pine:#0d3d6b;--deep:#082444;--mint:#3a9fd5;--ink:#162233;--muted:#5a6d80;--line:#dde8f2;--warn:#b45309;--bad:#c0392b}
 *{box-sizing:border-box}
 body{margin:0;background:#f4f8fc;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.7}
 header{background:linear-gradient(150deg,var(--pine),var(--deep));color:#fff;padding:18px 0}
 .wrap{max-width:1000px;margin:0 auto;padding:0 16px}
 h1{font-size:19px;margin:4px 0 0}
 header p{margin:0;font-size:12px;opacity:.85}
 main{padding:18px 0 60px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
 .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px}
 .stat .k{font-size:11.5px;color:var(--muted)}
 .stat .v{font-size:23px;font-weight:700;color:var(--pine)}
 .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
 .bar input{flex:1;min-width:190px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;font-family:inherit}
 button{font-family:inherit;cursor:pointer;border-radius:9px;font-weight:700;font-size:13px}
 .b1{background:var(--pine);color:#fff;border:none;padding:9px 16px}
 .b2{background:#fff;color:var(--pine);border:1px solid var(--line);padding:9px 14px}
 .post{background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:10px}
 .ptop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
 .shop{font-weight:700;font-size:14.5px}
 .meta{font-size:11.5px;color:var(--muted)}
 .tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
 .t{font-size:11.5px;background:#fff3e6;color:var(--warn);border:1px solid #fed7aa;border-radius:999px;padding:2px 9px;font-weight:700}
 .priv{background:#fffbf5;border-left:3px solid var(--warn);padding:9px 11px;border-radius:0 8px 8px 0;margin-top:9px;font-size:13px}
 .priv .lb{font-size:11px;color:var(--warn);font-weight:700}
 .cmt{background:#f6f9fc;border-radius:8px;padding:9px 11px;margin-top:8px;font-size:13px}
 .del{background:#fff;color:var(--bad);border:1px solid #f5c6c0;padding:6px 12px;font-size:12px}
 .del:hover{background:var(--bad);color:#fff}
 .rate{font-size:12.5px;color:var(--muted)}
 .empty{color:var(--muted);padding:26px;text-align:center}
 .err{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:11px 13px;border-radius:10px;margin-bottom:12px;font-size:13px}
 .note{background:#eef5fb;border-left:3px solid var(--mint);padding:10px 12px;border-radius:0 8px 8px 0;font-size:12.5px;margin-bottom:14px}
</style>
<header><div class="wrap"><p>キレイン（ローカル専用・この端末からのみ）</p><h1>管理コンソール</h1></div></header>
<main class="wrap">
  <div class="note">利用者が書いた<b>「気になった点」の中身</b>は、サービス上どこにも公開されません。ここでだけ読めます。</div>
  <div id="err"></div>
  <div class="cards" id="stats"></div>
  <div class="bar">
    <input id="q" placeholder="店名で絞り込む">
    <button class="b2" onclick="setF('all')">すべて</button>
    <button class="b2" onclick="setF('neg')">不満があるものだけ</button>
    <button class="b2" onclick="setF('photo')">写真つき</button>
    <button class="b1" onclick="load()">再読み込み</button>
  </div>
  <div id="list" class="empty">読み込み中…</div>
</main>
<script>
let ROWS=[], F='all';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jdate=s=>{const d=new Date(s); return isNaN(d)?'':d.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});};

async function load(){
  document.getElementById('err').innerHTML='';
  try{
    const r=await fetch('/api/posts'); const j=await r.json();
    if(j.error) throw new Error(j.error);
    ROWS=j.rows; renderStats(j.stats); render();
  }catch(e){
    document.getElementById('err').innerHTML='<div class="err">'+esc(e.message)+'</div>';
    document.getElementById('list').innerHTML='';
  }
}
function renderStats(s){
  document.getElementById('stats').innerHTML=[
    ['投稿の総数',s.total],['不満が書かれた投稿',s.withNeg],['声が届いた店',s.stores],
    ['今日',s.today],['過去7日',s.week],['写真つき',s.photo]
  ].map(([k,v])=>'<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
}
function setF(f){F=f;render();}
function render(){
  const q=document.getElementById('q').value.trim().toLowerCase();
  let rows=ROWS;
  if(F==='neg')   rows=rows.filter(r=>r._private&&((r._private.negative_items||[]).length||r._private.negative_comment));
  if(F==='photo') rows=rows.filter(r=>r.photo_url);
  if(q) rows=rows.filter(r=>(r.shop_name||'').toLowerCase().includes(q));
  const box=document.getElementById('list');
  if(!rows.length){ box.className='empty'; box.textContent='該当なし'; return; }
  box.className='';
  box.innerHTML=rows.map(r=>{
    const p=r._private||{};
    const items=(p.negative_items||[]).filter(Boolean);
    const negc=p.negative_comment||'';
    const rate=[r.cleanliness_rating&&('清潔 '+r.cleanliness_rating),r.air_rating&&('空気 '+r.air_rating)].filter(Boolean).join(' ／ ');
    return '<div class="post"><div class="ptop"><div>'
      +'<div class="shop">'+esc(r.shop_name||'(店名なし)')+'</div>'
      +'<div class="meta">'+jdate(r.created_at)+(rate?' ・ '+esc(rate):'')+(r.vote?' ・ '+esc(r.vote):'')+'</div>'
      +'</div><button class="del" onclick="del(\\''+r.id+'\\')">削除</button></div>'
      +(items.length?'<div class="tags">'+items.map(i=>'<span class="t">'+esc(i)+'</span>').join('')+'</div>':'')
      +(negc?'<div class="priv"><div class="lb">非公開の指摘</div>'+esc(negc)+'</div>':'')
      +(r.comment?'<div class="cmt">'+esc(r.comment)+'</div>':'')
      +(r.photo_url?'<div style="margin-top:8px"><a href="'+esc(r.photo_url)+'" target="_blank">写真を開く →</a></div>':'')
      +'</div>';
  }).join('');
}
async function del(id){
  if(!confirm('この投稿を削除します。元に戻せません。\\n（削除前の控えは tools/_deleted_backup に保存されます）')) return;
  const r=await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
  const j=await r.json();
  if(j.error){ alert('失敗: '+j.error); return; }
  alert('削除しました。控え: '+j.backup);
  load();
}
document.getElementById('q').addEventListener('input',render);
load();
</script>`;

// ── サーバー ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    if (req.url === '/' || req.url.startsWith('/?')) return send(200, PAGE, 'text/html');

    if (req.url.startsWith('/api/posts')) {
      const rows = await loadPosts();
      const day = 86400000, now = Date.now();
      const ts = (x) => new Date(x.created_at || x._updated || 0).getTime() || 0;
      const stats = {
        total: rows.length,
        withNeg: rows.filter((r) => r._private && ((r._private.negative_items || []).length || r._private.negative_comment)).length,
        stores: new Set(rows.map((r) => r.place_id || r.shop_id).filter(Boolean)).size,
        today: rows.filter((r) => now - ts(r) < day).length,
        week: rows.filter((r) => now - ts(r) < 7 * day).length,
        photo: rows.filter((r) => r.photo_url).length,
      };
      return send(200, { rows, stats });
    }

    if (req.url === '/api/delete' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const { id } = JSON.parse(body || '{}');
      if (!id) return send(400, { error: 'idがありません' });
      return send(200, await deletePost(id));
    }

    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});

// ⚠️ 127.0.0.1 のみ。外部からは繋がらない。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nキレイン 管理コンソール`);
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  この端末からのみ開けます。止めるときは Ctrl+C\n`);
});
