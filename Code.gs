/**
 * withny 配信ロガー  ―  スプレッドシートにバインドして使う GAS
 * ============================================================
 * 目的:
 *   各曜日 × 各時間帯にどれだけポイントが投げられたか、
 *   どの配信者 / どのタイトルが多くポイントを獲得しているかを
 *   後からピボットで可視化できるように、配信 1 本 = 1 行で記録する。
 *
 * この GAS がやること:
 *   ・10 分ごとのトリガーで https://www.withny.fun/ の「配信中の全枠」を取得
 *     （内部 API: https://www.withny.fun/api/streams/with-rooms）
 *   ・data2 シートに   配信者名 / タイトル / 配信開始時間 / 曜日 / 時 / 視聴者数  を記録
 *   ・同一配信 (streamUuid) は行を増やさず、可変項目だけ更新（＝総ポイント数を更新するに留める）
 *   ・一覧から消えた配信は「終了」ステータスに変更
 *
 *   ・実行の最後に GitHub Actions の points-snapshot を起動する
 *     （repository_dispatch。GH_TOKEN が設定されている場合のみ）
 *
 * この GAS がやらないこと:
 *   ・「総ポイント数」列 (H)・「ポイント最終更新」列 (M)・「開始時ポイント」列 (R) の書き込み。
 *     その数値（配信プレイヤー上部の "◯◯ pt"）は withny の
 *     認証付き socket.io WebSocket でしか配信されておらず、
 *     GAS の UrlFetchApp では取得できない。
 *     → GitHub Actions の points-snapshot.js が H・M・R 列を埋める。
 *     ・withny の持ち越し仕様（前枠終了から6時間以内に次枠が立つと累計が持ち越される）対策として、
 *       R = その配信を最初に観測した時のカウンタ値。実質ポイント = H − R。
 *
 * 初回セットアップ:
 *   1. スプレッドシートを開き直す（メニュー「withny ロガー」が出る）
 *   2. メニュー →「セットアップ（トリガー作成）」を 1 回実行し、権限を承認する
 *   3. GitHub の scheduled(cron) が不発なので、points-snapshot を GAS から起動する:
 *      プロジェクトの設定 → スクリプト プロパティ に GH_TOKEN（Fine-grained PAT,
 *      対象リポジトリのみ・Contents: Read and write）を追加する
 */

const WITHNY = {
  SHEET_NAME: 'data2',
  API_URL: 'https://www.withny.fun/api/streams/with-rooms',
  TZ: 'Asia/Tokyo',
  TRIGGER_MINUTES: 10,
};

// 列番号 (1 始まり)。順序を変えたらここも直す。points-collector.js の COL とそろえること。
const COL = {
  UUID: 1,           // A  streamUuid（キー）
  NAME: 2,           // B  配信者名
  USERNAME: 3,       // C  username
  TITLE: 4,          // D  配信タイトル
  STARTED_AT: 5,     // E  配信開始時間 (JST, yyyy-MM-dd HH:mm:ss)
  WEEKDAY: 6,        // F  開始曜日 (日〜土)
  HOUR: 7,           // G  開始時 (0〜23)
  TOTAL_POINTS: 8,   // H  総ポイント数  ← Node が書き込む。GAS は触らない
  MAX_VIEWERS: 9,    // I  最大視聴者数（観測した最大値。下回ったら更新しない）
  STATUS: 10,        // J  ステータス (配信中 / 終了)
  FIRST_SEEN: 11,    // K  初回記録日時
  LAST_UPDATE: 12,   // L  最終更新日時
  POINTS_UPDATE: 13, // M  ポイント最終更新  ← Node が書き込む
  ABOUT: 14,         // N  配信概要（about を HTML 除去したもの）
  TAGS: 15,          // O  タグ（カンマ区切り）
  FAV_COUNT: 16,     // P  お気に入り登録者数（行作成時点。/api/casts?username= から）
  ENDED_AT: 17,      // Q  配信終了時間（＝一覧から消える直前に最後に配信中と確認した時刻）
  START_POINTS: 18,  // R  開始時ポイント ← Node が最初の観測時に1回だけ書き込む。実質ポイント = H − R
};

