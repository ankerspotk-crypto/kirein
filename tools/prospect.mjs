#!/usr/bin/env node
// キレイン 見込み店 抽出エンジン（社内営業ツール）
// 指定エリアの飲食店をGoogle Placesで探し、公開口コミに「清潔ネガ」が付いた店だけを抽出。
// 店ごとに“当てフック文面”＋無料診断URLを生成し、CSV/JSONで出力する。
//
// 使い方:
//   PLACES_KEY=あなたのPlacesキー node tools/prospect.mjs --area "難波 居酒屋" --limit 40 --out prospects
//   node tools/prospect.mjs --mock            # 鍵なしでパイプライン検証（サンプルデータ）
//   （--loose  : フィルタを緩める。清潔エリア語と共起しないネガ口コミも拾う）
//
// 出力: <out>.csv / <out>.json / <out>.log(診断ログ)
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
const LOOSE  = has('loose');
const DIAG_BASE = getArg('diag', 'https://kirein.net/diagnose.html');
const KEY    = process.env.PLACES_KEY || '';

// ── 診断ログ（画面にも出しつつ <out>.log に残す）──
const LOG = [];
const say = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); LOG.push(s); console.log(s); };

if (!MOCK && !KEY) {
  console.error('❌ PLACES_KEY が未設定です。 例) PLACES_KEY=xxxx node tools/prospect.mjs --area "難波 居酒屋"');
  console.error('   まず動作だけ見るなら: node tools/prospect.mjs --mock');
  process.exit(1);
}

// ── 清潔ワード解析 v2（精度優先・近接ルール／店内＋店外）──
// エリア語の「すぐ近く(±N)」に 明確な汚れ語 or 負の匂い がある時だけ清潔ネガと判定。
// → 食べ物の「香り」や、清潔と無関係の「残念/気になる」で誤爆しない。
const CLEAN_AREAS = [
  // 🏠 店内（客が体験）
  { k: 'トイレ',           re: /トイレ|お手洗|化粧室|洗面所?|便所/ },
  { k: '席・テーブル',     re: /テーブル|座席|カウンター|お?席|シート/ },
  { k: '床・店内',         re: /床|店内|通路|内装|階段/ },
  { k: '食器・グラス',     re: /食器|グラス|コップ|お皿|カトラリー|お?箸|おしぼり/ },
  { k: '手洗い・衛生',     re: /手洗|石鹸|石けん|消毒/ },
  // 🚪 店外（通行人・近隣＝非客が気づく）
  { k: '店前・入口',       re: /店[のの　 ]?前|店頭|入口|入り口|玄関|軒先|外観|外壁/, ext: true },
  { k: 'ゴミ置き場',       re: /ゴミ|ごみ|生ゴミ|ゴミ袋|ゴミ置|ゴミ捨/, ext: true },
  { k: '裏・バックヤード', re: /裏[口手にのを　 ]|バックヤード|路地|側溝|排水溝|溝/, ext: true },
  { k: '外の匂い・排気',   re: /排気|換気扇|ダクト|近隣|ご近所|住民/, ext: true },
];
// 明確な汚れ語（あいまいな 残念/気になる は入れない）
const HARD_NEG = /汚[いくれかっ]|きたな|不潔|べたべた|ベタベタ|べたつ|ぬめ|ぬる|ほこり|埃|カビ|かび|虫|ゴキブリ|コバエ|ハエ|ネズミ|散らか|放置|溜ま|山積|べとべと/;
// 明確に負の匂い（食べ物の「香り」は含めない）
const NEG_SMELL = /悪臭|異臭|カビ臭|かび臭|下水.{0,3}臭|ドブ臭|生ゴミ.{0,3}臭|排水.{0,3}臭|臭[いくかっ]|くさ[いくかっ]|におい.{0,5}(気にな|きつ|ひど|する)|匂い.{0,5}(気にな|きつ|ひど)|タバコ.{0,5}(臭|きつ|ひど|充満)|煙.{0,5}(充満|きつ|ひど)/;
const NEG_SMELL_STANDALONE = /悪臭|異臭|カビ臭|かび臭|下水.{0,3}臭|ドブ臭|生ゴミ.{0,3}臭/;

