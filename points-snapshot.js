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
const { io } = require('socket.io-client');
const { JWT } = require('google-auth-library');

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
const SOCKET_URL = 'wss://api.withny.fun/channels'; // host: api.withny.fun / namespace: /channels
const SOCKET_PATH = '/socket.io/';
const ORIGIN = 'https://www.withny.fun';
const UA = 'Mozilla/5.0 (compatible; withny-points-snapshot/1.0)';
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

  // 全滅かつ理由が connect_error 中心なら、トークン失効の可能性が高い
  if (points.length === 0 && failed.length > 0) {
    const ce = failed.filter((r) => r && String(r.note || '').startsWith('connect_error')).length;
    if (ce >= failed.length * 0.8) {
      throw new Error('全配信で接続に失敗しました。WITHNY_SESSION_TOKEN の失効、または withny 側の仕様変更を疑ってください。');
    }
  }

  if (points.length) await writeToSheet(points);
  log('完了 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
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
      uuid: String(s.uuid),
      title: (s.title || '').slice(0, 40),
      name: (s.cast && s.cast.user && s.cast.user.name) || '',
      passCode: s.passCode || 'undefined', // withny 仕様: 未設定は文字列 "undefined"
    }));
}

/* ----------------------------------------------------------------- 1 配信スナップショット */

function snapshotStream(stream, accessToken) {
  return new Promise((resolve) => {
    let done = false;
    const query = { uuid: stream.uuid, token: accessToken, passCode: stream.passCode };

    const socket = io(SOCKET_URL, {
      path: SOCKET_PATH,
      transports: ['websocket'], // polling は withny 側で無効
      query: query,
      auth: query,
      extraHeaders: { Origin: ORIGIN },
      reconnection: false,
      timeout: Math.min(CFG.perStreamTimeoutMs, 15000),
    });

    const finish = (totalPoint, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.removeAllListeners(); socket.close(); } catch (e) { /* noop */ }
      resolve({ uuid: stream.uuid, totalPoint, note });
    };

    const timer = setTimeout(() => finish(null, 'timeout'), CFG.perStreamTimeoutMs);

    // 接続直後にサーバーが現在の累計を送ってくる想定。最初の 1 通を採用する。
    socket.on('leaderBoardUpdate', (payload) => {
      const lb = payload && payload.leaderBoard;
      const tp = lb ? Number(lb.totalPoint) : NaN;
      if (Number.isFinite(tp)) finish(tp, 'ok');
    });

    socket.on('connect_error', (err) => {
      finish(null, 'connect_error: ' + ((err && err.message) || String(err)).slice(0, 120));
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
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON が正しい JSON ではありません'); }

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
