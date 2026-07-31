# キレイン 無人バックエンド（Phase 1：課金の無人化）

Cloudflare Worker が `kirein.net/api/*` を処理する。店舗がセルフで登録→Stripeで¥3,000/月が自動課金→webhookで「稼働中」になりダッシュボードが開く。**人は動かない。**

> 🔐 **秘密鍵（Stripe secret 等）はこのリポジトリに絶対に書かない。** すべて `wrangler secret` でCloudflare側に入れる。Claudeは秘密鍵を扱わない。

## 構成
- `src/index.js` … Worker本体（/api/checkout, /api/webhook, /api/store）
- `schema.sql` … D1スキーマ（stores / alerts / responses）
- `wrangler.toml` … 設定（route・vars・D1バインド）

## セットアップ手順（ボスの作業）

### ① Cloudflareの準備
```bash
npm i -g wrangler
wrangler login          # ブラウザでCloudflare認証
```

### ② Stripeで商品を作る（Stripeダッシュボード）
1. 商品名「キレイン 見張りプラン」、**継続 ¥3,000 / 月（JPY）** の価格を作成
2. 出てきた **price ID（`price_...`）** を `wrangler.toml` の `STRIPE_PRICE_ID` に記入

### ③ D1データベースを作る
```bash
cd worker
wrangler d1 create kirein
# 出力の database_id を wrangler.toml の [[d1_databases]] に記入
wrangler d1 execute kirein --file=schema.sql
```

### ④ 秘密鍵を入れる（画面には残らない）
```bash
wrangler secret put STRIPE_SECRET_KEY      # sk_live_... を貼る
wrangler secret put STRIPE_WEBHOOK_SECRET  # 手順⑥で取得
```

### ⑤ デプロイ
```bash
wrangler deploy
```
→ `kirein.net/api/*` が有効になる（他のパスはGitHub Pagesのまま）。

### ⑥ Stripe webhookを登録（Stripeダッシュボード）
- エンドポイント: `https://kirein.net/api/webhook`
- 送信イベント: `checkout.session.completed`, `customer.subscription.deleted`
- 表示された **署名シークレット（`whsec_...`）** を ④ の `STRIPE_WEBHOOK_SECRET` に入れて再デプロイ

## 動作確認
1. `curl -X POST https://kirein.net/api/checkout -H "Content-Type: application/json" -d '{"storeId":"test1","storeName":"テスト店","email":"you@example.com"}'`
   → `{"url":"https://checkout.stripe.com/..."}` が返ればOK
2. そのURLでテスト決済（Stripeテストカード 4242…）→ webhookで stores に active が入る
3. `curl "https://kirein.net/api/store?s=test1"` → `status: active` が返る

## 残りのフェーズ
- **Ph2 監視**: `wrangler.toml` の crons を有効化し、`scheduled()` に Places 取得→清潔ネガ検知→アラートを実装
- **Ph3 ダッシュボード**: dashboard.html / cert.html を `/api/store` 経由でD1から読む＋対応コメント更新API

## フロント連携（Ph1デプロイ後）
`business.html` の「¥3,000で始める」を、store情報を持って `/api/checkout` にPOSTしStripeへリダイレクトするJSに差し替える（デプロイ後にClaudeが実施）。