function classifyClean(text) {
  if (!text) return null;
  const N = 16; // 近接ウィンドウ
  for (const a of CLEAN_AREAS) {
    const re = new RegExp(a.re.source, 'g'); let m;
    while ((m = re.exec(text))) {
      const win = text.slice(Math.max(0, m.index - N), m.index + m[0].length + N);
      if (HARD_NEG.test(win) || NEG_SMELL.test(win)) return { area: a.k, ext: !!a.ext, strong: true, text };
    }
  }
  // 場所語が無くても、明確な悪臭は「外の匂い」として拾う（近隣クレーム型）
  if (NEG_SMELL_STANDALONE.test(text)) return { area: '外の匂い・排気', ext: true, strong: true, text };
  return null;
}

// ── 店ごとの“当てフック文面”を生成（要約のみ・丸引用しない）──
function buildHook(store) {
  const areas = [...new Set(store.negAreas)].filter(a => a !== '清潔全般');
  const areaPhrase = areas.length ? areas.join('・') : '清潔面';
  const diag = `${DIAG_BASE}?s=${encodeURIComponent(store.place_id)}`;
  const extLine = store.extCount > 0
    ? `特に店外（店前・ゴミ置き場・裏・匂い）に関する記述は、お客様だけでなく通行人・近隣の方の目にも触れ、近隣トラブルや行政への相談に発展しやすい点です。`
    : `こうした声は、女性・デート・高単価のお客様が“何も言わず二度と来ない”きっかけになりがちです。`;
  return [
    `【${store.name} ご担当者様】`,
    `突然のご連絡失礼します。飲食店の清潔の評判を可視化する第三者サービス「キレイン」です。`,
    `貴店の公開されている口コミを拝見したところ、${areaPhrase}に関して清潔面で気になる記述が見られました（${store.negCount}件）。`,
    extLine,
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
    say(`   [textsearch p${page + 1}] status=${d.status || '(なし)'}${d.error_message ? ' / ' + d.error_message : ''} / results=${(d.results || []).length}`);
    if (d.status && d.status !== 'OK' && d.status !== 'ZERO_RESULTS') break;
    for (const r of d.results || []) found.push({ place_id: r.place_id, name: r.name, addr: r.formatted_address || '', rating: r.rating, total: r.user_ratings_total });
    token = d.next_page_token || null;
    page++;
    if (token && found.length < cap) await sleep(2200);
  } while (token && found.length < cap && page < 3);
  return found.slice(0, cap);
}

