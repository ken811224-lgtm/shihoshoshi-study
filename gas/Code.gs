/* 司法書士スマホ学習：サーバー側（Google Apps Script）
 * 元のシート（Local.js の SOURCE_ID。GitHub には置かない）はコピーするときに読むだけで、書き込まない。
 * 読み書きするのは setup が作ったコピー（COPY_NAME）だけ。
 */
var VER = '1.0.0';
var REQUIRED_Q = ['ID', '問題', '答え', '科目', '大分類', '中分類', '小分類', '正解数', '誤答数', '正答率', 'レベル', '次回実施日', '最終実施日', 'ウォーク問', '要修正', '借金'];
var COPY_NAME = '司法書士スマホ学習_データ';
var Q_SHEET = 'T_mondai', H_SHEET = 'T_history', S_SHEET = '設定', LOG_SHEET = '同期記録';
var EXTRA = ['更新時刻', '削除'];
var LOG_KEEP = 5000;
var TIME_LIMIT_MS = 25000;

/* 最初に 1 回だけ Apps Script の画面から実行する */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var have = props.getProperty('SHEET_ID');
  if (have) { Logger.log('作成済み: ' + SpreadsheetApp.openById(have).getUrl()); return; }

  if (typeof SOURCE_ID === 'undefined' || !SOURCE_ID) throw new Error('元のシートの指定（Local.js の SOURCE_ID）がありません。');
  var src = SpreadsheetApp.openById(SOURCE_ID);
  [[Q_SHEET, REQUIRED_Q], [H_SHEET, ['HistoryID', '問題ID', '実施日時', '結果']], [S_SHEET, ['学習']]].forEach(function (rule) {
    var sh = src.getSheetByName(rule[0]);
    if (!sh) throw new Error(rule[0] + ' のシートがありません。コピーを中止しました。');
    var h = headers_(sh), lack = rule[1].filter(function (n) { return h.indexOf(n) < 0; });
    if (lack.length) throw new Error(rule[0] + ' に列がありません：' + lack.join('、') + '。コピーを中止しました。');
  });

  var copy = DriveApp.getFileById(SOURCE_ID).makeCopy(COPY_NAME);
  var ss = SpreadsheetApp.openById(copy.getId());
  var q = ss.getSheetByName(Q_SHEET);
  var head = headers_(q);
  EXTRA.forEach(function (name) {
    if (head.indexOf(name) < 0) { q.getRange(1, q.getLastColumn() + 1).setValue(name); head.push(name); }
  });
  if (!ss.getSheetByName(LOG_SHEET)) ss.insertSheet(LOG_SHEET).appendRow(['opId', 'ID', '時刻']);
  props.setProperty('SHEET_ID', copy.getId());
  Logger.log('コピーしました: ' + ss.getUrl() + ' / 問題 ' + (q.getLastRow() - 1) + ' 件');
}

function doGet(e) {
  return respond_(function () {
    var p = (e && e.parameter) || {};
    if (p.action === 'ping') return ping_();
    if (p.action === 'rows') return rows_(Number(p.offset) || 0, Math.min(Number(p.limit) || 500, 1000));
    if (p.action === 'changes') return changes_(Number(p.since) || 0);
    if (p.action === 'settings') return { ok: true, settings: readSettings_() };
    throw new Error('不明な操作です');
  });
}

function doPost(e) {
  return respond_(function () {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'push') return push_(body.ops || []);
    throw new Error('不明な操作です');
  });
}

function respond_(fn) {
  var out;
  try { out = fn(); } catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function book_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('setup がまだです');
  return SpreadsheetApp.openById(id);
}
function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}
function colMap_(head) {
  var m = {};
  head.forEach(function (h, i) { m[h] = i; });
  return m;
}
function ms_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v == null) return null;
  var t = new Date(v).getTime(); // 日付が文字で入っている行にも対応
  return isFinite(t) ? t : null;
}
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 'Y'; }

