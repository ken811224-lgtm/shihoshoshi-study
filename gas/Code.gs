/* 司法書士スマホ学習：サーバー側（Google Apps Script）
 * 元のシート（Local.js の SOURCE_ID。GitHub には置かない）はコピーするときに読むだけで、書き込まない。
 * 読み書きするのは setup が作ったコピー（COPY_NAME）だけ。
 *
 * 複数端末の同期：○×は「いつ・どちらだったか」を問題ごとに積み、時刻順に計算し直す。
 * どの端末から、どの順番で届いても同じ結果になる。
 */
var VER = '1.1.1';
var REQUIRED_Q = ['ID', '問題', '答え', '科目', '大分類', '中分類', '小分類', '正解数', '誤答数', '正答率', 'レベル', '次回実施日', '最終実施日', 'ウォーク問', '要修正', '借金'];
var COPY_NAME = '司法書士スマホ学習_データ';
var Q_SHEET = 'T_mondai', H_SHEET = 'T_history', S_SHEET = '設定', LOG_SHEET = '同期記録', DEVICE_SHEET = '端末';
var EXTRA = ['更新時刻', '削除', '本文時刻', '本文端末', '同期履歴'];
var LOG_KEEP = 5000;
var TIME_LIMIT_MS = 25000;
var FUTURE_LIMIT_MS = 5 * 60000;

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
  ensureColumns_(q);
  if (!ss.getSheetByName(LOG_SHEET)) ss.insertSheet(LOG_SHEET).appendRow(['opId', 'ID', '時刻']);
  props.setProperty('SHEET_ID', copy.getId());
  Logger.log('コピーしました: ' + ss.getUrl() + ' / 問題 ' + (q.getLastRow() - 1) + ' 件');
}

function doGet(e) {
  return respond_(function () {
    var p = (e && e.parameter) || {};
    if (p.action === 'ping') return ping_();
    if (p.action === 'rows') return rows_(Number(p.offset) || 0, Math.min(Number(p.limit) || 500, 1000));
    if (p.action === 'changes') return changes_(Number(p.since) || 0, p.device || '');
    if (p.action === 'settings') return { ok: true, settings: readSettings_(p.device || '') };
    throw new Error('不明な操作です');
  });
}

function doPost(e) {
  return respond_(function () {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'push') return push_(body.ops || [], body.device || '');
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
function ensureColumns_(q) {
  var head = headers_(q);
  EXTRA.forEach(function (name) {
    if (head.indexOf(name) >= 0) return;
    var last = q.getLastColumn();
    if (last >= q.getMaxColumns()) q.insertColumnAfter(last);
    q.getRange(1, last + 1).setValue(name);
    head.push(name);
  });
  return head;
}
function ms_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v == null) return null;
  var t = new Date(v).getTime(); // 日付が文字で入っている行にも対応
  return isFinite(t) ? t : null;
}
function num_(v) {
  // 数値の列に日付の書式が付いていると Date で届くので、元の数値（日数）に戻す
  if (v instanceof Date) return isFinite(v.getTime()) ? Math.round((v.getTime() - new Date(1899, 11, 30).getTime()) / 86400000) : 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
/* 数値・記録の列の書式を一度だけそろえる（元のシートに日付の書式が混ざっているため） */
function ensureFormats_(q, head, log) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FORMAT_V2')) return;
  var c = colMap_(head), rows = q.getMaxRows() - 1;
  ['更新時刻', '本文時刻', '正解数', '誤答数', 'レベル', '借金'].forEach(function (n) {
    q.getRange(2, c[n] + 1, rows, 1).setNumberFormat('0');
  });
  ['本文端末', '同期履歴'].forEach(function (n) { q.getRange(2, c[n] + 1, rows, 1).setNumberFormat('@'); });
  var logRows = log.getMaxRows() - 1;
  log.getRange(2, 1, logRows, 1).setNumberFormat('@');
  log.getRange(2, 2, logRows, 2).setNumberFormat('0');
  props.setProperty('FORMAT_V2', '1');
}
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 'Y'; }
function str_(v) { return String(v == null ? '' : v); }

