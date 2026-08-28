/**
 * withny 総ポイント数スナップショット（GitHub Actions 版）
 * ============================================================
 * 10 分ごとに 1 回だけ実行する短命バッチ。
 *
 *   1. WITHNY_SESSION_TOKEN からアクセストークンを取得
 *   2. 配信中の全枠を取得（https://www.withny.fun/api/streams/with-rooms）
 *   3. 各配信へ socket.io で一瞬だけ接続し、
 *      leaderBoardUpdate イベントの leaderBoard.totalPoint を 1 回受け取って切断
 *   4. data2 シートの「総ポイント数」列(H)と「ポイント最終更新」列(M)を
 *      streamUuid をキーに更新
 *   5. 終了
 *
 * 行の作成・その他の列はバインド GAS（Code.gs）が担当する。
 * このスクリプトは行を作らない。GAS がまだ行を作っていない配信の
 * ポイントは、累計値なので次回（10 分後）の実行で書き込めばよい（取りこぼしなし）。
 *
 * 必要な環境変数（GitHub Actions では Secrets）:
 *   WITHNY_SESSION_TOKEN         … ブラウザの __Secure-next-auth.session-token
 *   SPREADSHEET_ID               … スプレッドシートID
 *   GOOGLE_SERVICE_ACCOUNT_JSON  … サービスアカウント鍵 JSON の中身をそのまま
 *   SHEET_NAME                   … 任意（既定 data2）
 *
 * ローカル実行: `.env` に上記を書いて `node points-snapshot.js`
 */

'use strict';

require('dotenv').config();
const fs = require('node:fs');
const WebSocket = require('ws');
const { JWT } = require('google-auth-library');

// withny がセッション Cookie をローテーションしたら、この名前で新トークンを書き出す。
// ワークフローがこれを読んで Secret WITHNY_SESSION_TOKEN を更新する。
const ROTATED_TOKEN_FILE = '.rotated-session-token';

/* ----------------------------------------------------------------- 設定 */

const CFG = {
  sessionToken: need('WITHNY_SESSION_TOKEN'),
  spreadsheetId: need('SPREADSHEET_ID'),
  saJson: need('GOOGLE_SERVICE_ACCOUNT_JSON'),
  sheetName: process.env.SHEET_NAME || 'data2',
  perStreamTimeoutMs: intEnv('PER_STREAM_TIMEOUT_MS', 20000), // 1 配信あたりの待ち時間
  concurrency: intEnv('CONCURRENCY', 12),                     // 同時接続数
  maxStreams: intEnv('MAX_STREAMS', 80),                      // 1 回で処理する上限
};

const REST_STREAMS = 'https://www.withny.fun/api/streams/with-rooms';
const REST_SESSION = 'https://www.withny.fun/api/auth/session';
const SOCKET_BASE = 'wss://api.withny.fun/socket.io/'; // Engine.IO v4 / namespace: /channels
const ORIGIN = 'https://www.withny.fun';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COL = { TOTAL_POINTS: 'H', POINTS_UPDATE: 'M' }; // Code.gs の列と一致させる

/* ----------------------------------------------------------------- メイン */

async function main() {
  const t0 = Date.now();

  const accessToken = await getWithnyAccessToken();
  const streams = await getLiveStreams(accessToken);
  log('配信中: ' + streams.length + ' 件');
  if (!streams.length) return;

  const targets = streams.slice(0, CFG.maxStreams);
  const results = await runPool(targets, CFG.concurrency, (s) => snapshotStream(s, accessToken));

  const points = results.filter((r) => r && r.totalPoint != null);
  const failed = results.filter((r) => !r || r.totalPoint == null);
  log('ポイント取得: ' + points.length + ' 件 / 取得できず: ' + failed.length + ' 件');

  // 失敗理由の内訳を出す（原因調査用）
  if (failed.length > 0) {
    const notes = {};
    for (const r of failed) {
      const n = (r && r.note) || 'unknown';
      notes[n] = (notes[n] || 0) + 1;
    }
    log('失敗内訳: ' + JSON.stringify(notes, null, 0));
  }

  if (points.length) await writeToSheet(points);
  log('完了 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');

  // 1件も取れなかったら run を失敗扱いにする（原因は上の「失敗内訳」を参照）
  if (points.length === 0 && failed.length > 0) {
    throw new Error('全配信でポイントを取得できませんでした。上の「失敗内訳」を確認してください。');
  }
}

/* ----------------------------------------------------------------- withny 認証 */

// WITHNY_SESSION_TOKEN は次のどれで渡してもよい:
//   (a) トークンの値だけ                     → __Secure-next-auth.session-token= に包む
//   (b) name=value 形式の Cookie 断片        → そのまま送る（分割Cookie .0 .1 や複数指定も可）
//   (c) DevTools の Cookie ヘッダ丸ごと       → そのまま送る
function buildCookieHeader(raw) {
  const v = String(raw).trim();
  if (/(^|;|\s)(__Secure-|__Host-)?next-auth\.session-token(\.\d+)?=/.test(v) || v.includes('session-token=')) {
    return v; // すでに Cookie 断片
  }
  return '__Secure-next-auth.session-token=' + v;
}