const HEADER_ROW = [
  'streamUuid', '配信者名', 'username', '配信タイトル',
  '配信開始時間', '開始曜日', '開始時', '総ポイント数',
  '最大視聴者数', 'ステータス', '初回記録日時', '最終更新日時', 'ポイント最終更新',
  '配信概要', 'タグ', 'お気に入り登録者数', '配信終了時間', '開始時ポイント',
];

// N 列（配信概要）に入れる本文の最大文字数
const ABOUT_MAX_CHARS = 2000;

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// 毎回の実行後に GitHub Actions の points-snapshot を起動する設定。
// GitHub の scheduled(cron) が不発なので、この GAS トリガーから叩く。
// PAT は Script Properties の GH_TOKEN に入れる（未設定なら起動をスキップ）。
const GH = {
  OWNER: 'nyakanyo0324',
  REPO: 'withnyPoints',
  EVENT_TYPE: 'run-snapshot', // withny-points.yml の repository_dispatch types と一致
};

/* ---------------------------------------------------------------- メニュー */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('withny ロガー')
    .addItem('セットアップ（トリガー作成）', 'setupTrigger')
    .addItem('今すぐ 1 回実行', 'collectWithnyStreams')
    .addItem('points-snapshot を起動（テスト）', 'triggerPointsSnapshotNow')
    .addItem('トリガー削除', 'removeTriggers')
    .addToUi();
}

function setupTrigger() {
  removeTriggers_();
  ScriptApp.newTrigger('collectWithnyStreams')
    .timeBased()
    .everyMinutes(WITHNY.TRIGGER_MINUTES)
    .create();
  ensureSheet_();
  SpreadsheetApp.getActive().toast(WITHNY.TRIGGER_MINUTES + ' 分ごとのトリガーを作成しました');
}