function encode_(r, c) {
  return [
    num_(r[c['ID']]), String(r[c['問題']] == null ? '' : r[c['問題']]), String(r[c['答え']] == null ? '' : r[c['答え']]),
    String(r[c['科目']] || ''), String(r[c['大分類']] || ''), String(r[c['中分類']] || ''), String(r[c['小分類']] || ''),
    num_(r[c['正解数']]), num_(r[c['誤答数']]), num_(r[c['レベル']]),
    ms_(r[c['次回実施日']]), ms_(r[c['最終実施日']]),
    bool_(r[c['ウォーク問']]) ? 1 : 0, bool_(r[c['要修正']]) ? 1 : 0, num_(r[c['借金']]),
    bool_(r[c['削除']]) ? 1 : 0, num_(r[c['更新時刻']])
  ];
}

function lastTs_() { return Number(PropertiesService.getScriptProperties().getProperty('LAST_TS')) || 0; }
function nextTs_() {
  var t = Math.max(Date.now(), lastTs_() + 1);
  PropertiesService.getScriptProperties().setProperty('LAST_TS', String(t));
  return t;
}

function ping_() {
  var q = book_().getSheetByName(Q_SHEET);
  return { ok: true, ver: VER, total: Math.max(0, q.getLastRow() - 1), rev: lastTs_() };
}

function rows_(offset, limit) {
  var q = book_().getSheetByName(Q_SHEET);
  var total = Math.max(0, q.getLastRow() - 1);
  var rev = lastTs_();
  if (offset >= total) return { ok: true, total: total, rev: rev, rows: [] };
  var n = Math.min(limit, total - offset);
  var head = headers_(q), c = colMap_(head);
  var vals = q.getRange(offset + 2, 1, n, head.length).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) if (vals[i][c['ID']] !== '') rows.push(encode_(vals[i], c));
  return { ok: true, total: total, rev: rev, rows: rows, next: offset + n };
}

function changes_(since) {
  var q = book_().getSheetByName(Q_SHEET);
  var total = q.getLastRow() - 1;
  if (total < 1) return { ok: true, rev: since, rows: [], more: false };
  var head = headers_(q), c = colMap_(head);
  var tsCol = q.getRange(2, c['更新時刻'] + 1, total, 1).getValues();
  var hits = [];
  for (var i = 0; i < tsCol.length; i++) {
    var t = Number(tsCol[i][0]) || 0;
    if (t > since) hits.push({ row: i + 2, ts: t });
  }
  hits.sort(function (a, b) { return a.ts - b.ts; });
  var more = hits.length > 300;
  if (more) hits = hits.slice(0, 300);
  var rows = hits.map(function (h) { return encode_(q.getRange(h.row, 1, 1, head.length).getValues()[0], c); });
  return { ok: true, rev: hits.length ? hits[hits.length - 1].ts : since, rows: rows, more: more };
}

function readSettings_() {
  var s = book_().getSheetByName(S_SHEET);
  var head = headers_(s), v = s.getRange(2, 1, 1, head.length).getValues()[0], c = colMap_(head);
  return {
    subject: String(v[c['絞り込み科目']] || ''), large: String(v[c['大分類']] || ''),
    startId: num_(v[c['開始ID']]), walk: bool_(v[c['ウォーク問']]) ? 1 : 0, fix: bool_(v[c['要修正']]) ? 1 : 0,
    study: num_(v[c['学習']])
  };
}