function encode_(r, c) {
  return [
    num_(r[c['ID']]), str_(r[c['問題']]), str_(r[c['答え']]),
    str_(r[c['科目']]), str_(r[c['大分類']]), str_(r[c['中分類']]), str_(r[c['小分類']]),
    num_(r[c['正解数']]), num_(r[c['誤答数']]), num_(r[c['レベル']]),
    ms_(r[c['次回実施日']]), ms_(r[c['最終実施日']]),
    bool_(r[c['ウォーク問']]) ? 1 : 0, bool_(r[c['要修正']]) ? 1 : 0, num_(r[c['借金']]),
    bool_(r[c['削除']]) ? 1 : 0, num_(r[c['更新時刻']]), num_(r[c['本文時刻']])
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

function changes_(since, device) {
  var ss = book_(), q = ss.getSheetByName(Q_SHEET);
  var rest = studyRest_(ss, device);
  var total = q.getLastRow() - 1;
  if (total < 1) return { ok: true, rev: since, rows: [], more: false, rest: rest };
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
  return { ok: true, rev: hits.length ? hits[hits.length - 1].ts : since, rows: rows, more: more, rest: rest };
}

/* 学習回数 ＝ 元の回数 ＋ 各端末の回数。rest は「この端末以外」の合計 */
function studyRest_(ss, device) {
  var s = ss.getSheetByName(S_SHEET), head = headers_(s), c = colMap_(head);
  var sum = num_(s.getRange(2, c['学習'] + 1).getValue());
  var d = ss.getSheetByName(DEVICE_SHEET);
  if (d && d.getLastRow() > 1) {
    d.getRange(2, 1, d.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (String(r[0]) !== device) sum += num_(r[1]);
    });
  }
  return sum;
}

function readSettings_(device) {
  var ss = book_(), s = ss.getSheetByName(S_SHEET);
  var head = headers_(s), v = s.getRange(2, 1, 1, head.length).getValues()[0], c = colMap_(head);
  return {
    subject: str_(v[c['絞り込み科目']]), large: str_(v[c['大分類']]),
    startId: num_(v[c['開始ID']]), walk: bool_(v[c['ウォーク問']]) ? 1 : 0, fix: bool_(v[c['要修正']]) ? 1 : 0,
    rest: studyRest_(ss, device)
  };
}

function writeCount_(ss, device, own) {
  if (!device) return;
  var d = ss.getSheetByName(DEVICE_SHEET);
  if (!d) { d = ss.insertSheet(DEVICE_SHEET); d.appendRow(['端末', '学習', '更新時刻']); }
  var last = d.getLastRow();
  if (last > 1) {
    var ids = d.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === device) {
        d.getRange(i + 2, 2).setValue(Math.max(num_(ids[i][1]), num_(own)));
        d.getRange(i + 2, 3).setValue(new Date());
        return;
      }
    }
  }
  d.appendRow([device, num_(own), new Date()]);
}

/* 元の状態に、○×を時刻順に当てはめて今の状態を出す（AppSheet と同じ式） */
function replay_(base, events) {
  var st = { c: base.c, w: base.w, lv: base.lv, debt: base.debt, next: base.next, last: base.last };
  events.forEach(function (e) {
    var at = e[0], ok = e[1] === 1;
    if (ok) {
      var d = new Date(at);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + Math.pow(2, st.lv + 1));
      st.next = d.getTime();
      st.lv += 1; st.c += 1; st.debt = Math.max(0, st.debt - 1);
    } else {
      st.next = at + 30 * 60000;
      st.lv = Math.max(0, st.lv - 1); st.w += 1; st.debt += 1;
    }
    st.last = at;
  });
  return st;
}

function applyGrade_(q, hs, hHead, c, row, id, op) {
  var v = q.getRange(row, 1, 1, q.getLastColumn()).getValues()[0];
  var saved = null;
  if (v[c['同期履歴']]) { try { saved = JSON.parse(v[c['同期履歴']]); } catch (e) { saved = null; } }
  if (!saved) {
    saved = { b: { c: num_(v[c['正解数']]), w: num_(v[c['誤答数']]), lv: num_(v[c['レベル']]), debt: num_(v[c['借金']]),
      next: ms_(v[c['次回実施日']]), last: ms_(v[c['最終実施日']]) }, e: [] };
  }
  if (saved.e.some(function (x) { return x[2] === op.opId; })) return;

  var dt = op.data, now = Date.now();
  var at = Number(dt.at || dt.last) || now;
  if (at > now + FUTURE_LIMIT_MS) at = now; // 端末の時計が進みすぎているとき
  saved.e.push([at, dt.ok ? 1 : 0, op.opId]);
  saved.e.sort(function (a, b) { return a[0] - b[0] || String(a[2]).localeCompare(String(b[2])); });

  var st = replay_(saved.b, saved.e);
  var put = function (name, value) { q.getRange(row, c[name] + 1).setValue(value); };
  put('正解数', st.c); put('誤答数', st.w);
  put('正答率', st.c + st.w ? st.c / (st.c + st.w) : 0);
  put('レベル', st.lv); put('次回実施日', st.next == null ? '' : new Date(st.next));
  put('最終実施日', st.last == null ? '' : new Date(st.last)); put('借金', st.debt);
  put('同期履歴', JSON.stringify(saved));

  var h = { 'HistoryID': op.opId.slice(0, 16), '問題ID': id, '実施日時': new Date(at), '結果': dt.ok ? '○' : '×', '科目': v[c['科目']] };
  hs.appendRow(hHead.map(function (name) { return h[name] != null ? h[name] : ''; }));
}

