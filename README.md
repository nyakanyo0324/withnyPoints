# withny 配信ポイントロガー

各曜日・各時間帯にどれだけポイントが投げられたか、どの配信者・どのタイトルが
多くポイントを獲得しているかを後から可視化するためのデータ収集ツール。

配信 1 本 = `data2` シートの 1 行として記録する。

---

## 構成

| 部品 | 実行場所 | 担当 |
|---|---|---|
| **`Code.gs`** | スプレッドシートにバインドした GAS（10 分トリガー） | 配信一覧の取得、**行の作成**、配信者名／タイトル／開始時間／曜日／時／視聴者数、終了判定 |
| **`points-snapshot.js`** | **GitHub Actions**（10 分ごとの cron） | 各配信へ socket.io で一瞬だけ接続し「総ポイント数」列(H)・「ポイント最終更新」列(M)を更新 |

### なぜ 2 つに分かれているのか

配信プレイヤー上部の「◯◯ pt」（＝その配信の累計獲得ポイント）は、withny の
フロントエンドを解析した結果、**認証付きの socket.io WebSocket**
（`wss://api.withny.fun/socket.io/`・ネームスペース `/channels`・`leaderBoardUpdate` イベントの
`leaderBoard.totalPoint`）でしか流れてこない。REST API には無い。

Google Apps Script は WebSocket を扱えないため、この値だけは Node.js から取得する。
`points-snapshot.js` は「10 分に 1 回、各配信へ短時間だけ接続して現在値を 1 回読む」方式なので、
サーバーを常駐させる必要がなく、**GitHub Actions の無料枠だけで回せる**。

両者は `data2` の A 列 `streamUuid` をキーに同じ行を指す。書き込む列が重ならないので競合しない。
`points-snapshot.js` は**行を作らない**。GAS がまだ行を作っていない配信のポイントは、
累計値なので次の実行（10 分後）で書き込めばよい（取りこぼしなし）。

---

## `data2` の列仕様

| 列 | 見出し | 書き込む側 | 内容 |
|---|---|---|---|
| A | `streamUuid` | GAS | 配信の一意 ID（キー） |
| B | `配信者名` | GAS | `cast.user.name` |
| C | `username` | GAS | `cast.user.username` |
| D | `配信タイトル` | GAS | `title` |
| E | `配信開始時間` | GAS | JST `yyyy-MM-dd HH:mm:ss`（`startedAt`） |
| F | `開始曜日` | GAS | 日〜土 |
| G | `開始時` | GAS | 0〜23（JST の時） |
| H | `総ポイント数` | **Actions** | `leaderBoard.totalPoint`（最後に取得できた累計値） |
| I | `最終視聴者数` | GAS | 最新ポーリング時の `viewerCount` |
| J | `ステータス` | GAS | `配信中` / `終了` |
| K | `初回記録日時` | GAS | この行を最初に記録した JST 時刻 |
| L | `最終更新日時` | GAS | 最後に GAS が触れた JST 時刻 |
| M | `ポイント最終更新` | **Actions** | 最後に H を更新した JST 時刻 |

---

## セットアップ

### 1. GAS（`Code.gs`）

1. 対象スプレッドシートを開く → 拡張機能 → Apps Script
2. `Code.gs` の中身を貼り付けて保存
3. スプレッドシートを**開き直す** → メニューに「withny ロガー」が出る
4. 「withny ロガー」→「セットアップ（トリガー作成）」を 1 回実行し、権限を承認
   - 10 分ごとの `collectWithnyStreams` トリガーと `data2` シート（見出し行つき）が用意される
5. 「withny ロガー」→「今すぐ 1 回実行」で動作確認（実行ログにエラーが無いこと）

これで H 列以外は貯まり始める。

### 2. Google サービスアカウント（シート書き込み用）

