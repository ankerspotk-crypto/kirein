#!/usr/bin/env node
// キレイン 見込み店 抽出エンジン（社内営業ツール）
// 指定エリアの飲食店をGoogle Placesで探し、公開口コミに「清潔ネガ」が付いた店だけを抽出。
// 店ごとに“当てフック文面”＋無料診断URLを生成し、CSV/JSONで出力する。
//
// 使い方:
//   PLACES_KEY=あなたのPlacesキー node tools/prospect.mjs --area "難波 居酒屋" --limit 40 --out prospects
//   node tools/prospect.mjs --mock            # 鍵なしでパイプライン検証（サンプルデータ）
//
// ⚠️ 方針(memory準拠):
//  - 冷たいDMのフックに Google口コミを丸ごと引用しない（帰属義務・ToS）。要約(エリア名)だけ。
//    生の引用・詳細は、相手が無料診断(diagnose.html)に来てから見せる。
//  - 旧Places API（textsearch/details）を使用。
//  - 抽出リストは営業のための一時作業データ。長期保管・再配布はしない。
//  - 送信は人間が1件ずつ（特定電子メール法：送信者明示＋オプトアウトを文面に同梱済み）。

import { writeFileSync } from 'node:fs';

// ── 引数 ──
const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);
const AREA   = getArg('area', '難波 居酒屋');
const LIMIT  = parseInt(getArg('limit', '40'), 10);
const OUT    = getArg('out', 'prospects');
const MOCK   = has('mock');
const DIAG_BASE = getArg('diag', 'https://kirein.net/diagnose.html');
const KEY    = process.env.PLACES_KEY || '';

if (!MOCK && !KEY) {
  console.error('❌ PLACES_KEY が未設定です。 例) PLACES_KEY=xxxx node tools/prospect.mjs --area "難波 居酒屋"');
  console.error('   まず動作だけ見るなら: node tools/prospect.mjs --mock');
  process.exit(1);
}

// ── 清潔ワード解析（Worker と同じロジックを移植）──
const AREAS = [
  { k: 'トイレ',        re: /トイレ|お手洗|化粧室|洗面|便所/ },
  { k: 'におい・換気',  re: /にお|匂|臭|ニオイ|香り|煙|タバコ|たばこ|喫煙|換気|空気/ },
  { k: '席・テーブル',  re: /席|テーブル|座席|シート|カウンター/ },
  { k: '床・店内',      re: /床|店内|通路|壁|内装|入口|階段/ },
  { k: '食器・グラス',  re: /食器|グラス|コップ|お皿|カトラリー|箸|おしぼり/ },
  { k: '手洗い・衛生',  re: /手洗|石鹸|石けん|消毒|衛生/ },
];
const NEG = /汚[いくれ]|きたな|不潔|くさ[いく]|臭[いく]|ベタベタ|べたつ|ぬめ|ほこり|埃|カビ|かび|虫|ゴキブリ|コバエ|ハエ|散らか|落ちて(い|た)|古[くび].{0,3}汚|残念|気にな|清掃.{0,5}(され|してな|不足|甘)|掃除.{0,5}(され|してな|不足|甘)/;
// prospect用: NEGだけだと「料理が残念」等の誤検出が混じる。清潔エリア語との共起を"強シグナル"とする。
function classifyClean(text) {
  if (!text) return null;
  const areaHit = AREAS.find(a => a.re.test(text));
  const neg = NEG.test(text);
  if (!neg) return null;
  return { area: areaHit ? areaHit.k : '清潔全般', strong: !!areaHit, text };
}

// ── 店ごとの“当てフック文面”を生成（要約のみ・丸引用しない）──
function buildHook(store) {
  const areas = [...new Set(store.negAreas)].filter(a => a !== '清潔全般');
  const areaPhrase = areas.length ? areas.join('・') : '清潔面';
  const diag = `${DIAG_BASE}?s=${encodeURIComponent(store.place_id)}`;
  return [
    `【${store.name} ご担当者様】`,
    `突然のご連絡失礼します。飲食店の清潔の評判を可視化する第三者サービス「キレイン」です。`,
    `貴店の公開されている口コミを拝見したところ、${areaPhrase}に関して清潔面で気になる記述が見られました（${store.negCount}件）。`,
    `こうした声は、女性・デート・高単価のお客様が“何も言わず二度と来ない”きっかけになりがちです。`,
    `キレインは、この手の声を24時間自動で見張り、対応した事実をお客様に見える化します（晒しではなく改善の可視化）。`,
    `まずは無料の清潔リスク診断をご用意しました（現地訪問なし・公開口コミからの簡易分析）。ご確認ください：`,
    diag,
    `※ご不要でしたら本メッセージは破棄してください。／キレイン運営 kirein.jp@gmail.com`,
  ].join('\n');
}

// ── Places 旧API 呼び出し ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getJSON(url) { const r = await fetch(url); return r.json(); }