function push_(ops, device) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, busy: true, error: '混み合っています' };
  try {
    var started = Date.now();
    var ss = book_();
    var q = ss.getSheetByName(Q_SHEET), hs = ss.getSheetByName(H_SHEET), log = ss.getSheetByName(LOG_SHEET);
    var head = ensureColumns_(q), c = colMap_(head);
    ensureFormats_(q, head, log);
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
        var dt = op.data || {};
        if (op.type === 'settings') {
          id = 0; // 1.0 の版が残した送信待ち。絞り込みは端末ごとになったので何もしない
        } else if (op.type === 'count') {
          writeCount_(ss, device, dt.own);
          id = 0;
        } else if (op.type === 'save' && id < 0) {
          var ts0 = nextTs_();
          var newId = ++maxId, arr = head.map(function () { return ''; });
          arr[c['ID']] = newId; arr[c['問題']] = dt.q; arr[c['答え']] = dt.a; arr[c['科目']] = dt.s;
          arr[c['大分類']] = dt.l; arr[c['中分類']] = dt.m; arr[c['小分類']] = dt.n;
          arr[c['正解数']] = 0; arr[c['誤答数']] = 0; arr[c['レベル']] = 0; arr[c['借金']] = 0;
          arr[c['ウォーク問']] = !!dt.walk; arr[c['要修正']] = !!dt.fix;
          arr[c['次回実施日']] = new Date(); arr[c['更新時刻']] = ts0;
          arr[c['本文時刻']] = ts0; arr[c['本文端末']] = device;
          q.appendRow(arr);
          rowOf[newId] = q.getLastRow();
          tempMap[op.id] = newId;
          id = newId;
          log.appendRow([op.opId, id, ts0]);
          done[op.opId] = { id: id, ts: ts0 };
          results.push({ opId: op.opId, id: id, ts: ts0, ok: true });
          continue;
        } else {
          var row = rowOf[id];
          if (!row) { // 行が無い変更で送信待ちを止めない
            log.appendRow([op.opId, id, lastTs_()]);
            results.push({ opId: op.opId, id: id, ts: lastTs_(), ok: true, skipped: true });
            continue;
          }
          if (op.type === 'save') {
            var cur = q.getRange(row, 1, 1, head.length).getValues()[0];
            var curTs = num_(cur[c['本文時刻']]), isDel = bool_(cur[c['削除']]);
            var differs = str_(cur[c['問題']]) !== str_(dt.q) || str_(cur[c['答え']]) !== str_(dt.a);
            var otherEdit = dt.baseTs != null && curTs > dt.baseTs && str_(cur[c['本文端末']]) !== device && differs;
            if ((isDel && !dt.restore) || otherEdit) {
              // 上書きせず、両方を端末へ返して選んでもらう（記録には残さないので送り直しても同じ答え）
              results.push({ opId: op.opId, id: id, ok: true, conflict: true, ts: curTs, deleted: isDel,
                theirs: isDel ? null : { q: str_(cur[c['問題']]), a: str_(cur[c['答え']]), s: str_(cur[c['科目']]), l: str_(cur[c['大分類']]), m: str_(cur[c['中分類']]), n: str_(cur[c['小分類']]) },
                row: encode_(cur, c) });
              continue;
            }
            setCell(row, '問題', dt.q); setCell(row, '答え', dt.a); setCell(row, '科目', dt.s);
            setCell(row, '大分類', dt.l); setCell(row, '中分類', dt.m); setCell(row, '小分類', dt.n);
            setCell(row, 'ウォーク問', !!dt.walk); setCell(row, '要修正', !!dt.fix);
            if (isDel) setCell(row, '削除', false);
          } else if (op.type === 'grade') {
            applyGrade_(q, hs, hHead, c, row, id, op);
          } else if (op.type === 'flag') {
            if ('walk' in dt) setCell(row, 'ウォーク問', !!dt.walk);
            if ('fix' in dt) setCell(row, '要修正', !!dt.fix);
          } else if (op.type === 'delete') {
            setCell(row, '削除', true);
          } else {
            throw new Error('不明な変更です');
          }
          var ts = nextTs_();
          if (op.type === 'save') { setCell(row, '本文時刻', ts); setCell(row, '本文端末', device); }
          setCell(row, '更新時刻', ts);
          log.appendRow([op.opId, id, ts]);
          done[op.opId] = { id: id, ts: ts };
          results.push({ opId: op.opId, id: id, ts: ts, ok: true });
          continue;
        }
        var ts1 = lastTs_();
        log.appendRow([op.opId, id, ts1]);
        done[op.opId] = { id: id, ts: ts1 };
        results.push({ opId: op.opId, id: id, ts: ts1, ok: true });
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