1. [Google Cloud Console](https://console.cloud.google.com/) → 任意のプロジェクト → 「APIとサービス」→ **Google Sheets API を有効化**
2. 「認証情報」→ サービスアカウントを作成 → 「鍵」→ 鍵を追加 → **JSON** をダウンロード
3. JSON 内の `client_email`（`...@....iam.gserviceaccount.com`）をコピー
4. **対象スプレッドシートを開き、その `client_email` を「編集者」で共有**

### 3. withny のセッショントークン

1. Chrome で withny にログイン
2. F12 → **Application** タブ → 左メニュー **Cookies** → `https://www.withny.fun` を選択
3. `__Secure-next-auth.session-token` の行の **Value** をコピー
4. その値を `WITHNY_SESSION_TOKEN` に入れる

> 無期限ではない。数日〜数週間で失効することがある。失効すると Actions が
> 「accessToken が空です」で失敗するので、そのときブラウザから取り直して Secret を更新する。

#### セッショントークンが見つからないとき

`__Secure-next-auth.session-token` は **HttpOnly Cookie** なので、コンソールで
`document.cookie` と打っても**出てこない**。必ず下記のどれかで取る。

**方法 A: Cookie が分割されている場合**
値が大きいと `__Secure-next-auth.session-token.0`, `.1` … と番号付きで分かれる。
その場合は各行の Value を **番号順に連結**した文字列を渡す。
（`.0` の値 + `.1` の値、間に区切りは入れない）
または、`__Secure-next-auth.session-token.0=（.0の値）; __Secure-next-auth.session-token.1=（.1の値）`
のように `name=value; name=value` の形で丸ごと渡してもよい（スクリプトが両対応）。

**方法 B: Network タブから取る（名前が何であれ確実）**
1. F12 → **Network** タブ → ページを再読み込み
2. フィルタに `session` と入力 → `https://www.withny.fun/api/auth/session` へのリクエストをクリック
3. **Headers** → **Request Headers** の `Cookie:` 行を探す
4. その中の `__Secure-next-auth.session-token=……` の部分（`;` の手前まで）をコピー。
   分割されていれば `...session-token.0=…; ...session-token.1=…` の両方を含めてコピーし、
   そのまま `WITHNY_SESSION_TOKEN` に貼る（`name=value` を含む文字列はそのまま送られる）

**ログインできているかの確認**
ブラウザのアドレスバーに `https://www.withny.fun/api/auth/session` を直接開く。
`{"user":{…},"accessToken":"…"}` が返ればログイン済み。`{}` だけなら未ログイン
（その状態では session-token Cookie も存在しない）。

**Firefox の場合**
F12 → **ストレージ** タブ → Cookie → `https://www.withny.fun`。

### 4. GitHub リポジトリと Actions

1. GitHub で**新しいリポジトリ**を作る（Private でよい）
2. このフォルダの中身を push する（`.gitignore` により `.env` や鍵ファイルは除外される）

   ```
   cd C:\Users\nyaka\Desktop\withny
   git init
   git add .
   git commit -m "withny points logger"
   git branch -M main
   git remote add origin https://github.com/＜あなた＞/＜リポジトリ名＞.git
   git push -u origin main
   ```

3. リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で 3 つ登録:

   | 名前 | 値 |
   |---|---|
   | `WITHNY_SESSION_TOKEN` | 手順 3 でコピーした値 |
   | `SPREADSHEET_ID` | スプレッドシート URL の `/d/` と `/edit` の間 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | 手順 2 の JSON ファイルの**中身を全部**貼り付け |

4. **Actions タブ** を開き、Actions を有効化（初回は確認ボタンが出る）
5. 左の「withny points snapshot」→ **「Run workflow」** で手動実行してテスト
   - 緑のチェックになり、ログに「シート更新: N 行」が出れば成功
   - 以後は 10 分ごとに自動実行される

---

## 可視化のしかた（例）

`data2` を元にピボットテーブルを作る:

- **曜日 × 時間帯のポイント** … 行 = `開始曜日`、列 = `開始時`、値 = `総ポイント数` の合計 / 平均
- **配信者ランキング** … 行 = `配信者名`、値 = `総ポイント数` の合計・平均、`streamUuid` の個数（配信本数）
- **タイトル傾向** … `配信タイトル` を "ASMR" "雑談" "歌" などで分類して比較

`ステータス` が `終了` の行が、その配信の最終的な累計ポイント。

---

## 制約・注意点

- **総ポイント数は「10 分ごとに観測できた最新の累計値」**。`ステータス=終了` の行は
  「配信終了直前の観測値」で、真の最終値と数分〜十数分ぶんずれることがある。
- socket は接続直後に現在の累計を送ってくることを実測で確認済み（多くの配信で数秒以内に取得）。
  ただしポイント機能（チャレンジ等）が無い配信は `leaderBoardUpdate` が来ず、
  `失敗内訳: {"timeout(no-leaderBoardUpdate)":N}` としてスキップされる（H 列は空のまま。想定どおり）。
- socket に渡す UUID は配信 UUID ではなく **`ivsChannel.uuid`**（配信一覧の各要素の `ivsChannel.uuid`）。
- GitHub Actions の cron は**混雑時に数分ずれる**ことがある。また**リポジトリに 60 日間
  コミットが無いと自動で無効化**される（何かコミットすれば復活）。
- 配信一覧は `https://www.withny.fun/api/streams/with-rooms` が返す「現在ライブ中の全枠」。
  ログイン限定などで一覧に出ない配信は記録されない。
- withny の非公開 API・socket.io プロトコルに依存しているため、仕様変更で動かなくなる可能性がある。
  確認ポイント:
  - REST: `GET https://www.withny.fun/api/streams/with-rooms`（配列で `uuid` `title` `startedAt` `cast.user.name` `viewerCount` があるか）
  - 認証: `GET https://www.withny.fun/api/auth/session` に Cookie を付けて `accessToken` が返るか
  - socket: `wss://api.withny.fun/socket.io/?uuid=<ivsChannelUuid>&token=<accessToken>&passCode=undefined&EIO=4&transport=websocket`
    に接続し `40/channels,` を送った後 `42/channels,["leaderBoardUpdate",{...}]` が来るか
    （`44/channels,{"message":"ivsChannel does not exist..."}` が返るなら UUID の種類が違う）
- `.env` と サービスアカウント鍵 JSON は資格情報。共有・コミットしないこと（`.gitignore` 済み）。

### もっと正確に取りたくなったら

「終了直前の値でよい」ではなく秒単位で正確な累計が欲しい場合は、ソケットを
**つなぎっぱなしにする常駐版**が必要（GitHub Actions ではなく、自分の PC か
無料 VM＝ Oracle Cloud Always Free 等で `pm2` 常駐）。その場合は `points-snapshot.js` を
「接続を維持して `leaderBoardUpdate` を受け続け、定期的にシートへ flush する」形に戻す。

---

## ローカルで試す

```
cd C:\Users\nyaka\Desktop\withny
npm install
copy .env.example .env   # 値を埋める（GOOGLE_SERVICE_ACCOUNT_JSON は JSON の中身を 1 行で）
npm run snapshot
```