async function placeDetails(placeId) {
  const u = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=name,formatted_address,rating,user_ratings_total,reviews,url&language=ja&key=${KEY}`;
  const d = await getJSON(u);
  return { result: d.result || null, status: d.status };
}

// ── モックデータ（--mock）──
const MOCK_STORES = [
  { place_id: 'MOCK_A', name: '難波酒場 とら', addr: '大阪市中央区難波1-1', rating: 3.4, total: 210,
    reviews: [ { text: '料理は美味しいけどトイレが少し汚れていて残念でした。' }, { text: 'カウンターがベタベタしていて気になりました。' }, { text: '価格も手頃で満足です。' } ] },
  { place_id: 'MOCK_C', name: 'きれい食堂', addr: '名古屋市中区栄3-3', rating: 4.6, total: 500,
    reviews: [ { text: 'いつ行ってもピカピカで清潔感があります。' }, { text: '料理の量が少し残念。' } ] },
  // FP検証：食べ物の「香り」を絶賛＝清潔ネガではない → 除外されるべき
  { place_id: 'MOCK_FP', name: '柚子屋（誤検出テスト）', addr: '大阪市中央区', rating: 4.7, total: 300,
    reviews: [ { text: '柚子の香りが立った瞬間から期待を裏切らず、料理のクオリティが高くて驚きました。' }, { text: '店内の内装や雰囲気がとても良く、また来たい。残念な点は特にない。' } ] },
  // 店外検証：通行人・近隣型のクレーム → ext:true で拾うべき
  { place_id: 'MOCK_EXT', name: '路地裏酒場（店外テスト）', addr: '大阪市浪速区', rating: 4.2, total: 140,
    reviews: [ { text: '店の前にゴミが散らかっていて、入る前から少し気が引けた。' }, { text: '裏の路地からいつも悪臭がする。近隣として気になる。' } ] },
];

// ── 1店を評価してprospectか判定（v2は全て近接確定＝strong）──
function evalStore(detail) {
  const reviews = detail.reviews || [];
  const negs = [];
  for (const rv of reviews) {
    const c = classifyClean(rv.text || rv);
    if (c) negs.push(c);
  }
  if (negs.length === 0) return { prospect: null, hadReviews: reviews.length > 0, negAny: 0 };
  const extCount = negs.filter(n => n.ext).length;   // 店外(通行人・近隣)ヒット
  return {
    prospect: {
      place_id: detail.place_id || detail.reference,
      name: detail.name,
      addr: detail.formatted_address || detail.addr || '',
      rating: detail.rating ?? '',
      total: detail.user_ratings_total ?? detail.total ?? '',
      negCount: negs.length,
      negAreas: negs.map(n => n.area),
      extCount,
      score: negs.length * 2 + new Set(negs.map(n => n.area)).size + extCount * 3, // 店外は強シグナルで加点
    },
    hadReviews: reviews.length > 0, negAny: negs.length,
  };
}

function toCSV(rows) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['順位', '店名', '住所', '評価', '口コミ数', '検知エリア', 'ネガ件数', '店外', '診断URL', 'フック文面'];
  const lines = [head.map(esc).join(',')];
  rows.forEach((r, i) => {
    lines.push([i + 1, r.name, r.addr, r.rating, r.total, [...new Set(r.negAreas)].join(' / '), r.negCount, r.extCount > 0 ? '○(' + r.extCount + ')' : '', `${DIAG_BASE}?s=${r.place_id}`, r.hook].map(esc).join(','));
  });
  return lines.join('\r\n');
}

// ── メイン ──
async function main() {
  let details = [];
  say(`▶ 抽出開始  area="${AREA}"  limit=${LIMIT}  loose=${LOOSE}  mock=${MOCK}`);
  if (MOCK) {
    say('🧪 MOCKモード（ネットワーク非使用）');
    details = MOCK_STORES;
  } else {
    const list = await textSearch(AREA, LIMIT);
    say(`🔎 候補 ${list.length} 店`);
    let detailFail = 0;
    for (let i = 0; i < list.length; i++) {
      const { result, status } = await placeDetails(list[i].place_id);
      if (result) { result.place_id = list[i].place_id; details.push(result); }
      else { detailFail++; if (detailFail <= 3) say(`   [details ng] ${list[i].name} status=${status}`); }
      await sleep(220);
    }
    say(`   詳細取得: 成功 ${details.length} / 失敗 ${detailFail}`);
  }

  const evals = details.map(evalStore);
  const withReviews = evals.filter(e => e.hadReviews).length;
  const anyNeg = evals.filter(e => e.negAny > 0).length;
  const prospects = evals.map(e => e.prospect).filter(Boolean).sort((a, b) => b.score - a.score);
  prospects.forEach(p => { p.hook = buildHook(p); });

  say(`📊 口コミ有り ${withReviews}/${details.length} 店 ・ 何らかのネガ有り ${anyNeg} 店 ・ 見込み ${prospects.length} 店`);

  // 診断ヒント
  if (!MOCK && details.length === 0) {
    say('💡 候補0＝ほぼキーの問題。①ブラウザ用キー(kirein.net制限)を使ってない？②Places API(旧/legacy)が有効？③課金設定済み？ 上の status を確認（REQUEST_DENIED/INVALID_REQUEST等）。');
  } else if (prospects.length === 0 && withReviews > 0) {
    say(`💡 候補はあるが見込み0＝上位5口コミに清潔クレームが目立たない。--loose を付けて再実行するか、エリア/業種を変える（例: 評判の割れやすい業態）。`);
  } else if (prospects.length === 0 && withReviews === 0 && details.length > 0) {
    say('💡 詳細は取れたが口コミが空＝reviewsフィールドが返っていない。キーの権限(Places Details の reviews)を確認。');
  }

  writeFileSync(`${OUT}.csv`, toCSV(prospects));
  writeFileSync(`${OUT}.json`, JSON.stringify(prospects, null, 2));
  writeFileSync(`${OUT}.log`, LOG.join('\n') + '\n');
  say(`\n✅ 出力: ${OUT}.csv / ${OUT}.json / ${OUT}.log`);
  if (prospects.length) {
    const t = prospects[0];
    say(`\n── 例(1位) ${t.name}（${t.addr}）評価${t.rating}/口コミ${t.total}/ネガ${t.negCount}・${[...new Set(t.negAreas)].join('・')}`);
    say(t.hook);
  }
}
main().catch(e => { say('❌ ' + (e && e.stack || e)); try { writeFileSync(`${OUT}.log`, LOG.join('\n') + '\n'); } catch {} process.exit(1); });