function removeTriggers() {
  removeTriggers_();
  SpreadsheetApp.getActive().toast('トリガーを削除しました');
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'collectWithnyStreams'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/* ---------------------------------------------------------------- シート準備 */

function ensureSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(WITHNY.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(WITHNY.SHEET_NAME);
  const first = sh.getRange(1, 1, 1, HEADER_ROW.length).getValues()[0];
  // 未設定、または見出しが1つでも一致しなければ書き直す（列の追加・改名に追従）
  const isOurs = first[0] === 'streamUuid';
  const matches = HEADER_ROW.every(function (h, i) { return first[i] === h; });
  if (first.join('') === '' || (isOurs && !matches)) {
    sh.getRange(1, 1, 1, HEADER_ROW.length).setValues([HEADER_ROW]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ---------------------------------------------------------------- 本体 */

function collectWithnyStreams() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.warn('ロックを取得できなかったのでスキップ');
    return;
  }
  try {
    const sh = ensureSheet_();

    const res = UrlFetchApp.fetch(WITHNY.API_URL, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; withny-logger/1.0)',
      },
    });

    const code = res.getResponseCode();
    if (code !== 200) {
      console.error('API エラー ' + code + ': ' + res.getContentText().slice(0, 300));
      return;
    }

    let streams;
    try {
      streams = JSON.parse(res.getContentText());
    } catch (e) {
      console.error('JSON パース失敗: ' + e);
      return;
    }
    if (!Array.isArray(streams)) {
      console.error('配列でない応答: ' + res.getContentText().slice(0, 200));
      return;
    }

    const now = new Date();
    const nowStr = fmt_(now);

    // 既存行を uuid -> 行番号 で索引
    const lastRow = sh.getLastRow();
    const width = HEADER_ROW.length;
    const values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, width).getValues() : [];
    const rowByUuid = {};
    values.forEach(function (r, i) {
      const u = r[COL.UUID - 1];
      if (u) rowByUuid[String(u)] = i + 2;
    });

    const liveUuids = {};
    const toAppend = [];
    const favCache = {}; // username -> お気に入り登録者数（同一実行内で使い回す）

    streams.forEach(function (s) {
      if (!s || !s.uuid) return;
      const uuid = String(s.uuid);
      liveUuids[uuid] = true;

      const user = (s.cast && s.cast.user) || {};
      const name = user.name || '';
      const username = user.username || '';
      const title = s.title || '';
      const about = htmlToText_(s.about);
      const tags = tagsToText_(s.tags);
      const started = s.startedAt ? new Date(s.startedAt) : null;
      const viewers = (typeof s.viewerCount === 'number') ? s.viewerCount : '';

      const row = rowByUuid[uuid];
      if (row) {
        // 既存配信: ポイント列 (H) には触れず、可変項目だけ更新
        // 最大視聴者数は「今回の方が多いときだけ」上書き（下回ったら記録しない）
        if (typeof viewers === 'number') {
          const prevMax = Number(values[row - 2][COL.MAX_VIEWERS - 1]) || 0;
          if (viewers > prevMax) sh.getRange(row, COL.MAX_VIEWERS).setValue(viewers);
        }
        sh.getRange(row, COL.STATUS).setValue('配信中');
        sh.getRange(row, COL.LAST_UPDATE).setValue(nowStr);
      } else {
        const v = new Array(width).fill('');
        v[COL.UUID - 1] = uuid;
        v[COL.NAME - 1] = name;
        v[COL.USERNAME - 1] = username;
        v[COL.TITLE - 1] = title;
        v[COL.STARTED_AT - 1] = started ? fmt_(started) : '';
        v[COL.WEEKDAY - 1] = started ? weekdayJa_(started) : '';
        v[COL.HOUR - 1] = started ? Number(Utilities.formatDate(started, WITHNY.TZ, 'H')) : '';
        v[COL.MAX_VIEWERS - 1] = viewers;
        v[COL.STATUS - 1] = '配信中';
        v[COL.FIRST_SEEN - 1] = nowStr;
        v[COL.LAST_UPDATE - 1] = nowStr;
        v[COL.ABOUT - 1] = about;
        v[COL.TAGS - 1] = tags;
        v[COL.FAV_COUNT - 1] = username ? favoriteCount_(username, favCache) : '';
        toAppend.push(v);
      }
    });

    // 実データの最終行を A 列（streamUuid）から求める。
    // S:AN の ARRAYFORMULA が真の空白を返す前提だが、万一 getLastRow が
    // 伸びても、その下に append しないようにするための保険。
    let dataLast = 1;
    for (let i = values.length - 1; i >= 0; i--) {
      if (String(values[i][COL.UUID - 1] || '').trim() !== '') { dataLast = i + 2; break; }
    }

    if (toAppend.length) {
      sh.getRange(dataLast + 1, 1, toAppend.length, width).setValues(toAppend);
      dataLast += toAppend.length;
    }

    // 一覧から消えた「配信中」行を「終了」に
    values.forEach(function (r, i) {
      const uuid = String(r[COL.UUID - 1] || '');
      if (!uuid) return;
      if (!liveUuids[uuid] && r[COL.STATUS - 1] !== '終了') {
        const row = i + 2;
        sh.getRange(row, COL.STATUS).setValue('終了');
        // 配信終了時間 = 前回までに最後に「配信中」と確認できた時刻（＝この実行前の L 値）
        sh.getRange(row, COL.ENDED_AT).setValue(r[COL.LAST_UPDATE - 1] || nowStr);
        sh.getRange(row, COL.LAST_UPDATE).setValue(nowStr);
      }
    });

    console.log('配信中=' + streams.length + ' / 新規行=' + toAppend.length + ' / データ最終行=' + dataLast);
  } finally {
    lock.releaseLock();
  }

  // 行の更新が終わったら points-snapshot（H/M列）を起動
  triggerPointsSnapshot_();
}

