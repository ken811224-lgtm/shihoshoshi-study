/* 司法書士スマホ学習：画面と出題・同期 */
(function () {
  'use strict';
  var APP_VERSION = '1.1.0';
  var GAS_PAT = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  var URL_KEY = 'sms.url', FS_KEY = 'sms.fs', RESUME_KEY = 'sms.resume';
  var PAGE = 500, LIST_STEP = 50;

  var db, metas = [], byId = new Map();
  var settings = { subject: '', large: '', startId: 0, walk: 0, fix: 0 }; // 絞り込みは端末ごと
  var study = { own: 0, rest: 0 }, conflicts = [], deviceId = ''; // 学習回数 ＝ この端末 ＋ ほかの合計
  var S = { tab: 'home', view: 'home', mode: null, curId: null, revealed: false, trail: [], editId: null, editFrom: null,
    syncing: false, pending: 0, wantReload: false, list: { q: '', s: '', l: '', flag: '', shown: LIST_STEP, ids: [] } };

  var $ = function (id) { return document.getElementById(id); };
  var main = $('main');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, ms) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, ms || 2200); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function gasUrl() { try { return localStorage.getItem(URL_KEY) || ''; } catch (e) { return ''; } }

  /* ---------- 端末の保存場所 ---------- */
  function openDb() {
    return new Promise(function (ok, ng) {
      var r = indexedDB.open('shihoshoshi-study', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('meta', { keyPath: 'id' });
        d.createObjectStore('text', { keyPath: 'id' });
        d.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
        d.createObjectStore('kv');
      };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ng(r.error); };
    });
  }
  function req(store, mode, fn) {
    return new Promise(function (ok, ng) {
      var tx = db.transaction(store, mode), out;
      var r = fn(tx.objectStore(store));
      if (r) r.onsuccess = function () { out = r.result; };
      tx.oncomplete = function () { ok(out); };
      tx.onerror = function () { ng(tx.error); };
      tx.onabort = function () { ng(tx.error); };
    });
  }
  var kvGet = function (k) { return req('kv', 'readonly', function (s) { return s.get(k); }); };
  var kvSet = function (k, v) { return req('kv', 'readwrite', function (s) { return s.put(v, k); }); };
  var getText = function (id) { return req('text', 'readonly', function (s) { return s.get(id); }); };

  function putRows(rows) {
    return new Promise(function (ok, ng) {
      var tx = db.transaction(['meta', 'text'], 'readwrite'), m = tx.objectStore('meta'), t = tx.objectStore('text');
      rows.forEach(function (r) {
        if (r[15]) { m.delete(r[0]); t.delete(r[0]); return; }
        m.put(toMeta(r)); t.put({ id: r[0], q: r[1], a: r[2] });
      });
      tx.oncomplete = ok;
      tx.onerror = function () { ng(tx.error); };
      tx.onabort = function () { ng(tx.error); };
    });
  }
  function toMeta(r) {
    return { id: r[0], s: r[3], l: r[4], m: r[5], n: r[6], c: r[7], w: r[8], lv: r[9], next: r[10], last: r[11], walk: r[12], fix: r[13], debt: r[14], tt: r[17] || 0 };
  }
  function applyRowsToMemory(rows) {
    rows.forEach(function (r) {
      var old = byId.get(r[0]);
      if (r[15]) {
        if (old) { metas.splice(metas.indexOf(old), 1); byId.delete(r[0]); }
        return;
      }
      var nm = toMeta(r);
      if (old) Object.assign(old, nm); else { metas.push(nm); byId.set(nm.id, nm); }
    });
    metas.sort(function (a, b) { return a.id - b.id; });
  }
  async function saveMeta(m) { await req('meta', 'readwrite', function (s) { return s.put(m); }); }
  async function addOp(type, id, data) {
    await req('ops', 'readwrite', function (s) { return s.add({ opId: uid(), type: type, id: id, data: data }); });
    S.pending++; paintSync(); scheduleSync();
  }

  /* ---------- 出題（AppSheet の 次_anki と同じ順） ---------- */
  function answered(m) { return (m.c || 0) + (m.w || 0); }
  function rate(m) { var n = answered(m); return n ? m.c / n : 0; }
  function nullLast(v) { return v == null ? Infinity : v; }
  function cmpDue(a, b) { return nullLast(a.next) - nullLast(b.next) || b.w - a.w || rate(a) - rate(b) || a.id - b.id; }
  function cmpDebt(a, b) { return nullLast(a.next) - nullLast(b.next) || b.debt - a.debt || b.w - a.w || rate(a) - rate(b) || a.id - b.id; }
  function poolFor(mode) {
    var st = settings;
    return metas.filter(function (m) {
      if (st.walk && !m.walk) return false;
      if (mode === 'id') return m.id >= (st.startId || 0);
      if (mode === 'subject') {
        if (st.subject && m.s !== st.subject) return false;
        if (st.large && m.l !== st.large) return false;
        if (st.fix && !m.fix) return false;
      }
      return true;
    });
  }
  function best(list, cmp) { var b = null; for (var i = 0; i < list.length; i++) if (!b || cmp(list[i], b) < 0) b = list[i]; return b; }
  function pickNext(mode, curId) {
    var pool = poolFor(mode);
    if (mode === 'id') {
      var after = pool.filter(function (m) { return curId == null || m.id > curId; });
      return after.length ? after[0].id : null;
    }
    var others = pool.filter(function (m) { return m.id !== curId; });
    var k = (study.own + study.rest) % 5, hit;
    if (k <= 2) {
      hit = best(others.filter(function (m) { return answered(m) === 0; }), function (a, b) { return a.id - b.id; });
      if (hit) return hit.id;
    } else if (k === 4) {
      hit = best(others.filter(function (m) { return m.debt > 0; }), cmpDebt);
      if (hit) return hit.id;
    }
    hit = best(others.filter(function (m) { return m.next != null && answered(m) > 0; }), cmpDue);
    return hit ? hit.id : null;
  }
  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }

  async function grade(ok) {
    var m = byId.get(S.curId);
    if (!m) { toast('この問題は別の端末で消されました'); nextQuestion(); return; }
    var now = Date.now();
    if (ok) {
      m.next = addDays(startOfToday(), Math.pow(2, (m.lv || 0) + 1));
      m.lv = (m.lv || 0) + 1; m.c = (m.c || 0) + 1; m.debt = Math.max(0, (m.debt || 0) - 1);
    } else {
      m.next = now + 30 * 60000;
      m.lv = Math.max(0, (m.lv || 0) - 1); m.w = (m.w || 0) + 1; m.debt = (m.debt || 0) + 1;
    }
    m.last = now;
    study.own++;
    await saveMeta(m);
    await kvSet('study', study);
    await kvSet('countDirty', true);
    await addOp('grade', m.id, { ok: ok, at: now }); // 送るのは結果と時刻だけ。数値はサーバーが時刻順に計算する
    nextQuestion();
  }
  function nextQuestion() {
    var id = pickNext(S.mode, S.curId);
    if (id == null) { toast('出せる問題がありません'); go('home'); return; }
    if (S.curId != null) S.trail.push(S.curId);
    if (S.trail.length > 50) S.trail.shift();
    showQuestion(id);
  }

  /* ---------- 画面 ---------- */
  var TITLES = { home: 'ホーム', list: '問題', add: '問題を追加', settings: '設定', study: '学習', edit: '問題を修正', conflict: '修正がぶつかった問題' };
  function go(view) {
    var sub = view === 'study' || view === 'edit' || view === 'conflict';
    S.view = view;
    if (!sub) S.tab = view;
    $('title').textContent = TITLES[view] || '';
    $('backBtn').hidden = !sub;
    $('tabs').hidden = sub;
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    main.scrollTop = 0;
    if (view === 'home') renderHome();
    else if (view === 'list') renderList();
    else if (view === 'add') renderEdit(null);
    else if (view === 'settings') renderSettings();
    else if (view === 'conflict') renderConflict();
    if (S.wantReload && view !== 'edit' && view !== 'add') doReload();
  }
  function uniq(key, filter) {
    var set = new Set();
    metas.forEach(function (m) { if (m[key] && (!filter || filter(m))) set.add(m[key]); });
    return Array.from(set).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  }
  function options(list, cur, blank) {
    return '<option value="">' + esc(blank) + '</option>' + list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }

  function renderHome() {
    if (!gasUrl() && !metas.length) {
      main.innerHTML = '<div class="card"><h2>はじめに</h2><p class="muted">設定でデータの接続先を入れると、問題を読み込みます。</p><button class="btn primary" data-act="goSettings">設定を開く</button></div>';
      return;
    }
    var today = startOfToday(), todayN = 0, total = 0, due = 0, fresh = 0, now = Date.now();
    metas.forEach(function (m) {
      var a = answered(m); total += a;
      if (m.last != null && m.last >= today && a) todayN++;
      if (!a) fresh++; else if (m.next != null && m.next <= now) due++;
    });
    var st = settings;
    main.innerHTML =
      (conflicts.length ? '<div class="card"><h2>修正がぶつかった問題 ' + conflicts.length + ' 件</h2><p class="muted">別の端末でも同じ問題が直されています。どちらを残すか選んでください。</p><button class="btn primary" data-act="openConflict">確認する</button></div>' : '') +
      '<div class="card"><div class="stats">' +
      '<div class="stat"><b>' + todayN.toLocaleString() + '</b><span>今日の回答</span></div>' +
      '<div class="stat"><b>' + due.toLocaleString() + '</b><span>復習の時期</span></div>' +
      '<div class="stat"><b>' + fresh.toLocaleString() + '</b><span>未学習</span></div>' +
      '</div><p class="muted" style="margin:10px 0 0">総回答 ' + total.toLocaleString() + ' ／ 問題 ' + metas.length.toLocaleString() + ' 件</p></div>' +
      '<div class="card stack"><button class="btn primary" data-act="start" data-mode="anki">全体で学習</button>' +
      '<label class="check"><input type="checkbox" id="walkOnly"' + (st.walk ? ' checked' : '') + '>ウォーク問だけ</label></div>' +
      '<div class="card"><h2>科目別</h2>' +
      '<label class="f">科目<select id="fSubject">' + options(uniq('s'), st.subject, 'すべて') + '</select></label>' +
      '<label class="f">大分類<select id="fLarge">' + options(uniq('l', function (m) { return !st.subject || m.s === st.subject; }), st.large, 'すべて') + '</select></label>' +
      '<label class="check"><input type="checkbox" id="fixOnly"' + (st.fix ? ' checked' : '') + '>要修正だけ</label>' +
      '<button class="btn primary" data-act="start" data-mode="subject">科目別で学習</button></div>' +
      '<div class="card"><h2>ID順</h2><label class="f">開始ID<input id="startId" type="number" inputmode="numeric" value="' + (st.startId || '') + '"></label>' +
      '<button class="btn" data-act="start" data-mode="id">この ID から学習</button></div>';
  }

  async function showQuestion(id) {
    var m = byId.get(id); if (!m) return;
    var t = await getText(id) || { q: '', a: '' };
    S.curId = id; S.revealed = false;
    if (S.view !== 'study') { S.view = 'study'; $('title').textContent = TITLES.study; $('backBtn').hidden = false; $('tabs').hidden = true; }
    var cat = [m.s, m.l, m.m, m.n].filter(Boolean).map(esc).join(' › ');
    main.innerHTML = '<div class="study">' +
      '<div class="qMeta">ID ' + m.id + ' ・ レベル ' + (m.lv || 0) + ' ・ ○' + (m.c || 0) + ' ×' + (m.w || 0) + ' ・ 借金 ' + (m.debt || 0) + '<br>' + cat + '</div>' +
      '<div class="tools"><button data-act="prev"' + (S.trail.length ? '' : ' disabled') + '>前へ</button><button data-act="skip">スキップ</button>' +
      '<button data-act="flag" data-f="walk" class="' + (m.walk ? 'on' : '') + '">ウォーク</button><button data-act="flag" data-f="fix" class="' + (m.fix ? 'on' : '') + '">要修正</button><button data-act="edit">修正</button></div>' +
      '<div class="card"><div class="qText">' + esc(t.q) + '</div>' +
      '<div class="aBox" id="aBox" hidden><h3>答え</h3><div class="aText">' + esc(t.a) + '</div></div></div>' +
      '<div class="actions" id="actions"><button class="btn primary" data-act="reveal">答えを見る</button></div></div>';
    main.scrollTop = 0;
    saveResume();
  }
  function reveal() {
    S.revealed = true; $('aBox').hidden = false;
    $('actions').innerHTML = '<div class="grade"><button class="ng" data-act="grade" data-ok="0">× 即復習</button><button class="ok" data-act="grade" data-ok="1">○ 覚えた</button></div>';
  }
  function saveResume() { try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ mode: S.mode, id: S.curId })); } catch (e) {} }

  function filteredList() {
    var f = S.list, n = /^\d+$/.test(f.q.trim()) ? Number(f.q.trim()) : null;
    return metas.filter(function (m) {
      if (f.s && m.s !== f.s) return false;
      if (f.l && m.l !== f.l) return false;
      if (f.flag === 'walk' && !m.walk) return false;
      if (f.flag === 'fix' && !m.fix) return false;
      if (n != null && m.id !== n) return false;
      return true;
    }).map(function (m) { return m.id; });
  }
  async function searchText(ids, word) {
    var want = new Set(ids), out = [], w = word.toLowerCase();
    await new Promise(function (ok, ng) {
      var r = db.transaction('text').objectStore('text').openCursor();
      r.onsuccess = function () {
        var c = r.result; if (!c) return ok();
        var v = c.value;
        if (want.has(v.id) && ((v.q || '').toLowerCase().indexOf(w) >= 0 || (v.a || '').toLowerCase().indexOf(w) >= 0)) out.push(v.id);
        c.continue();
      };
      r.onerror = function () { ng(r.error); };
    });
    return out;
  }
  function renderList() {
    var f = S.list;
    main.innerHTML = '<div class="card">' +
      '<label class="f">言葉または ID で探す<input id="lq" type="search" enterkeyhint="search" value="' + esc(f.q) + '"></label>' +
      '<div class="row"><label class="f">科目<select id="ls">' + options(uniq('s'), f.s, 'すべて') + '</select></label>' +
      '<label class="f">大分類<select id="ll">' + options(uniq('l', function (m) { return !f.s || m.s === f.s; }), f.l, 'すべて') + '</select></label></div>' +
      '<label class="f">印<select id="lflag"><option value="">すべて</option><option value="walk"' + (f.flag === 'walk' ? ' selected' : '') + '>ウォーク問</option><option value="fix"' + (f.flag === 'fix' ? ' selected' : '') + '>要修正</option></select></label>' +
      '<button class="btn primary" data-act="search">探す</button></div><div id="listOut"></div>';
    runList();
  }
  async function runList() {
    var f = S.list, out = $('listOut'); if (!out) return;
    var ids = filteredList(), word = f.q.trim();
    if (word && !/^\d+$/.test(word)) { out.innerHTML = '<p class="muted">探しています…</p>'; ids = await searchText(ids, word); }
    f.ids = ids; f.shown = LIST_STEP;
    await paintList();
  }
  async function paintList() {
    var f = S.list, out = $('listOut'); if (!out) return;
    var part = f.ids.slice(0, f.shown);
    var texts = await Promise.all(part.map(getText));
    out.innerHTML = '<p class="muted">' + f.ids.length.toLocaleString() + ' 件</p>' + (part.length ? '<div class="card listBox">' + part.map(function (id, i) {
      var m = byId.get(id), t = texts[i] || {};
      return '<button class="item" data-act="openItem" data-id="' + id + '"><div class="meta">ID ' + id + ' ・ ' + esc(m.s) + ' ・ Lv' + (m.lv || 0) + (m.walk ? ' ・ ウォーク' : '') + (m.fix ? ' ・ 要修正' : '') + '</div><div class="txt">' + esc(t.q) + '</div></button>';
    }).join('') + '</div>' : '') + (f.ids.length > f.shown ? '<button class="btn" data-act="more">続きを表示</button>' : '');
  }

  async function renderEdit(id) {
    S.editId = id;
    var m = id != null ? byId.get(id) : null, t = id != null ? await getText(id) : null;
    var base = m || metas[metas.length - 1] || {};
    main.innerHTML = '<div class="card">' +
      '<label class="f">問題<textarea id="eq">' + esc(t ? t.q : '') + '</textarea></label>' +
      '<label class="f">答え<textarea id="ea">' + esc(t ? t.a : '') + '</textarea></label>' +
      field('es', '科目', base.s, uniq('s')) + field('el', '大分類', base.l, uniq('l')) +
      field('em', '中分類', base.m, uniq('m')) + field('en', '小分類', m ? m.n : '', uniq('n')) +
      '<label class="check"><input type="checkbox" id="ewalk"' + (m && m.walk ? ' checked' : '') + '>ウォーク問</label>' +
      '<label class="check"><input type="checkbox" id="efix"' + (m && m.fix ? ' checked' : '') + '>要修正</label>' +
      '<div class="stack"><button class="btn primary" data-act="saveEdit">保存</button>' +
      (m ? '<button class="btn danger" data-act="delete">この問題を消す</button>' : '') + '</div></div>';
  }
  function field(id, label, val, list) {
    return '<label class="f">' + label + '<input id="' + id + '" list="' + id + 'L" value="' + esc(val || '') + '"><datalist id="' + id + 'L">' +
      list.slice(0, 200).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist></label>';
  }
  async function saveEdit() {
    var d = { q: $('eq').value, a: $('ea').value, s: $('es').value.trim(), l: $('el').value.trim(), m: $('em').value.trim(), n: $('en').value.trim(), walk: $('ewalk').checked ? 1 : 0, fix: $('efix').checked ? 1 : 0 };
    if (!d.q.trim()) { toast('問題を入れてください'); return; }
    var id = S.editId, m;
    if (id == null) {
      var low = await kvGet('tempId') || 0; id = low - 1; await kvSet('tempId', id);
      m = { id: id, c: 0, w: 0, lv: 0, next: Date.now(), last: null, debt: 0 };
      metas.push(m); byId.set(id, m);
    } else {
      m = byId.get(id);
      if (!m) { // 直している間に別の端末で消された。入力は捨てず、サーバーの確認に回す
        m = { id: id, c: 0, w: 0, lv: 0, next: Date.now(), last: null, debt: 0, tt: 0 };
        metas.push(m); byId.set(id, m); metas.sort(function (a, b) { return a.id - b.id; });
      }
    }
    Object.assign(m, { s: d.s, l: d.l, m: d.m, n: d.n, walk: d.walk, fix: d.fix });
    await saveMeta(m);
    await req('text', 'readwrite', function (s) { return s.put({ id: id, q: d.q, a: d.a }); });
    d.baseTs = m.tt || 0; // どの版をもとに直したか
    await addOp('save', id, d);
    toast('保存しました');
    if (S.editFrom === 'study') { S.view = 'study'; $('title').textContent = TITLES.study; showQuestion(id); }
    else if (S.editFrom === 'list') go('list');
    else renderEdit(null);
    S.editFrom = S.editFrom === 'study' || S.editFrom === 'list' ? null : S.editFrom;
  }
  async function deleteCurrent() {
    var id = S.editId; if (id == null || !confirm('ID ' + id + ' を消しますか？')) return;
    var m = byId.get(id);
    if (m) { metas.splice(metas.indexOf(m), 1); byId.delete(id); }
    await req('meta', 'readwrite', function (s) { return s.delete(id); });
    await req('text', 'readwrite', function (s) { return s.delete(id); });
    await addOp('delete', id, {});
    toast('消しました');
    if (S.editFrom === 'study') { S.view = 'study'; S.curId = id; nextQuestion(); } else go('list');
  }

  /* ---------- 修正がぶつかったとき ---------- */
  function diffBlock(title, d) {
    var cat = [d.s, d.l, d.m, d.n].filter(Boolean).map(esc).join(' › ');
    return '<div class="card"><h2>' + title + '</h2><div class="qMeta">' + cat + '</div><div class="qText">' + esc(d.q) + '</div>' +
      '<div class="aBox"><h3>答え</h3><div class="aText">' + esc(d.a) + '</div></div></div>';
  }
  function renderConflict() {
    var c = conflicts[0];
    if (!c) { go('home'); return; }
    main.innerHTML = '<p class="muted">ID ' + c.id + ' ・ 残り ' + conflicts.length + ' 件</p>' +
      diffBlock('この端末の修正', c.mine) +
      (c.theirs ? diffBlock('別の端末の内容（今のデータ）', c.theirs) : '<div class="card"><h2>別の端末で消されています</h2></div>') +
      '<div class="card stack"><button class="btn primary" data-act="keepMine">' + (c.theirs ? 'この端末の修正を残す' : 'この修正で問題を戻す') + '</button>' +
      '<button class="btn" data-act="keepTheirs">' + (c.theirs ? '別の端末の内容を残す' : '消したままにする') + '</button></div>';
    main.scrollTop = 0;
  }
  async function handleConflict(op, res) {
    conflicts = conflicts.filter(function (x) { return x.id !== res.id; });
    conflicts.push({ id: res.id, mine: op.data, theirs: res.theirs, ts: res.ts });
    await kvSet('conflicts', conflicts);
    if (res.row) { await putRows([res.row]); applyRowsToMemory([res.row]); }
    toast('修正がぶつかった問題があります。ホームで選べます', 3500);
  }
  async function resolveConflict(keepMine) {
    var c = conflicts.shift(); if (!c) return;
    await kvSet('conflicts', conflicts);
    if (keepMine) await addOp('save', c.id, Object.assign({}, c.mine, { baseTs: c.ts, restore: c.theirs ? 0 : 1 }));
    if (conflicts.length) renderConflict(); else go('home');
  }

  function renderSettings() {
    var fs = 17; try { fs = Number(localStorage.getItem(FS_KEY)) || 17; } catch (e) {}
    main.innerHTML = '<div class="card"><h2>データの接続先</h2><label class="f">ウェブアプリの URL<input id="url" type="url" autocomplete="off" value="' + esc(gasUrl()) + '"></label>' +
      '<div class="stack"><button class="btn primary" data-act="saveUrl">保存して読み込む</button><button class="btn" data-act="copyUrl">URL をコピー</button></div>' +
      '<p class="muted">ホーム画面に追加したあとは、ここへ貼り付けてください。</p><div id="dlBox"></div></div>' +
      '<div class="card"><h2>文字の大きさ</h2><label class="f">問題と答え（' + fs + 'px）<input id="fs" type="range" min="14" max="26" value="' + fs + '"></label></div>' +
      '<div class="card"><h2>データ</h2><p class="muted">端末の問題 ' + metas.length.toLocaleString() + ' 件 ／ 未送信 ' + S.pending + ' 件</p>' +
      '<button class="btn" data-act="redownload">全部読み直す</button></div>' +
      '<p class="muted">版 ' + APP_VERSION + '</p>';
  }

  /* ---------- 同期 ---------- */
  function paintSync() { var b = $('syncBtn'); b.textContent = S.syncing ? '同期中' : S.pending ? '未送信 ' + S.pending : '同期'; }
  function scheduleSync() { clearTimeout(scheduleSync.t); scheduleSync.t = setTimeout(function () { sync(false); }, 2500); }
  async function api(params) {
    var r = await fetch(gasUrl() + '?' + new URLSearchParams(params).toString(), { redirect: 'follow' });
    var j = await r.json(); if (!j.ok) throw new Error(j.error || '読み込めません'); return j;
  }
  async function apiPost(body) {
    body.device = deviceId;
    var r = await fetch(gasUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    var j = await r.json();
    if (!j.ok) { var err = new Error(j.error || '送れません'); err.busy = !!j.busy; throw err; }
    return j;
  }
  async function download(force) {
    var st = (!force && await kvGet('dl')) || { next: 0, rev: null };
    if (force) {
      await req('meta', 'readwrite', function (s) { return s.clear(); });
      await req('text', 'readwrite', function (s) { return s.clear(); });
      metas = []; byId = new Map();
    }
    for (;;) {
      var j = await api({ action: 'rows', offset: st.next, limit: PAGE });
      if (st.rev == null) st.rev = j.rev;
      if (j.next == null) break;
      await putRows(j.rows); applyRowsToMemory(j.rows);
      st.next = j.next; await kvSet('dl', st);
      var pct = Math.min(100, Math.round(st.next / j.total * 100));
      var box = $('dlBox'); if (box) box.innerHTML = '<div class="bar"><i style="width:' + pct + '%"></i></div><p class="muted">' + st.next.toLocaleString() + ' / ' + j.total.toLocaleString() + ' 件</p>';
      else $('syncBtn').textContent = pct + '%';
      if (st.next >= j.total) break;
    }
    await kvSet('rev', st.rev); await kvSet('loaded', true);
    await req('kv', 'readwrite', function (s) { return s.delete('dl'); });
    var server = await api({ action: 'settings', device: deviceId });
    study.rest = server.settings.rest || 0; await kvSet('study', study);
    if (!(await kvGet('settings'))) { // 絞り込みは、この端末で初めてのときだけ元の設定を使う
      var ss = server.settings;
      settings = { subject: ss.subject, large: ss.large, startId: ss.startId, walk: ss.walk, fix: ss.fix };
      await kvSet('settings', settings);
    }
  }
  async function pushOps() {
    if (await kvGet('countDirty')) {
      await req('ops', 'readwrite', function (s) { return s.add({ opId: uid(), type: 'count', id: 0, data: { own: study.own } }); });
      await kvSet('countDirty', false);
    }
    for (;;) {
      var ops = await req('ops', 'readonly', function (s) { return s.getAll(null, 20); });
      S.pending = await req('ops', 'readonly', function (s) { return s.count(); }); paintSync();
      if (!ops.length) return;
      var j = await apiPost({ action: 'push', ops: ops.map(function (o) { return { opId: o.opId, type: o.type, id: o.id, data: o.data }; }) });
      var failed = null, advanced = 0;
      for (var i = 0; i < j.results.length; i++) {
        var res = j.results[i], op = ops[i];
        if (!res.ok) { failed = res.error; break; }
        if (op.id < 0 && res.id > 0) await remap(op.id, res.id);
        if (res.conflict) await handleConflict(op, res);
        else if (op.type === 'save') {
          var sm = byId.get(res.id);
          if (sm) { sm.tt = res.ts; await saveMeta(sm); }
        }
        await req('ops', 'readwrite', function (s) { return s.delete(op.seq); });
        advanced++;
      }
      if (failed) throw new Error(failed);
      if (!advanced) throw new Error('送信が進みません');
    }
  }
  async function remap(oldId, newId) {
    var m = byId.get(oldId);
    if (m) {
      var t = await getText(oldId);
      byId.delete(oldId); m.id = newId; byId.set(newId, m);
      await req('meta', 'readwrite', function (s) { s.delete(oldId); return s.put(m); });
      await req('text', 'readwrite', function (s) { s.delete(oldId); return s.put({ id: newId, q: t ? t.q : '', a: t ? t.a : '' }); });
      metas.sort(function (a, b) { return a.id - b.id; });
    }
    if (S.curId === oldId) S.curId = newId;
    if (S.editId === oldId) S.editId = newId;
    S.trail = S.trail.map(function (x) { return x === oldId ? newId : x; });
    var all = await req('ops', 'readonly', function (s) { return s.getAll(); });
    var hit = all.filter(function (o) { return o.id === oldId; });
    if (hit.length) await req('ops', 'readwrite', function (s) { hit.forEach(function (o) { o.id = newId; s.put(o); }); });
  }
  async function pullChanges() {
    var rev = await kvGet('rev') || 0;
    for (;;) {
      var j = await api({ action: 'changes', since: rev, device: deviceId });
      if (j.rest != null && j.rest !== study.rest) { study.rest = j.rest; await kvSet('study', study); }
      var waiting = new Set((await req('ops', 'readonly', function (s) { return s.getAll(); })).map(function (o) { return o.id; }));
      var rows = j.rows.filter(function (r) { return !waiting.has(r[0]); });
      if (rows.length) { await putRows(rows); applyRowsToMemory(rows); }
      rev = j.rev; await kvSet('rev', rev);
      if (!j.more) break;
    }
  }
  async function sync(manual, force) {
    if (S.syncing) return;
    if (!gasUrl()) { if (manual) toast('設定で接続先を入れてください'); return; }
    if (!navigator.onLine) { if (manual) toast('オフラインです。あとで送ります'); return; }
    S.syncing = true; paintSync();
    try {
      await pushOps();
      if (force || !(await kvGet('loaded'))) await download(force);
      else await pullChanges();
      S.pending = await req('ops', 'readonly', function (s) { return s.count(); });
      if (manual) toast('同期しました');
      if (S.view === 'study' && S.curId != null && !byId.has(S.curId)) {
        toast('この問題は別の端末で消されました'); nextQuestion();
      }
      if (S.view === 'home') renderHome();
      if (S.view === 'settings' && force) renderSettings();
    } catch (e) {
      if (e.busy) { // 別の端末が送信中。少し待って自動で送り直す
        if (manual) toast('混み合っています。少しあとで送ります');
        setTimeout(function () { sync(false); }, 4000 + Math.random() * 6000);
      } else toast('同期できません：' + (e.message || e), 4000);
    } finally {
      S.syncing = false; paintSync();
    }
  }

  /* ---------- 操作 ---------- */
  function readHomeFilters() {
    var g = function (id) { return $(id); };
    if (g('walkOnly')) settings.walk = g('walkOnly').checked ? 1 : 0;
    if (g('fSubject')) settings.subject = g('fSubject').value;
    if (g('fLarge')) settings.large = g('fLarge').value;
    if (g('fixOnly')) settings.fix = g('fixOnly').checked ? 1 : 0;
    if (g('startId')) settings.startId = Number(g('startId').value) || 0;
    kvSet('settings', settings);
  }
  var actions = {
    goSettings: function () { go('settings'); },
    start: function (el) {
      readHomeFilters(); S.mode = el.dataset.mode; S.curId = null; S.trail = [];
      var id = S.mode === 'id' ? (poolFor('id')[0] || {}).id : pickNext(S.mode, null);
      if (id == null) { toast('条件に合う問題がありません'); return; }
      showQuestion(id);
    },
    reveal: reveal,
    grade: function (el) { grade(el.dataset.ok === '1'); },
    skip: nextQuestion,
    prev: function () {
      var id;
      while ((id = S.trail.pop()) != null) if (byId.has(id)) { showQuestion(id); return; }
      toast('前の問題はありません');
    },
    flag: async function (el) {
      var m = byId.get(S.curId), f = el.dataset.f;
      if (!m) { toast('この問題は別の端末で消されました'); nextQuestion(); return; }
      m[f] = m[f] ? 0 : 1; el.classList.toggle('on', !!m[f]);
      var one = {}; one[f] = m[f]; // 押した印だけ送る
      await saveMeta(m); await addOp('flag', m.id, one);
    },
    openConflict: function () { go('conflict'); },
    keepMine: function () { resolveConflict(true); },
    keepTheirs: function () { resolveConflict(false); },
    edit: function () { S.editFrom = 'study'; S.view = 'edit'; $('title').textContent = TITLES.edit; renderEdit(S.curId); main.scrollTop = 0; },
    search: function () { var f = S.list; f.q = $('lq').value; f.s = $('ls').value; f.l = $('ll').value; f.flag = $('lflag').value; runList(); },
    more: function () { S.list.shown += LIST_STEP; paintList(); },
    openItem: function (el) { S.editFrom = 'list'; go('edit'); renderEdit(Number(el.dataset.id)); },
    saveEdit: saveEdit,
    delete: deleteCurrent,
    saveUrl: function () {
      var u = $('url').value.trim();
      if (!GAS_PAT.test(u)) { toast('URL の形が違います'); return; }
      try { localStorage.setItem(URL_KEY, u); } catch (e) {}
      sync(true);
    },
    copyUrl: function () { var u = gasUrl(); if (u && navigator.clipboard) navigator.clipboard.writeText(u).then(function () { toast('コピーしました'); }); },
    redownload: function () {
      if (S.pending) { toast('未送信を送ってからにしてください'); return; }
      if (confirm('端末の問題を入れ直しますか？')) sync(true, true);
    }
  };
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (el && !el.disabled && actions[el.dataset.act]) actions[el.dataset.act](el);
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'fSubject') { settings.subject = e.target.value; settings.large = ''; readHomeLarge(); }
    if (e.target.id === 'ls') { S.list.s = e.target.value; S.list.l = ''; $('ll').innerHTML = options(uniq('l', function (m) { return !S.list.s || m.s === S.list.s; }), '', 'すべて'); }
    if (e.target.id === 'fs') { try { localStorage.setItem(FS_KEY, e.target.value); } catch (x) {} applyFs(); renderSettings(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'lq') { e.preventDefault(); actions.search(); e.target.blur(); } });
  function readHomeLarge() { $('fLarge').innerHTML = options(uniq('l', function (m) { return !settings.subject || m.s === settings.subject; }), '', 'すべて'); }
  function applyFs() { try { var v = localStorage.getItem(FS_KEY); if (v) document.documentElement.style.setProperty('--fs', v + 'px'); } catch (e) {} }

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.editFrom = null; go(b.dataset.tab);
  });
  $('backBtn').addEventListener('click', function () {
    if (S.view === 'edit' && S.editFrom === 'study') { S.editFrom = null; S.view = 'study'; showQuestion(S.curId); return; }
    if (S.view === 'edit' && S.editFrom === 'list') { S.editFrom = null; go('list'); return; }
    S.mode = null; S.curId = null; try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {} go('home');
  });
  $('syncBtn').addEventListener('click', function () { sync(true); });
  window.addEventListener('online', function () { sync(false); });

  /* ---------- 自動更新 ---------- */
  var swReg = null, lastCheck = 0;
  function checkUpdate() {
    var now = Date.now();
    if (swReg && now - lastCheck > 30000) { lastCheck = now; swReg.update().catch(function () {}); }
  }
  function doReload() { saveResume(); location.reload(); }
  function setupUpdate() {
    if (!('serviceWorker' in navigator)) return;
    var had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!had) { had = true; return; }
      if (S.view === 'edit' || S.view === 'add') S.wantReload = true; else doReload();
    });
    navigator.serviceWorker.register('sw.js').then(function (r) { swReg = r; checkUpdate(); }).catch(function () {});
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { checkUpdate(); sync(false); }
    });
  }

  /* 設定用 QR の接続先を受け取り、アドレス欄からはすぐ消す */
  function importFromQr() {
    var m = /^#gas=(.+)$/.exec(location.hash);
    if (!m) return false;
    history.replaceState(null, '', location.pathname);
    var u = '';
    try { u = decodeURIComponent(m[1]); } catch (e) { return false; }
    if (!GAS_PAT.test(u)) return false;
    try { localStorage.setItem(URL_KEY, u); } catch (e) { return false; }
    return true;
  }

  /* ---------- 起動 ---------- */
  async function boot() {
    applyFs();
    db = await openDb();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    metas = await req('meta', 'readonly', function (s) { return s.getAll(); }) || [];
    metas.sort(function (a, b) { return a.id - b.id; });
    byId = new Map(metas.map(function (m) { return [m.id, m]; }));
    var savedSettings = await kvGet('settings') || {};
    settings = Object.assign(settings, savedSettings);
    study = await kvGet('study') || { own: 0, rest: Number(savedSettings.study) || 0 }; // 1.0 の回数はほかの合計へ
    conflicts = await kvGet('conflicts') || [];
    deviceId = await kvGet('device');
    if (!deviceId) { deviceId = 'd' + uid(); await kvSet('device', deviceId); }
    S.pending = await req('ops', 'readonly', function (s) { return s.count(); });
    paintSync();
    if (importFromQr()) {
      go('settings'); setupUpdate();
      toast('接続先を受け取りました', 3500);
      return;
    }
    var resume = null; try { resume = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null'); } catch (e) {}
    if (resume && resume.id != null && byId.has(resume.id)) { S.mode = resume.mode; showQuestion(resume.id); }
    else go('home');
    setupUpdate();
    sync(false);
  }
  boot().catch(function (e) { main.innerHTML = '<div class="card">起動できません：' + esc(e.message || e) + '</div>'; });
})();