// WITHNY_SESSION_TOKEN 入力から「トークンの値だけ」を取り出す（分割 .0 .1 は連結）。
function sessionTokenValue(raw) {
  const s = String(raw).trim();
  const m = [...s.matchAll(/session-token(\.\d+)?=([^;]+)/gi)];
  if (m.length === 0) return s; // 値だけが渡された
  if (m.length === 1 && !m[0][1]) return m[0][2].trim();
  return m.filter((p) => p[1])
    .sort((a, b) => Number(a[1].slice(1)) - Number(b[1].slice(1)))
    .map((p) => p[2].trim())
    .join('');
}

// Set-Cookie 配列から新しい session-token の値を取り出す（分割 .0 .1 は連結）。
function rotatedTokenFromSetCookie(setCookies) {
  const found = {};
  let plain = null;
  for (const line of setCookies || []) {
    const m = line.match(/(?:__Secure-|__Host-)?next-auth\.session-token(\.\d+)?=([^;]+)/i);
    if (!m) continue;
    if (m[1]) found[Number(m[1].slice(1))] = m[2];
    else plain = m[2];
  }
  if (plain != null) return plain;
  const idx = Object.keys(found).map(Number).sort((a, b) => a - b);
  if (!idx.length) return null;
  return idx.map((i) => found[i]).join('');
}

async function getWithnyAccessToken() {
  const res = await fetch(REST_SESSION, {
    headers: {
      Cookie: buildCookieHeader(CFG.sessionToken),
      'User-Agent': UA,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('auth/session ' + res.status + ': ' + text.slice(0, 200));

  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('auth/session の JSON 解析に失敗: ' + text.slice(0, 200)); }

  if (!json.accessToken) {
    throw new Error(
      'accessToken が空です。WITHNY_SESSION_TOKEN が失効しています。' +
      'ブラウザから __Secure-next-auth.session-token を取り直して Secret を更新してください。'
    );
  }

  // 認証成功。セッション Cookie がローテーションされていたら新トークンをファイルに書き出す
  // （ワークフローがこれを読んで Secret WITHNY_SESSION_TOKEN を更新する）。
  try {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    const rotated = rotatedTokenFromSetCookie(setCookies);
    if (rotated && rotated !== sessionTokenValue(CFG.sessionToken)) {
      fs.writeFileSync(ROTATED_TOKEN_FILE, rotated, 'utf8');
      log('session-token がローテーションされました → ' + ROTATED_TOKEN_FILE + ' に保存 (' + rotated.length + '文字)');
    }
  } catch (e) {
    log('ローテーション保存の処理でエラー: ' + (e && e.message ? e.message : e));
  }

  return json.accessToken;
}

/* ----------------------------------------------------------------- 配信一覧 */

async function getLiveStreams(accessToken) {
  const res = await fetch(REST_STREAMS, {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'User-Agent': UA,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error('streams/with-rooms ' + res.status + ': ' + (await res.text()).slice(0, 200));

  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('配信一覧が配列ではありません');

  return list
    .filter((s) => s && s.uuid)
    .map((s) => ({
      uuid: String(s.uuid),                                   // data2 の突合キー（streamUuid）
      ivsChannelUuid: (s.ivsChannel && s.ivsChannel.uuid) || null, // socket が要求する UUID
      title: (s.title || '').slice(0, 40),
      name: (s.cast && s.cast.user && s.cast.user.name) || '',
      passCode: s.passCode || 'undefined', // withny 仕様: 未設定は文字列 "undefined"
    }));
}

/* ----------------------------------------------------------------- 1 配信スナップショット */

// withny-dl（実績あり）と同じ生フレーム手順で socket.io に接続する:
//   1. wss://api.withny.fun/socket.io/?uuid=..&token=..&passCode=..&EIO=4&transport=websocket
//   2. サーバから "0{...}"（Engine.IO open）→ クライアントから "40/channels," を送る
//   3. サーバから "40/channels,{...}"（ネームスペース接続OK）
//   4. サーバから "42/channels,[\"leaderBoardUpdate\",{...}]" を待つ
//   ・"2"(ping) が来たら "3"(pong) を返す
function snapshotStream(stream, accessToken) {
  return new Promise((resolve) => {
    if (!stream.ivsChannelUuid) {
      resolve({ uuid: stream.uuid, totalPoint: null, note: 'no-ivsChannel' });
      return;
    }
    const qs = new URLSearchParams({
      uuid: stream.ivsChannelUuid, // サーバが要求するのは ivsChannel の UUID（配信 UUID ではない）
      token: accessToken,
      passCode: stream.passCode || 'undefined',
      EIO: '4',
      transport: 'websocket',
    });
    const url = SOCKET_BASE + '?' + qs.toString();

    let done = false;
    let nsConnected = false;

    const ws = new WebSocket(url, {
      headers: { Origin: ORIGIN, 'User-Agent': UA },
      handshakeTimeout: 15000,
    });

    const finish = (totalPoint, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.removeAllListeners(); ws.terminate(); } catch (e) { /* noop */ }
      resolve({ uuid: stream.uuid, totalPoint, note });
    };

    const timer = setTimeout(
      () => finish(null, nsConnected ? 'timeout(no-leaderBoardUpdate)' : 'timeout(no-namespace)'),
      CFG.perStreamTimeoutMs
    );

    ws.on('message', (raw) => {
      const msg = raw.toString();
      const head = msg[0];

      if (head === '0') {
        ws.send('40/channels,'); // ネームスペース接続要求（withny-dl と同じく本体なし）
      } else if (head === '2') {
        ws.send('3'); // ping -> pong
      } else if (msg.startsWith('40/channels')) {
        nsConnected = true;
      } else if (msg.startsWith('44/channels') || msg.startsWith('41/channels')) {
        finish(null, 'ns-rejected: ' + msg.slice(0, 160));
      } else if (msg.startsWith('42/channels,')) {
        try {
          const arr = JSON.parse(msg.slice('42/channels,'.length));
          if (Array.isArray(arr) && arr[0] === 'leaderBoardUpdate') {
            const lb = arr[1] && arr[1].leaderBoard;
            const tp = lb ? Number(lb.totalPoint) : NaN;
            if (Number.isFinite(tp)) finish(tp, 'ok');
          }
        } catch (e) { /* JSON でないイベントは無視 */ }
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      finish(null, 'http-' + res.statusCode);
    });
    ws.on('error', (err) => {
      finish(null, 'ws-error: ' + ((err && err.message) || String(err)).slice(0, 160));
    });
    ws.on('close', (code, reason) => {
      finish(null, 'closed-' + code + (nsConnected ? '-after-ns' : '') +
        (reason && reason.length ? ' ' + reason.toString().slice(0, 80) : ''));
    });
  });
}

/* ----------------------------------------------------------------- 並列実行 */

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i]); }
      catch (e) { results[i] = { totalPoint: null, note: 'error: ' + (e && e.message) }; }
    }
  }
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane);
  await Promise.all(lanes);
  return results;
}