/* ---------------------------------------------------------------- points-snapshot 起動 */

// GitHub Actions の points-snapshot を repository_dispatch で起動する。
// 失敗しても collectWithnyStreams 本体は成功扱いのまま（警告ログのみ）。
function triggerPointsSnapshot_() {
  const token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
  if (!token) {
    console.warn('GH_TOKEN 未設定のため points-snapshot を起動しませんでした '
      + '（プロジェクトの設定 → スクリプト プロパティ で GH_TOKEN を追加）');
    return;
  }
  try {
    const res = UrlFetchApp.fetch(
      'https://api.github.com/repos/' + GH.OWNER + '/' + GH.REPO + '/dispatches',
      {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        payload: JSON.stringify({ event_type: GH.EVENT_TYPE }),
      }
    );
    const code = res.getResponseCode();
    if (code === 204) {
      console.log('points-snapshot 起動リクエスト OK (204)');
    } else {
      console.warn('points-snapshot 起動リクエスト応答 ' + code + ': ' + res.getContentText().slice(0, 300));
    }
  } catch (e) {
    console.warn('points-snapshot 起動に失敗: ' + e);
  }
}

// メニュー「points-snapshot を起動（テスト）」用
function triggerPointsSnapshotNow() {
  triggerPointsSnapshot_();
  SpreadsheetApp.getActive().toast('points-snapshot に起動リクエストを送信しました（GitHub の Actions タブで確認）');
}

/* ---------------------------------------------------------------- ユーティリティ */

function fmt_(d) {
  return Utilities.formatDate(d, WITHNY.TZ, 'yyyy-MM-dd HH:mm:ss');
}

// JST における曜日。SimpleDateFormat の 'u' に依存せず確実に求める。
function weekdayJa_(d) {
  const p = Utilities.formatDate(d, WITHNY.TZ, 'yyyy/MM/dd').split('/');
  const dow = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay(); // 0=日
  return WEEKDAY_JA[dow];
}

// 配信概要 (about) は HTML。タグを除去して読めるテキストにする。
function htmlToText_(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/(p|div|h[1-6]|li|tr)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');            // 残りのタグを除去
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#0*39;/g, "'")
       .replace(/&#x0*27;/gi, "'")
       .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
  s = s.replace(/\r/g, '')
       .replace(/[ \t]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .replace(/^\s+|\s+$/g, '');
  if (s.length > ABOUT_MAX_CHARS) s = s.slice(0, ABOUT_MAX_CHARS) + '…';
  return s;
}

// お気に入り登録者数。/api/casts?username= から casts[0].countFavorites を取る。
// 失敗しても行作成は止めない（'' を返す）。cache は username -> 値。
function favoriteCount_(username, cache) {
  if (cache && Object.prototype.hasOwnProperty.call(cache, username)) return cache[username];
  let out = '';
  try {
    const res = UrlFetchApp.fetch(
      'https://www.withny.fun/api/casts?username=' + encodeURIComponent(username),
      {
        method: 'get',
        muteHttpExceptions: true,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; withny-logger/1.0)' },
      }
    );
    if (res.getResponseCode() === 200) {
      const j = JSON.parse(res.getContentText());
      const c = j && j.casts && j.casts[0];
      if (c && typeof c.countFavorites === 'number') out = c.countFavorites;
    }
  } catch (e) {
    console.warn('favoriteCount_ 失敗 (' + username + '): ' + e);
  }
  if (cache) cache[username] = out;
  return out;
}

// tags は [{id, name}, ...]。name をカンマ区切りにする。
function tagsToText_(tags) {
  if (!Array.isArray(tags)) return '';
  return tags
    .map(function (t) { return (t && t.name != null) ? String(t.name) : ''; })
    .filter(function (x) { return x !== ''; })
    .join(', ');
}
