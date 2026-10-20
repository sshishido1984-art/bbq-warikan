import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const $ = id => document.getElementById(id);
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const signed = n => (Math.round(n) > 0 ? '+' : Math.round(n) < 0 ? '−' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');

const configured = !!(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith('YOUR'));
const eventId = new URLSearchParams(location.search).get('e') || '';

// ---------- 状態 ----------
const S = { people: [], items: [], meta: { title: '', unit: 10 }, peopleReady: false, eventMissing: false };
const meKey = 'bbq-me-' + eventId;
let me = lsGet(meKey) || '';
let editingId = null;
let draft = { payer: '', excluded: [] };
const nameOf = id => (S.people.find(p => p.id === id) || {}).name || '（削除された人）';

function setStatus(kind, text) { const el = $('status'); el.hidden = !text; el.className = 'status ' + (kind || ''); el.textContent = text || ''; }
function flash(id, text, err) {
  const el = $(id); el.textContent = text; el.classList.toggle('err', !!err);
  clearTimeout(el._t); el._t = setTimeout(() => { el.textContent = ''; }, 3500);
}

// 最近開いた割り勘（この端末だけ）
function recentList() { try { return JSON.parse(lsGet('bbq-recent')) || []; } catch (e) { return []; } }
function rememberRecent(id, title) {
  const list = recentList().filter(r => r.id !== id);
  list.unshift({ id, title: title || '（イベント名なし）', at: Date.now() });
  lsSet('bbq-recent', JSON.stringify(list.slice(0, 10)));
}

// ---------- 保存先 ----------
async function firebaseStore(id) {
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const fs = await import(FB + 'firebase-firestore.js');
  const db = fs.getFirestore(initializeApp(firebaseConfig));
  if (!id) {
    return { createEvent: async title => { const ref = fs.doc(fs.collection(db, 'events')); await fs.setDoc(ref, { title, unit: 10, createdAt: Date.now() }); return ref.id; } };
  }
  const ev = fs.doc(db, 'events', id);
  const people = fs.collection(ev, 'people'), items = fs.collection(ev, 'items');
  const onErr = () => setStatus('warn', 'データを読み込めませんでした。通信状態を確認して、ページを開き直してください。');
  fs.onSnapshot(ev, s => {
    if (!s.exists()) { if (!s.metadata.fromCache) { S.eventMissing = true; renderAll(); } return; }
    S.meta = { title: '', unit: 10, ...s.data() }; rememberRecent(id, S.meta.title); renderAll();
  }, onErr);
  fs.onSnapshot(fs.query(people, fs.orderBy('createdAt')), s => {
    S.people = s.docs.map(d => ({ id: d.id, ...d.data() })); S.peopleReady = !s.metadata.fromCache || !s.empty; renderAll();
  }, onErr);
  fs.onSnapshot(fs.query(items, fs.orderBy('createdAt')), s => {
    S.items = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll();
  }, onErr);
  return {
    addPerson: name => fs.addDoc(people, { name, createdAt: Date.now() }),
    deletePerson: pid => fs.deleteDoc(fs.doc(people, pid)),
    saveItem: (iid, data) => iid
      ? fs.setDoc(fs.doc(items, iid), { ...data, createdAt: (S.items.find(i => i.id === iid) || {}).createdAt || Date.now() })
      : fs.addDoc(items, { ...data, createdAt: Date.now() }),
    deleteItem: iid => fs.deleteDoc(fs.doc(items, iid)),
    setMeta: patch => fs.setDoc(ev, { title: S.meta.title || '', unit: S.meta.unit || 10, createdAt: S.meta.createdAt || Date.now(), ...patch }),
  };
}

// Firebase 未設定のときの確認用：この端末だけに保存
function localStore(id) {
  if (!id) {
    return { createEvent: async title => { const nid = randomId(); lsSet('bbq-local-' + nid, JSON.stringify({ meta: { title, unit: 10, createdAt: Date.now() }, people: [], items: [] })); return nid; } };
  }
  const KEY = 'bbq-local-' + id;
  try { const s = JSON.parse(lsGet(KEY)); if (s) { S.people = s.people || []; S.items = s.items || []; S.meta = { ...S.meta, ...(s.meta || {}) }; } } catch (e) {}
  S.peopleReady = true;
  rememberRecent(id, S.meta.title);
  const persist = () => { lsSet(KEY, JSON.stringify({ people: S.people, items: S.items, meta: S.meta })); rememberRecent(id, S.meta.title); renderAll(); };
  return {
    addPerson: async name => { S.people.push({ id: randomId(), name, createdAt: Date.now() }); persist(); },
    deletePerson: async pid => { S.people = S.people.filter(p => p.id !== pid); persist(); },
    saveItem: async (iid, data) => {
      if (iid) S.items = S.items.map(i => i.id === iid ? { ...i, ...data } : i);
      else S.items.push({ id: randomId(), ...data, createdAt: Date.now() });
      persist();
    },
    deleteItem: async iid => { S.items = S.items.filter(i => i.id !== iid); persist(); },
    setMeta: async patch => { S.meta = { ...S.meta, ...patch }; persist(); },
  };
}

let store = null;
async function write(fn, doneMsg) {
  try { await fn(); if (doneMsg) flash('formToast', doneMsg); return true; }
  catch (e) {
    console.error(e);
    flash('formToast', e && e.code === 'permission-denied'
      ? '保存できませんでした。入力内容（文字数や金額）を確認してください。'
      : '保存できませんでした。通信状態を確認して、もう一度押してください。', true);
    return false;
  }
}

// ---------- 計算 ----------
function compute() {
  const unit = Number(S.meta.unit) || 10;
  const paid = {}, owed = {};
  S.people.forEach(p => { paid[p.id] = 0; owed[p.id] = 0; });
  let total = 0, orphan = false;
  S.items.forEach(it => {
    const amt = Number(it.amount) || 0;
    if (amt <= 0) return;
    total += amt;
    if (paid[it.payer] !== undefined) paid[it.payer] += amt; else orphan = true;
    const ex = it.excluded || [];
    const t = S.people.filter(p => !ex.includes(p.id));
    if (!t.length) { orphan = true; return; }
    t.forEach(p => owed[p.id] += amt / t.length);
  });
  const rows = S.people.map(p => ({ id: p.id, name: p.name, paid: paid[p.id], owed: owed[p.id], bal: paid[p.id] - owed[p.id] }));
  // 支払いが一番多い人から、受け取りが一番多い人へ順に相殺していく
  const cred = rows.filter(r => r.bal > 0.5).map(r => ({ ...r, left: r.bal })).sort((a, b) => b.left - a.left);
  const debt = rows.filter(r => r.bal < -0.5).map(r => ({ ...r, left: -r.bal })).sort((a, b) => b.left - a.left);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].left, cred[j].left);
    const rounded = Math.round(x / unit) * unit;
    if (rounded > 0) transfers.push({ fromId: debt[i].id, toId: cred[j].id, from: debt[i].name, to: cred[j].name, amount: rounded, raw: x });
    debt[i].left -= x; cred[j].left -= x;
    if (debt[i].left < 0.5) i++;
    if (cred[j].left < 0.5) j++;
  }
  const diff = transfers.reduce((s, t) => s + (t.amount - t.raw), 0);
  const perHead = S.people.length ? total / S.people.length : 0;
  return { total, perHead, rows, transfers, diff, unit, orphan };
}

