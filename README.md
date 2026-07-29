# キレイン（Kirein）— 清潔認証・コンシェルジュ版 公開サイト

飲食・接客店舗の清潔さを第三者（覆面調査）で認証し、**店が客に見せる認証ページ＋掲示ポスター/QR**を発行する。収益モデルは **ゴールド認証 ¥5,000/月 ／ ブラック認証 ¥10,000/月＋提携清掃実費**（清掃業者紹介手数料が本命）。

> 旧・自己サービス版プロト（`cloudcode/lounge/clear-map/` の消費者アプリ・Firebase版）とは別。これは手売り前提のコンシェルジュ版・静的サイト（バックエンド不要・GitHub P
ages即公開可）。

## ファイル
| ファイル | 役割 |
|---|---|
| `index.html` | 店舗向けLP（ボスが手売りに使う） |
| `cert.html?s=<店舗ID>` | **客が見る認証ページ**（QRの飛び先） |
| `poster.html?s=<店舗ID>` | 店が印刷して貼る掲示ポスター＋QR |
| `stores.json` | 認証店データ（唯一の編集対象） |
| `assets/` | ロゴ |

## 認証店を1つ追加する（＝1契約）
`stores.json` の `stores` 配列に1つ足すだけ：
```json
{
  "id": "英数字のユニークID",         // URL/QRに使う。例 tanaka-sushi-sakae
  "name": "店名",
  "area": "エリア", "category": "業態",
  "rank": "black",                    // silver / gold / platinum / black
  "certifiedAt": "2026-08-01", "nextAudit": "2026-09-01",
  "scores": { "におい":4.7, "トイレ":4.9, "客席設備":4.6, "接客衛生":4.8 },
  "cleaning": "提携プロ清掃 — 毎日実施",   // 無ければ空文字
  "auditor": "キレイン公認 覆面調査員",
  "reviews": 0,
  "message": "店からの一言（任意）"
}
```
→ 客向け認証: `cert.html?s=<id>` ／ 掲示物: `poster.html?s=<id>`（印刷ボタンで出力）

⚠️ **ポスターは"公開サイト"から開いて印刷する**こと。QRは開いているURLを基準に生成するため、ローカルで作るとQRがlocalhostを指す。`?base=https://<公開URL>` で明示上書きも可。

## コンシェルジュ運用フロー
申込（LPのメール）→ 初回 覆面調査（無料）→ 認証 → `stores.json`に追加 → 掲示ポスター発行 → 毎月モニタリング＆スコア更新 → （ブラックは提携清掃を手配）

## 公開（GitHub Pages）
静的サイト。`index.html` がルート。GitHub Pages にそのまま載る。独自ドメイン（kirein.jp）は後から CNAME で接続。