async function textSearch(query, cap) {
  const found = [];
  let token = null, page = 0;
  do {
    const u = token
      ? `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${token}&key=${KEY}`
      : `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&language=ja&region=jp&type=restaurant&key=${KEY}`;
    const d = await getJSON(u);
    if (d.status === 'OVER_QUERY_LIMIT') { console.error('⚠️ Google API クォータ超過。中断します。'); break; }
    if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') { console.error('⚠️ textsearch status:', d.status, d.error_message || ''); break; }
    for (const r of d.results || []) found.push({ place_id: r.place_id, name: r.name, addr: r.formatted_address || '', rating: r.rating, total: r.user_ratings_total });
    token = d.next_page_token || null;
    page++;
    if (token && found.length < cap) await sleep(2200); // next_page_token は有効化まで待ちが要る
  } while (token && found.length < cap && page < 3);
  return found.slice(0, cap);
}

async function placeDetails(placeId) {
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,formatted_address,rating,user_ratings_total,reviews,url&language=ja&key=${KEY}`;
  const d = await getJSON(u);
  return d.result || null;
}

// ── モックデータ（--mock：鍵なしでパイプライン検証）──
const MOCK_STORES = [
  { place_id: 'MOCK_A', name: '難波酒場 とら', addr: '大阪市中央区難波1-1', rating: 3.4, total: 210,
    reviews: [
      { text: '料理は美味しいけどトイレが少し汚れていて残念でした。' },
      { text: '店員さんは親切。ただ手洗い場の石鹸が切れていた。' },
      { text: '価格も手頃で満足です。' },
    ] },
  { place_id: 'MOCK_B', name: '天神串カツ 花', addr: '福岡市中央区天神2-2', rating: 3.9, total: 88,
    reviews: [
      { text: '店内のたばこの匂いが気になった。換気が弱いかも。' },
      { text: 'カウンターがベタベタしていて気になりました。' },
    ] },
  { place_id: 'MOCK_C', name: 'きれい食堂', addr: '名古屋市中区栄3-3', rating: 4.6, total: 500,
    reviews: [
      { text: 'いつ行ってもピカピカで清潔感があります。' },
      { text: '料理の量が少し残念。' }, // 清潔ネガではない（料理の残念）＝除外されるべき
    ] },
];

// ── 1店を評価してprospectか判定 ──
function evalStore(detail) {
  const reviews = detail.reviews || [];
  const negs = [];
  for (const rv of reviews) {
    const c = classifyClean(rv.text || rv);
    if (c) negs.push(c);
  }
  const strong = negs.filter(n => n.strong);          // 清潔エリア語と共起＝高シグナル
  if (strong.length === 0) return null;               // 強い清潔ネガが無ければ見込みから外す
  return {
    place_id: detail.place_id || detail.reference,
    name: detail.name,
    addr: detail.formatted_address || detail.addr || '',
    rating: detail.rating ?? '',
    total: detail.user_ratings_total ?? detail.total ?? '',
    negCount: strong.length,
    negAreas: strong.map(n => n.area),
    score: strong.length * 2 + new Set(strong.map(n => n.area)).size, // 件数×2＋エリアの広さ
  };
}

// ── CSV 出力 ──
function toCSV(rows) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['順位', '店名', '住所', '評価', '口コミ数', '検知エリア', 'ネガ件数', '診断URL', 'フック文面'];
  const lines = [head.map(esc).join(',')];
  rows.forEach((r, i) => {
    lines.push([
      i + 1, r.name, r.addr, r.rating, r.total,
      [...new Set(r.negAreas)].join(' / '), r.negCount,
      `${DIAG_BASE}?s=${r.place_id}`, r.hook,
    ].map(esc).join(','));
  });
  return lines.join('\r\n');
}

// ── メイン ──
async function main() {
  let details = [];
  if (MOCK) {
    console.log('🧪 MOCKモード（ネットワーク非使用・パイプライン検証）');
    details = MOCK_STORES;
  } else {
    console.log(`🔎 エリア検索: "${AREA}"（最大 ${LIMIT} 店）`);
    const list = await textSearch(AREA, LIMIT);
    console.log(`   候補 ${list.length} 店。口コミを取得して清潔ネガを判定…`);
    for (let i = 0; i < list.length; i++) {
      const d = await placeDetails(list[i].place_id);
      if (d) { d.place_id = list[i].place_id; details.push(d); }
      await sleep(220); // クォータに優しく
      if ((i + 1) % 10 === 0) console.log(`   …${i + 1}/${list.length}`);
    }
  }

  const prospects = details.map(evalStore).filter(Boolean).sort((a, b) => b.score - a.score);
  prospects.forEach(p => { p.hook = buildHook(p); });

  const csv = toCSV(prospects);
  const jsonPath = `${OUT}.json`, csvPath = `${OUT}.csv`;
  writeFileSync(csvPath, csv);
  writeFileSync(jsonPath, JSON.stringify(prospects, null, 2));

  console.log(`\n✅ 見込み店 ${prospects.length} 件を抽出`);
  console.log(`   ${csvPath} / ${jsonPath} に出力`);
  if (prospects.length) {
    const top = prospects[0];
    console.log(`\n── 例（1位）─────────────────────`);
    console.log(`店名: ${top.name}（${top.addr}）`);
    console.log(`評価 ${top.rating} / 口コミ ${top.total} / 清潔ネガ ${top.negCount}件・エリア: ${[...new Set(top.negAreas)].join('・')}`);
    console.log(`診断URL: ${DIAG_BASE}?s=${top.place_id}`);
    console.log(`\n${top.hook}`);
    console.log(`──────────────────────────────`);
  }
}
main().catch(e => { console.error('❌', e); process.exit(1); });