// ---------- 描画 ----------
function options(sel, placeholder) {
  return (placeholder ? `<option value="">${placeholder}</option>` : '') +
    S.people.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function renderMe(r) {
  if (me && S.peopleReady && !S.people.some(p => p.id === me)) me = '';
  if (document.activeElement !== $('me')) $('me').innerHTML = options(me, S.people.length ? '名前を選んでください' : 'まずメンバーを追加');
  const el = $('meStatus'); el.className = 'me-status';
  if (!me) { el.classList.add('soft'); el.textContent = '自分の名前を選ぶと、払う金額と相手がここに出ます。'; return; }
  const pay = r.transfers.filter(t => t.fromId === me), get = r.transfers.filter(t => t.toId === me);
  if (pay.length) el.innerHTML = pay.map(t => `${esc(t.to)}さんへ <span class="amt">${yen(t.amount)}</span> 払います`).join('<br>');
  else if (get.length) el.innerHTML = get.map(t => `${esc(t.from)}さんから <span class="amt">${yen(t.amount)}</span> 受け取ります`).join('<br>');
  else { el.classList.add('ok'); el.textContent = r.total > 0 ? 'あなたの精算はありません。' : 'まだ支払いの入力がありません。'; }
}

const armed = {};
function arm(key, btn, label) {
  if (armed[key]) { clearTimeout(armed[key]); delete armed[key]; return true; }
  btn.classList.add('armed'); const old = btn.textContent; btn.textContent = label;
  armed[key] = setTimeout(() => { delete armed[key]; btn.classList.remove('armed'); btn.textContent = old; }, 3000);
  return false;
}

function renderMembers() {
  $('memberCount').textContent = S.people.length + '人';
  if (!S.people.length) {
    $('members').innerHTML = `<span class="hint">${S.peopleReady ? 'まだ誰もいません。参加者の名前を1人ずつ追加してください。' : '読み込み中…'}</span>`;
    return;
  }
  $('members').innerHTML = S.people.map(p => `
    <span class="member ${p.id === me ? 'me' : ''}">${esc(p.name)}${p.id === me ? '<span class="you">あなた</span>' : ''}
      <button class="icon-x" type="button" data-del-member="${esc(p.id)}" aria-label="${esc(p.name)}を削除">×</button>
    </span>`).join('');
}

function renderForm() {
  if (!S.people.some(p => p.id === draft.payer)) draft.payer = (S.people.some(p => p.id === me) ? me : (S.people[0] || {}).id) || '';
  if (document.activeElement !== $('fPayer')) $('fPayer').innerHTML = S.people.length ? options(draft.payer) : '<option value="">メンバー未登録</option>';
  $('fTargets').innerHTML = S.people.length
    ? S.people.map(p => `<button type="button" class="chip" data-target="${esc(p.id)}" aria-pressed="${!draft.excluded.includes(p.id)}">${esc(p.name)}</button>`).join('')
    : '<span class="hint">メンバーを追加すると、ここに並びます。</span>';
  $('itemForm').classList.toggle('editing', !!editingId);
  $('fSubmit').textContent = editingId ? 'この内容で更新' : '追加する';
  $('fCancel').hidden = !editingId;
  $('formSub').textContent = editingId ? '編集中' : 'レシート1枚ずつ';
}

function renderItems() {
  const total = S.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  $('itemCount').textContent = S.items.length ? `${S.items.length}件・${yen(total)}` : '';
  if (!S.items.length) {
    $('items').innerHTML = '<div class="empty">まだ入力がありません。立て替えた人は、上のフォームから自分の分を入れてください。</div>';
    return;
  }
  $('items').innerHTML = S.items.map(it => {
    const ex = (it.excluded || []).filter(id => S.people.some(p => p.id === id));
    const scope = ex.length ? `${ex.map(nameOf).map(esc).join('・')}を除く` : '全員';
    return `<div class="item">
      <span class="nm">${esc(it.name || '品目')}${it.payer === me ? '<span class="pill">あなた</span>' : ''}</span>
      <span class="am">${yen(Number(it.amount) || 0)}</span>
      <span class="meta">${esc(nameOf(it.payer))}が立替 ・ 対象：${scope}</span>
      <span class="acts">
        <button class="btn small" type="button" data-edit="${esc(it.id)}">編集</button>
        <button class="btn small danger" type="button" data-del-item="${esc(it.id)}">削除</button>
      </span>
    </div>`;
  }).join('');
}

function renderResult(r) {
  $('rTitle').textContent = (S.meta.title || '（イベント名なし）') + '　' + S.people.length + '人';
  $('total').textContent = yen(r.total);
  $('perHead').textContent = yen(Math.round(r.perHead / r.unit) * r.unit);
  $('summary').innerHTML = r.rows.length ? r.rows.map(x => `
    <tr class="${x.id === me ? 'me' : ''}"><td>${esc(x.name)}</td><td class="num">${yen(x.paid)}</td><td class="num">${yen(x.owed)}</td>
    <td class="num ${x.bal > 0.5 ? 'pos' : x.bal < -0.5 ? 'neg' : ''}">${signed(x.bal)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="note">メンバーを追加すると表示されます</td></tr>';
  $('transfers').innerHTML = r.transfers.length ? r.transfers.map(t => `
    <li class="${t.fromId === me || t.toId === me ? 'me' : ''}"><span class="who">${esc(t.from)}</span><span class="arrow">→</span><span class="who">${esc(t.to)}</span><span class="amt">${yen(t.amount)}</span></li>`).join('')
    : `<li class="msg">${r.total > 0 ? '送金は不要です。全員ぴったり。' : '支払いが入力されると、ここに送金リストが出ます'}</li>`;
  const notes = ['差額がプラスの人は受け取り、マイナスの人は支払いです。'];
  if (r.unit > 1 && r.transfers.length) notes.push(`送金額は${r.unit}円単位に丸めています（丸めの誤差 合計${signed(r.diff)}）。`);
  if (r.orphan) notes.push('⚠ 払った人が削除されたか、対象者が誰もいない品目があり、その分は計算に入っていません。');
  $('roundNote').textContent = notes.join(' ');
  document.querySelectorAll('.units button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.unit) === r.unit)));
}

function renderAll() {
  if (S.eventMissing) {
    $('main').hidden = true; $('titleBox').hidden = true;
    setStatus('warn', 'この割り勘のページは見つかりませんでした。リンクが途中で切れていないか確認してください。');
    return;
  }
  if (document.activeElement !== $('title')) $('title').value = S.meta.title || '';
  document.title = (S.meta.title ? S.meta.title + '｜' : '') + 'みんなの割り勘';
  const r = compute();
  renderMe(r); renderMembers(); renderForm(); renderItems(); renderResult(r);
}

function buildText() {
  const r = compute();
  const L = [`【${S.meta.title || '割り勘'} 精算】`, `合計 ${yen(r.total)} ／ ${S.people.length}人`, '', '▼ 支払い'];
  S.items.filter(it => Number(it.amount) > 0).forEach(it => {
    const ex = (it.excluded || []).filter(id => S.people.some(p => p.id === id));
    L.push(`・${it.name || '品目'} ${yen(it.amount)}　${nameOf(it.payer)}立替${ex.length ? `（${ex.map(nameOf).join('・')}を除く）` : ''}`);
  });
  L.push('', '▼ 各自の負担');
  r.rows.forEach(x => L.push(`・${x.name} ${yen(Math.round(x.owed / r.unit) * r.unit)}`));
  L.push('', '▼ 送金');
  if (r.transfers.length) r.transfers.forEach(t => L.push(`${t.from} → ${t.to}　${yen(t.amount)}`)); else L.push('送金なし');
  L.push('', '入力・確認はこちら', location.href);
  return L.join('\n');
}

function resetForm() {
  editingId = null;
  draft = { payer: S.people.some(p => p.id === me) ? me : draft.payer, excluded: [] };
  $('fName').value = ''; $('fAmount').value = '';
  renderForm();
}

async function copyText(text, toastId, okMsg) {
  try { await navigator.clipboard.writeText(text); flash(toastId, okMsg); return true; }
  catch (e) { return false; }
}

// ---------- イベントページの操作 ----------
function bindMain() {
  $('shareUrl').value = location.href;
  $('shareUrl').addEventListener('focus', e => e.target.select());
  $('copyUrl').addEventListener('click', async () => {
    if (!await copyText(location.href, 'shareToast', 'リンクをコピーしました。LINEに貼り付けて送ってください。')) { $('shareUrl').focus(); flash('shareToast', 'リンクを選択しました。コピーしてください。', true); }
  });
  $('shareBtn').addEventListener('click', async () => {
    const data = { title: S.meta.title || 'みんなの割り勘', text: `${S.meta.title || '割り勘'}の割り勘ページです。自分が支払ったものを入力してください。`, url: location.href };
    if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e.name === 'AbortError') return; } }
    if (!await copyText(data.text + '\n' + data.url, 'shareToast', '案内文とリンクをコピーしました。LINEに貼り付けて送ってください。')) { $('shareUrl').focus(); }
  });

  $('me').addEventListener('change', e => { me = e.target.value; lsSet(meKey, me); if (!editingId && me) draft.payer = me; renderAll(); });

  let titleTimer;
  $('title').addEventListener('input', e => {
    clearTimeout(titleTimer);
    const v = e.target.value;
    titleTimer = setTimeout(() => { if (v !== S.meta.title) write(() => store.setMeta({ title: v })); }, 700);
  });

  $('addMemberForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = $('newMember').value.trim();
    if (!v || !store) return;
    if (S.people.some(p => p.name === v)) { $('newMember').select(); flash('formToast', `${v}さんはもう登録されています。`, true); return; }
    $('newMember').value = '';
    await write(() => store.addPerson(v));
    $('newMember').focus();
  });

  $('members').addEventListener('click', e => {
    const btn = e.target.closest('[data-del-member]'); if (!btn) return;
    const id = btn.dataset.delMember;
    if (S.items.some(i => i.payer === id)) { flash('formToast', `${nameOf(id)}さんは立替があるため削除できません。先にその品目を削除してください。`, true); return; }
    if (!arm('m' + id, btn, '削除？')) return;
    if (me === id) { me = ''; lsSet(meKey, ''); }
    write(() => store.deletePerson(id));
  });

  $('fPayer').addEventListener('change', e => { draft.payer = e.target.value; });
  $('fTargets').addEventListener('click', e => {
    const btn = e.target.closest('[data-target]'); if (!btn) return;
    const id = btn.dataset.target;
    draft.excluded = draft.excluded.includes(id) ? draft.excluded.filter(x => x !== id) : [...draft.excluded, id];
    btn.setAttribute('aria-pressed', String(!draft.excluded.includes(id)));
  });

  $('itemForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!store) return;
    const amount = Math.round(Number($('fAmount').value));
    const name = $('fName').value.trim();
    if (!S.people.length) { flash('formToast', '先にメンバーを追加してください。', true); return; }
    if (!draft.payer) { flash('formToast', '払った人を選んでください。', true); return; }
    if (!(amount > 0)) { flash('formToast', '金額を入れてください。', true); $('fAmount').focus(); return; }
    if (amount > 10000000) { flash('formToast', '金額が大きすぎます。', true); return; }
    const excluded = draft.excluded.filter(id => S.people.some(p => p.id === id));
    if (excluded.length >= S.people.length) { flash('formToast', '対象が誰もいません。1人以上残してください。', true); return; }
    const data = { payer: draft.payer, name: name || '品目', amount, excluded };
    const wasEdit = !!editingId;
    $('fSubmit').disabled = true;
    const ok = await write(() => store.saveItem(editingId, data), wasEdit ? '更新しました' : '追加しました');
    $('fSubmit').disabled = false;
    if (ok) resetForm();
  });
  $('fCancel').addEventListener('click', resetForm);

  $('items').addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const it = S.items.find(i => i.id === ed.dataset.edit); if (!it) return;
      editingId = it.id;
      draft = { payer: it.payer, excluded: [...(it.excluded || [])] };
      $('fName').value = it.name; $('fAmount').value = it.amount;
      renderForm();
      $('itemForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const del = e.target.closest('[data-del-item]');
    if (del) {
      const id = del.dataset.delItem;
      if (!arm('i' + id, del, '本当に削除')) return;
      if (editingId === id) resetForm();
      write(() => store.deleteItem(id));
    }
  });

  document.querySelector('.units').addEventListener('click', e => {
    const u = Number(e.target.dataset.unit); if (!u || !store) return;
    write(() => store.setMeta({ unit: u }));
  });

  $('copy').addEventListener('click', async () => {
    const text = buildText();
    if (await copyText(text, 'toast', 'コピーしました。LINEに貼り付けて送れます。')) { $('copyFallback').hidden = true; return; }
    const ta = $('copyFallback'); ta.value = text; ta.hidden = false; ta.focus(); ta.select();
    flash('toast', '自動でコピーできませんでした。下の文章を選択してコピーしてください。', true);
  });
}

// ---------- トップページ ----------
function showLanding() {
  $('landing').hidden = false;
  const list = recentList();
  $('recentBox').hidden = !list.length;
  $('recent').innerHTML = list.map(r => `<a href="?e=${encodeURIComponent(r.id)}">${esc(r.title)}</a>`).join('');
  $('createForm').addEventListener('submit', async e => {
    e.preventDefault();
    const title = $('newTitle').value.trim();
    if (!title || !store) return;
    $('createBtn').disabled = true;
    try {
      const id = await store.createEvent(title);
      rememberRecent(id, title);
      location.href = '?e=' + encodeURIComponent(id);
    } catch (err) {
      console.error(err);
      $('createBtn').disabled = false;
      setStatus('warn', '作成できませんでした。通信状態を確認して、もう一度押してください。');
    }
  });
}

// ---------- 起動 ----------
(async () => {
  try { store = configured ? await firebaseStore(eventId) : localStore(eventId); }
  catch (e) { console.error(e); setStatus('warn', 'データベースに接続できませんでした。ページを開き直してください。'); return; }

  const notice = configured ? '' : 'Firebase が未設定のため、入力はこの端末にだけ保存されます（動作確認モード）。';
  if (!eventId) { setStatus(configured ? '' : 'warn', notice); showLanding(); return; }

  $('main').hidden = false; $('titleBox').hidden = false;
  setStatus(configured ? 'live' : 'warn', configured ? 'みんなと共有中：誰かが入力すると、この画面にもすぐ反映されます。' : notice);
  bindMain();
  renderAll();
})();