/* ----------------------------------------------------------------- シート書き込み */

async function writeToSheet(points) {
  let sa;
  try { sa = JSON.parse(CFG.saJson); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON が正しい JSON ではありません（鍵ファイルの中身を丸ごと貼る）'); }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON に client_email / private_key がありません（サービスアカウント鍵 JSON か確認）');
  }

  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authRes = await jwt.authorize();
  const token = authRes.access_token;

  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(CFG.spreadsheetId);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  // A 列（streamUuid）を読み出して uuid -> 行番号
  const range = encodeURIComponent(CFG.sheetName + '!A2:A');
  const getRes = await fetch(base + '/values/' + range, { headers });
  if (!getRes.ok) throw new Error('Sheets get ' + getRes.status + ': ' + (await getRes.text()).slice(0, 300));
  const rows = (await getRes.json()).values || [];
  const rowByUuid = new Map();
  rows.forEach((r, i) => { if (r[0]) rowByUuid.set(String(r[0]), i + 2); });

  const stamp = jstStamp(new Date());
  const data = [];
  let matched = 0;
  let pending = 0;
  for (const p of points) {
    const row = rowByUuid.get(p.uuid);
    if (!row) { pending++; continue; } // GAS がまだ行を作っていない。累計値なので次回でOK
    data.push({ range: CFG.sheetName + '!' + COL.TOTAL_POINTS + row, values: [[p.totalPoint]] });
    data.push({ range: CFG.sheetName + '!' + COL.POINTS_UPDATE + row, values: [[stamp]] });
    matched++;
  }

  if (!data.length) {
    log('書き込み対象なし（GAS 未作成: ' + pending + ' 件）');
    return;
  }

  const upRes = await fetch(base + '/values:batchUpdate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
  if (!upRes.ok) throw new Error('Sheets batchUpdate ' + upRes.status + ': ' + (await upRes.text()).slice(0, 300));
  log('シート更新: ' + matched + ' 行（GAS 未作成でスキップ: ' + pending + ' 件）');
}

/* ----------------------------------------------------------------- 小物 */

function need(k) {
  const v = process.env[k];
  if (!v) { console.error('環境変数 ' + k + ' が未設定です'); process.exit(1); }
  return v;
}
function intEnv(k, def) {
  const v = parseInt(process.env[k], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function jstStamp(d) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(/\//g, '-');
}
function log() {
  console.log('[' + jstStamp(new Date()) + '] ' + Array.prototype.join.call(arguments, ' '));
}

main().catch((e) => {
  console.error('[ERROR] ' + (e && e.message ? e.message : e));
  process.exit(1);
});
