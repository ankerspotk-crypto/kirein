// キレイン Phase3② ②：Firestore セキュリティルールを Admin SDK でデプロイする。
//   firebase login（ブラウザ）不要＝サービスアカウント鍵で firebaserules を叩く。
//   既定は DRY-RUN（現行の本番ルールを読んで表示するだけ）。反映は末尾 --apply。
//
// 使い方：
//   1) Firebaseコンソール(kirein-ac148)→プロジェクトの設定→サービスアカウント→「新しい秘密鍵を生成」
//   2) cd /Users/apple/cloud/kirein/tools   （firebase-admin は導入済み）
//   3) 下見（現行ルールを表示・書き込み無し）:
//        node deploy_firestore_rules.mjs --key ~/Downloads/kirein-ac148-firebase-adminsdk-XXXX.json
//   4) 反映:
//        node deploy_firestore_rules.mjs --key <同じパス> --apply

import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { readFileSync } from 'node:fs';

const TARGET_PROJECT = 'kirein-ac148';
const APPLY = process.argv.includes('--apply');
const RULES_PATH = new URL('../firestore.rules', import.meta.url);   // リポ直下の firestore.rules

function keyPath() {
  const i = process.argv.indexOf('--key');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.GOOGLE_APPLICATION_CREDENTIALS || null;
}

async function main() {
  const kp = keyPath();
  if (!kp) { console.error('✗ --key <サービスアカウントJSON> か GOOGLE_APPLICATION_CREDENTIALS が要ります。'); process.exit(1); }
  const sa = JSON.parse(readFileSync(kp, 'utf8'));
  if (sa.project_id !== TARGET_PROJECT) {
    console.error(`✗ 鍵の project_id が ${TARGET_PROJECT} ではありません（${sa.project_id}）。中止。`); process.exit(1);
  }
  initializeApp({ credential: cert(sa) });
  const sr = getSecurityRules();

  console.log(`モード: ${APPLY ? '⚠️  APPLY（本番ルールを差し替えます）' : 'DRY-RUN（現行ルールを表示するだけ）'}`);
  console.log(`対象: ${TARGET_PROJECT}\n`);

  // まず現行の本番ルールを読む（＝差し替えで消すものが無いか確認・SA読取権限の確認も兼ねる）
  const current = await sr.getFirestoreRuleset();
  const curSrc = (current.source || []).map(f => f.content).join('\n');
  console.log('── 現行の本番ルール ──');
  console.log(curSrc);
  console.log('──────────────────────\n');

  const newSrc = readFileSync(RULES_PATH, 'utf8');
  // 差し替えで消える可能性のある collection を軽くチェック（posts/stores/私が書いた分 以外の match が現行にあれば警告）
  const curCollections = [...curSrc.matchAll(/match\s+\/([a-zA-Z0-9_]+)\//g)].map(m => m[1]);
  const newCollections = [...newSrc.matchAll(/match\s+\/([a-zA-Z0-9_]+)\//g)].map(m => m[1]);
  const dropped = curCollections.filter(c => !newCollections.includes(c));
  if (dropped.length) console.log(`⚠️ 現行にあり新版に無い collection の match: ${[...new Set(dropped)].join(', ')}（意図確認）`);
  else console.log('✅ collection の match 構成は現行と整合（取りこぼし無し）');

  if (!APPLY) { console.log('\n（DRY-RUN。反映するには --apply）'); process.exit(0); }

  await sr.releaseFirestoreRulesetFromSource(newSrc);
  console.log('\n✅ Firestore ルールを本番に反映しました。');
}

main().catch(e => { console.error('✗ エラー:', e && e.message ? e.message : e); process.exit(1); });
