// キレイン Phase3② ③purge：既存 posts 公開ドキュメントから
//   ネガ生content・投稿者UID（negative_items / negative_comment / user_uid）を除去する。
//   Firestoreルールは posts の update/delete を client には禁止（if false）＝これは
//   Admin SDK（サービスアカウント＝ルールをバイパス）で運営が一度だけ流す掃除用。
//
// 動作：affected な各 doc について
//   1) ネガ/UID を posts/{id}/private/detail へ退避（新アーキテクチャに保存・既存があればスキップ）
//   2) 公開 doc から当該フィールドを削除（＝read:true でも生ネガが返らなくなる＝穴②を実データ側も封鎖）
//
// ⚠️ 既定は DRY-RUN（何も書かない・対象を一覧するだけ）。実行は末尾に --apply を付ける。
// ⚠️ サービスアカウント鍵は秘密。リポにコミットしない（.gitignore 済）。
//
// 使い方：
//   1) Firebaseコンソール(kirein-ac148)→プロジェクトの設定→サービスアカウント
//      →「新しい秘密鍵を生成」で JSON を落とす（例: ~/kirein-sa.json）
//   2) cd /Users/apple/cloud/kirein/tools && npm i firebase-admin
//   3) 下見（安全・書き込みなし）:
//        GOOGLE_APPLICATION_CREDENTIALS=~/kirein-sa.json node purge_posts_neg.mjs
//      または  node purge_posts_neg.mjs --key ~/kirein-sa.json
//   4) 実行（本番を書き換え）:
//        GOOGLE_APPLICATION_CREDENTIALS=~/kirein-sa.json node purge_posts_neg.mjs --apply

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const PRIVATE_FIELDS = ['negative_items', 'negative_comment', 'user_uid'];
const APPLY = process.argv.includes('--apply');

// 鍵の場所：--key <path> か GOOGLE_APPLICATION_CREDENTIALS
function keyPath() {
  const i = process.argv.indexOf('--key');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return null;
}

async function main() {
  const kp = keyPath();
  if (!kp) {
    console.error('✗ サービスアカウント鍵が要ります。--key <path> か GOOGLE_APPLICATION_CREDENTIALS を指定してください。');
    process.exit(1);
  }
  const sa = JSON.parse(readFileSync(kp, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  console.log(`モード: ${APPLY ? '⚠️  APPLY（本番を書き換えます）' : 'DRY-RUN（下見のみ・書き込みなし）'}`);
  console.log(`対象プロジェクト: ${sa.project_id}\n`);
  if (sa.project_id !== 'kirein-ac148') {
    console.error(`✗ project_id が kirein-ac148 ではありません（${sa.project_id}）。誤爆防止のため中止。`);
    process.exit(1);
  }

  const snap = await db.collection('posts').get();
  let scanned = 0, affected = 0, migrated = 0, stripped = 0;
  let batch = db.batch(), ops = 0;

  for (const doc of snap.docs) {
    scanned++;
    const d = doc.data();
    const present = PRIVATE_FIELDS.filter(k => k in d);
    if (!present.length) continue;         // 既に公開項目のみ＝新toilet.html後の投稿
    affected++;
    console.log(`${APPLY ? '[APPLY]' : '[DRY] '} ${doc.id}  →除去: ${present.join(', ')}`);
    if (!APPLY) continue;

    // 1) 退避（新アーキテクチャの private/detail へ。既存があれば上書きしない）
    const privRef = doc.ref.collection('private').doc('detail');
    const exists = (await privRef.get()).exists;
    if (!exists) {
      const payload = { place_id: d.place_id ?? null, migrated_at: FieldValue.serverTimestamp() };
      for (const k of present) payload[k] = d[k];
      batch.set(privRef, payload, { merge: true });
      ops++; migrated++;
    }
    // 2) 公開 doc から削除
    const strip = {};
    for (const k of present) strip[k] = FieldValue.delete();
    batch.update(doc.ref, strip);
    ops++; stripped++;

    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (APPLY && ops > 0) await batch.commit();

  console.log(`\n── 結果 ──`);
  console.log(`走査 posts: ${scanned}`);
  console.log(`ネガ/UID を持つ doc: ${affected}`);
  if (APPLY) {
    console.log(`private/detail へ退避: ${migrated}`);
    console.log(`公開 doc から除去: ${stripped}`);
    console.log(`✅ 完了。以後 posts の公開読取に生ネガは含まれません。`);
  } else {
    console.log(`（DRY-RUN。実行するには --apply を付けてください）`);
  }
}

main().catch(e => { console.error('✗ エラー:', e); process.exit(1); });
