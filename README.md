# キレイン（Kirein）— 清潔認証＋改善ダッシュボード 公開サイト

飲食・接客店舗の清潔さを第三者（覆面調査＋客の声）で認証し、**店が"自店の詳細な清潔情報＝改善点"を見るために月¥3,000**を払う静的サイト。バックエンド不要・GitHub Pages即公開可。

## 確定モデル
- **無料**：認証・客が見る認証ページ・掲示QR・清潔スコアの"点数（概要）"
- **¥3,000/月（詳細プラン）**：覆面調査の具体的な指摘・改善点＋お客様の声の中身＋項目別の推移
- 覆面調査員へのバック＝担当店月額の**25%（建国メンバー30%）をAmazonギフト**で／客の常時評価＝ポイント制①
- 清掃業者紹介・F&Bクレジットは**次フェーズ**

## ファイル
| ファイル | 役割 | 課金 |
|---|---|---|
| `index.html` | 店舗向けLP（手売り用） | — |
| `cert.html?s=<店舗ID>` | 客が見る認証ページ（QRの飛び先） | 無料 |
| `poster.html?s=<店舗ID>` | 店が貼る掲示ポスター＋QR | 無料 |
| `dashboard.html?s=<店舗ID>` | 店ダッシュボード：概要は無料 | 無料 |
| `dashboard.html?s=<店舗ID>&key=<解除キー>` | ↑の**詳細を解除**（改善点・客の声） | ¥3,000 |
| `stores.json` | 認証店データ（概要・公開） | — |
| `detail/<解除キー>.json` | **詳細レポート（有料の中身）** | — |

## 店を1つ認証する（無料）
`stores.json` の `stores` に1つ足す（id・name・area・category・rank[silver/gold/platinum/black]・certifiedAt・nextAudit・scores・reviews・teaser{improvements,feedback}）。
→ 客向け認証 `cert.html?s=<id>` ／ 掲示物 `poster.html?s=<id>` ／ 概要ダッシュ `dashboard.html?s=<id>`

## 詳細プラン（¥3,000）を開通する
1. 覆面調査の結果を **`detail/<ランダムな解除キー>.json`** に作る（`storeId`・`summary`・`improvements[]`・`feedback[]`・`trend[]`。見本＝`detail/demo-k7m2x9.json`）
2. 解除キーはURLで推測されない**ランダム文字列**にする（＝これがペイウォール。キーを知る店だけ詳細が見える）
3. 店に **`dashboard.html?s=<id>&key=<解除キー>`** のURL（or キー）を渡す
4. 支払い＝Stripe/請求で回収 → 入金確認後にキーを発行（解約時はキーを無効化＝該当jsonを消す）

⚠️ 詳細は`detail/<key>.json`に**分離**（stores.jsonには入れない）。stores.jsonは公開＝詳細を入れると無料で漏れる。
⚠️ ポスターのQRは**公開サイトから**開いて印刷（QRが本番URLになる）。

## 公開（GitHub Pages）
静的サイト。`index.html`がルート。GitHub Pagesにそのまま載る。独自ドメイン（kirein.jp）は後からCNAMEで接続。