function push_(ops) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var started = Date.now();
    var ss = book_();
    var q = ss.getSheetByName(Q_SHEET), hs = ss.getSheetByName(H_SHEET), log = ss.getSheetByName(LOG_SHEET);
    var head = headers_(q), c = colMap_(head);
    var hHead = headers_(hs);
    var last = q.getLastRow();
    var idVals = last > 1 ? q.getRange(2, c['ID'] + 1, last - 1, 1).getValues() : [];
    var rowOf = {}, maxId = 0;
    for (var i = 0; i < idVals.length; i++) {
      var n = Number(idVals[i][0]);
      if (n) { rowOf[n] = i + 2; if (n > maxId) maxId = n; }
    }
    var done = {};
    var logLast = log.getLastRow();
    if (logLast > 1) {
      var from = Math.max(2, logLast - LOG_KEEP + 1);
      log.getRange(from, 1, logLast - from + 1, 3).getValues().forEach(function (r) { done[r[0]] = { id: Number(r[1]), ts: Number(r[2]) }; });
    }
    var tempMap = {}, results = [];
    var setCell = function (row, name, value) { q.getRange(row, c[name] + 1).setValue(value); };
    var toDate = function (v) { return v == null ? '' : new Date(v); };

    for (var k = 0; k < ops.length; k++) {
      if (Date.now() - started > TIME_LIMIT_MS) break;
      var op = ops[k];
      if (done[op.opId]) {
        if (op.id < 0) tempMap[op.id] = done[op.opId].id;
        results.push({ opId: op.opId, id: done[op.opId].id, ts: done[op.opId].ts, ok: true });
        continue;
      }
      try {
        var id = op.id < 0 && tempMap[op.id] ? tempMap[op.id] : op.id;
        var ts = nextTs_();
        if (op.type === 'settings') {
          writeSettings_(ss, op.data);
          id = 0;
        } else if (op.type === 'save' && id < 0) {
          var newId = ++maxId, arr = head.map(function () { return ''; }), d = op.data;
          arr[c['ID']] = newId; arr[c['問題']] = d.q; arr[c['答え']] = d.a; arr[c['科目']] = d.s;
          arr[c['大分類']] = d.l; arr[c['中分類']] = d.m; arr[c['小分類']] = d.n;
          arr[c['正解数']] = 0; arr[c['誤答数']] = 0; arr[c['レベル']] = 0; arr[c['借金']] = 0;
          arr[c['ウォーク問']] = !!d.walk; arr[c['要修正']] = !!d.fix;
          arr[c['次回実施日']] = new Date(); arr[c['更新時刻']] = ts;
          q.appendRow(arr);
          rowOf[newId] = q.getLastRow();
          tempMap[op.id] = newId;
          id = newId;
        } else {
          var row = rowOf[id];
          if (!row) throw new Error('問題 ' + id + ' が見つかりません');
          var dt = op.data;
          if (op.type === 'save') {
            setCell(row, '問題', dt.q); setCell(row, '答え', dt.a); setCell(row, '科目', dt.s);
            setCell(row, '大分類', dt.l); setCell(row, '中分類', dt.m); setCell(row, '小分類', dt.n);
            setCell(row, 'ウォーク問', !!dt.walk); setCell(row, '要修正', !!dt.fix);
          } else if (op.type === 'grade') {
            setCell(row, '正解数', dt.c); setCell(row, '誤答数', dt.w);
            setCell(row, '正答率', dt.c + dt.w ? dt.c / (dt.c + dt.w) : 0);
            setCell(row, 'レベル', dt.lv); setCell(row, '次回実施日', toDate(dt.next));
            setCell(row, '最終実施日', toDate(dt.last)); setCell(row, '借金', dt.debt);
            var subject = q.getRange(row, c['科目'] + 1).getValue();
            var h = { 'HistoryID': op.opId.slice(0, 16), '問題ID': id, '実施日時': new Date(dt.last), '結果': dt.ok ? '○' : '×', '科目': subject };
            hs.appendRow(hHead.map(function (name) { return h[name] != null ? h[name] : ''; }));
          } else if (op.type === 'flag') {
            setCell(row, 'ウォーク問', !!dt.walk); setCell(row, '要修正', !!dt.fix);
          } else if (op.type === 'delete') {
            setCell(row, '削除', true);
          } else {
            throw new Error('不明な変更です');
          }
          setCell(row, '更新時刻', ts);
        }
        log.appendRow([op.opId, id, ts]);
        done[op.opId] = { id: id, ts: ts };
        results.push({ opId: op.opId, id: id, ts: ts, ok: true });
      } catch (err) {
        results.push({ opId: op.opId, ok: false, error: String(err.message || err) });
        break; // 順番を守るため、失敗したらそこで止める
      }
    }
    return { ok: true, results: results, rev: lastTs_() };
  } finally {
    lock.releaseLock();
  }
}

function writeSettings_(ss, d) {
  var s = ss.getSheetByName(S_SHEET), head = headers_(s), c = colMap_(head);
  var put = function (name, v) { if (c[name] != null) s.getRange(2, c[name] + 1).setValue(v); };
  put('絞り込み科目', d.subject || ''); put('大分類', d.large || ''); put('開始ID', d.startId || 0);
  put('ウォーク問', !!d.walk); put('要修正', !!d.fix); put('学習', d.study || 0);
}
