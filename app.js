import { firebaseConfig } from './firebase-config.js?v=20261021b';

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
let deleting = false;
const nameOf = id => (S.people.find(p => p.id === id) || {}).name || '（削除された人）';
const isEqual = () => S.meta.mode === 'equal';
// 全角数字も半角にそろえる
const toHalf = v => v.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
// 最後に使われた文字の続きから、まだ使われていない A, B, C… の名前を n 人分（Z の次は AA, AB…）
function nextLetterNames(n) {
  const used = new Set(S.people.map(p => p.name));
  const label = k => { let t = ''; k++; while (k > 0) { k--; t = String.fromCharCode(65 + (k % 26)) + t; k = Math.floor(k / 26); } return t; };
  const out = [];
  const indexOf = nm => /^[A-Z]{1,3}$/.test(nm) ? [...nm].reduce((t, c) => t * 26 + (c.charCodeAt(0) - 64), 0) - 1 : -1;
  const start = Math.max(-1, ...S.people.map(p => indexOf(p.name))) + 1;
  for (let k = start; out.length < n && k < start + 1000; k++) { const nm = label(k); if (!used.has(nm)) out.push(nm); }
  return out;
}
const weightOf = p => (typeof p.weight === 'number' && p.weight >= 0 ? p.weight : 1);
const fmtW = w => (Math.round(w * 10) / 10).toString();

// イベント本体に保存する内容（古いデータには mode が無いので、あるときだけ入れる）
function metaDoc(patch) {
  const m = { title: S.meta.title || '', unit: S.meta.unit || 10, createdAt: S.meta.createdAt || Date.now() };
  if (S.meta.mode) m.mode = S.meta.mode;
  return { ...m, ...patch };
}

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
function forgetRecent(id) { lsSet('bbq-recent', JSON.stringify(recentList().filter(r => r.id !== id))); }

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
    if (deleting) return;
    S.meta = { title: '', unit: 10, ...s.data() }; rememberRecent(id, S.meta.title); renderAll();
  }, onErr);
  fs.onSnapshot(fs.query(people, fs.orderBy('createdAt')), s => {
    S.people = s.docs.map(d => ({ id: d.id, ...d.data() })); S.peopleReady = !s.metadata.fromCache || !s.empty; renderAll();
  }, onErr);
  fs.onSnapshot(fs.query(items, fs.orderBy('createdAt')), s => {
    S.items = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll();
  }, onErr);
  return {
    addPerson: (name, createdAt = Date.now()) => fs.addDoc(people, { name, createdAt }),
    renamePerson: (pid, name) => {
      const p = S.people.find(x => x.id === pid);
      const d = { name, createdAt: p.createdAt || Date.now() };
      if (typeof p.weight === 'number') d.weight = p.weight;
      return fs.setDoc(fs.doc(people, pid), d);
    },
    deletePerson: pid => fs.deleteDoc(fs.doc(people, pid)),
    saveItem: (iid, data) => iid
      ? fs.setDoc(fs.doc(items, iid), { ...data, createdAt: (S.items.find(i => i.id === iid) || {}).createdAt || Date.now() })
      : fs.addDoc(items, { ...data, createdAt: Date.now() }),
    deleteItem: iid => fs.deleteDoc(fs.doc(items, iid)),
    setMeta: patch => fs.setDoc(ev, metaDoc(patch)),
    setWeight: (pid, weight) => {
      const p = S.people.find(x => x.id === pid);
      return fs.setDoc(fs.doc(people, pid), { name: p.name, createdAt: p.createdAt || Date.now(), weight });
    },
    // 支払い・メンバーを消してから、イベント本体を消す
    deleteEvent: async () => {
      const [ps, is] = await Promise.all([fs.getDocs(people), fs.getDocs(items)]);
      const refs = [...ps.docs, ...is.docs].map(d => d.ref);
      for (let k = 0; k < refs.length; k += 400) {
        const batch = fs.writeBatch(db);
        refs.slice(k, k + 400).forEach(r => batch.delete(r));
        await batch.commit();
      }
      try { await fs.deleteDoc(ev); }
      catch (e) {
        // 古いルールのままだと本体は消せないので、イベント名だけ空にしておく
        if (e && e.code === 'permission-denied') await fs.setDoc(ev, { title: '', unit: 10, createdAt: S.meta.createdAt || Date.now() });
        else throw e;
      }
    },
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
    addPerson: async (name, createdAt = Date.now()) => { S.people.push({ id: randomId(), name, createdAt }); persist(); },
    renamePerson: async (pid, name) => { S.people = S.people.map(p => p.id === pid ? { ...p, name } : p); persist(); },
    deletePerson: async pid => { S.people = S.people.filter(p => p.id !== pid); persist(); },
    saveItem: async (iid, data) => {
      if (iid) S.items = S.items.map(i => i.id === iid ? { ...i, ...data } : i);
      else S.items.push({ id: randomId(), ...data, createdAt: Date.now() });
      persist();
    },
    deleteItem: async iid => { S.items = S.items.filter(i => i.id !== iid); persist(); },
    setMeta: async patch => { S.meta = { ...S.meta, ...patch }; persist(); },
    setWeight: async (pid, weight) => { S.people = S.people.map(p => p.id === pid ? { ...p, weight } : p); persist(); },
    deleteEvent: async () => { try { localStorage.removeItem(KEY); } catch (e) {} },
  };
}

let store = null;
async function write(fn, doneMsg, opts = {}) {
  const toast = opts.toast || 'formToast';
  try { await fn(); if (doneMsg) flash(toast, doneMsg); return true; }
  catch (e) {
    console.error(e);
    flash(toast, e && e.code === 'permission-denied'
      ? (opts.denied || '保存できませんでした。入力内容（文字数や金額）を確認してください。')
      : '保存できませんでした。通信状態を確認して、もう一度押してください。', true);
    return false;
  }
}
const RULES_OLD = '保存できませんでした。Firebaseのルールが古い可能性があります。最新の firestore.rules を貼り直してください。';

// ---------- 計算 ----------
function compute() {
  const unit = Number(S.meta.unit) || 10;
  const paid = {}, owed = {};
  S.people.forEach(p => { paid[p.id] = 0; owed[p.id] = 0; });
  let total = 0, orphan = false;
  const equal = isEqual();
  const sumW = S.people.reduce((s, p) => s + weightOf(p), 0);
  S.items.forEach(it => {
    const amt = Number(it.amount) || 0;
    if (amt <= 0) return;
    total += amt;
    if (paid[it.payer] !== undefined) paid[it.payer] += amt; else orphan = true;
    // 全体で一律：対象の指定は使わず、全員で負担割合に応じて分ける
    if (equal) {
      if (sumW <= 0) { orphan = true; return; }
      S.people.forEach(p => owed[p.id] += amt * weightOf(p) / sumW);
      return;
    }
    const ex = it.excluded || [];
    const t = S.people.filter(p => !ex.includes(p.id));
    if (!t.length) { orphan = true; return; }
    t.forEach(p => owed[p.id] += amt / t.length);
  });
  const rows = S.people.map(p => ({ id: p.id, name: p.name, weight: weightOf(p), paid: paid[p.id], owed: owed[p.id], bal: paid[p.id] - owed[p.id] }));
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
  const perHead = equal ? (sumW > 0 ? total / sumW : 0) : (S.people.length ? total / S.people.length : 0);
  return { total, perHead, rows, transfers, diff, unit, orphan, equal, sumW };
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
  if ($('members').querySelector('.rename-input')) return;
  if (!S.people.length) {
    $('members').innerHTML = `<span class="hint">${S.peopleReady ? 'まだ誰もいません。参加者の名前を1人ずつ追加してください。' : '読み込み中…'}</span>`;
    return;
  }
  $('members').innerHTML = S.people.map(p => `
    <span class="member ${p.id === me ? 'me' : ''}"><button type="button" class="m-name" data-rename="${esc(p.id)}" title="名前を変える">${esc(p.name)}</button>${p.id === me ? '<span class="you">あなた</span>' : ''}
      <button class="icon-x" type="button" data-del-member="${esc(p.id)}" aria-label="${esc(p.name)}を削除">×</button>
    </span>`).join('');
}

function renderForm() {
  if (!S.people.some(p => p.id === draft.payer)) draft.payer = (S.people.some(p => p.id === me) ? me : (S.people[0] || {}).id) || '';
  if (document.activeElement !== $('fPayer')) $('fPayer').innerHTML = S.people.length ? options(draft.payer) : '<option value="">メンバー未登録</option>';
  $('fTargets').innerHTML = S.people.length
    ? S.people.map(p => `<button type="button" class="chip" data-target="${esc(p.id)}" aria-pressed="${!draft.excluded.includes(p.id)}">${esc(p.name)}</button>`).join('')
    : '<span class="hint">メンバーを追加すると、ここに並びます。</span>';
  $('fTargetsField').hidden = isEqual();
  $('fHint').textContent = isEqual()
    ? '「全体で一律」なので、入力した金額は全員で負担割合に応じて分けます。'
    : 'お酒を飲まない人や途中参加の人は「対象」から外すと、その品目の負担がなくなります。あとから追加したメンバーは自動で対象に入ります。';
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
    const scope = isEqual() ? '全員で一律' : ex.length ? `${ex.map(nameOf).map(esc).join('・')}を除く` : '全員';
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

function renderMode(r) {
  document.querySelectorAll('#modeSwitch button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.mode === 'equal') === r.equal)));
  $('modeDesc').textContent = r.equal
    ? '支払いの合計を、全員で負担割合に応じて分けます。品目ごとの「対象」は使いません。'
    : '品目ごとに、誰が負担するか（対象）を選べます。対象になった人で均等に分けます。';
  $('weightsBox').hidden = !r.equal;
  if (!r.equal) return;
  const box = $('weights');
  if (!S.people.length) { box.innerHTML = '<span class="hint">メンバーを追加すると、ここで割合を変えられます。</span>'; return; }
  const focused = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (!focused || box.querySelectorAll('.w-row').length !== S.people.length) {
    box.innerHTML = r.rows.map(x => `
      <div class="w-row ${x.id === me ? 'me' : ''}">
        <span class="w-name">${esc(x.name)}</span>
        <span class="w-ctl">
          <button class="w-btn" type="button" data-wstep="-0.1" data-wid="${esc(x.id)}" aria-label="${esc(x.name)}の割合を下げる">−</button>
          <input type="number" inputmode="decimal" min="0" max="10" step="0.1" id="w-${esc(x.id)}" data-wid="${esc(x.id)}" value="${fmtW(x.weight)}" aria-label="${esc(x.name)}の負担割合">
          <button class="w-btn" type="button" data-wstep="0.1" data-wid="${esc(x.id)}" aria-label="${esc(x.name)}の割合を上げる">＋</button>
        </span>
        <span class="w-amt num" data-share="${esc(x.id)}">${yen(x.owed)}</span>
      </div>`).join('');
  } else {
    r.rows.forEach(x => { const el = box.querySelector(`[data-share="${CSS.escape(x.id)}"]`); if (el) el.textContent = yen(x.owed); });
  }
}

function renderResult(r) {
  $('rTitle').textContent = (S.meta.title || '（イベント名なし）') + '　' + S.people.length + '人';
  $('total').textContent = yen(r.total);
  $('perHead').textContent = yen(Math.round(r.perHead / r.unit) * r.unit);
  $('perHeadLabel').textContent = r.equal ? '割合1の人の負担' : '1人あたり（全員対象の場合）';
  $('summary').innerHTML = r.rows.length ? r.rows.map(x => `
    <tr class="${x.id === me ? 'me' : ''}"><td>${esc(x.name)}${r.equal && x.weight !== 1 ? `<span class="wtag">×${fmtW(x.weight)}</span>` : ''}</td><td class="num">${yen(x.paid)}</td><td class="num">${yen(x.owed)}</td>
    <td class="num ${x.bal > 0.5 ? 'pos' : x.bal < -0.5 ? 'neg' : ''}">${signed(x.bal)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="note">メンバーを追加すると表示されます</td></tr>';
  $('transfers').innerHTML = r.transfers.length ? r.transfers.map(t => `
    <li class="${t.fromId === me || t.toId === me ? 'me' : ''}"><span class="who">${esc(t.from)}</span><span class="arrow">→</span><span class="who">${esc(t.to)}</span><span class="amt">${yen(t.amount)}</span></li>`).join('')
    : `<li class="msg">${r.total > 0 ? '送金は不要です。全員ぴったり。' : '支払いが入力されると、ここに送金リストが出ます'}</li>`;
  const notes = ['差額がプラスの人は受け取り、マイナスの人は支払いです。'];
  if (r.unit > 1 && r.transfers.length) notes.push(`送金額は${r.unit}円単位に丸めています（丸めの誤差 合計${signed(r.diff)}）。`);
  if (r.equal && r.rows.some(x => x.weight !== 1)) notes.push('負担割合を変えている人がいます（一覧の割合を参照）。');
  if (r.orphan) notes.push(r.equal && r.sumW <= 0
    ? '⚠ 全員の負担割合が0なので、分けられません。'
    : '⚠ 払った人が削除されたか、対象者が誰もいない品目があり、その分は計算に入っていません。');
  $('roundNote').textContent = notes.join(' ');
  document.querySelectorAll('.units button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.unit) === r.unit)));
}

function renderAll() {
  if (S.eventMissing) {
    $('main').hidden = true; $('titleBox').hidden = true;
    forgetRecent(eventId);
    setStatus('warn', 'この割り勘のページは見つかりませんでした。リンクが途中で切れていないか確認してください。');
    return;
  }
  if (document.activeElement !== $('title')) $('title').value = S.meta.title || '';
  document.title = (S.meta.title ? S.meta.title + '｜' : '') + 'みんなの割り勘';
  const r = compute();
  renderMe(r); renderMembers(); renderMode(r); renderForm(); renderItems(); renderResult(r);
}

function buildText() {
  const r = compute();
  const L = [`【${S.meta.title || '割り勘'} 精算】`, `合計 ${yen(r.total)} ／ ${S.people.length}人`, `割り方：${r.equal ? '全体で一律（負担割合あり）' : '品目ごと'}`, '', '▼ 支払い'];
  S.items.filter(it => Number(it.amount) > 0).forEach(it => {
    const ex = r.equal ? [] : (it.excluded || []).filter(id => S.people.some(p => p.id === id));
    L.push(`・${it.name || '品目'} ${yen(it.amount)}　${nameOf(it.payer)}立替${ex.length ? `（${ex.map(nameOf).join('・')}を除く）` : ''}`);
  });
  L.push('', '▼ 各自の負担');
  r.rows.forEach(x => L.push(`・${x.name} ${yen(Math.round(x.owed / r.unit) * r.unit)}${r.equal && x.weight !== 1 ? `（割合 ×${fmtW(x.weight)}）` : ''}`));
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
    const v = toHalf($('newMember').value.trim());
    if (!v || !store) return;
    // 数字だけなら人数とみなして A, B, C… を自動で追加
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      if (n < 1 || n > 50) { flash('memberToast', '人数は1〜50で入れてください。', true); return; }
      const names = nextLetterNames(n);
      $('newMember').value = '';
      const base = Date.now();
      for (let k = 0; k < names.length; k++) {
        if (!await write(() => store.addPerson(names[k], base + k), null, { toast: 'memberToast' })) return;
      }
      flash('memberToast', `${names[0]}〜${names[names.length - 1]}の${names.length}人を追加しました。名前を押すと変えられます。`);
      return;
    }
    if (v.length > 20) { flash('memberToast', '名前は20文字までです。', true); return; }
    if (S.people.some(p => p.name === v)) { $('newMember').select(); flash('memberToast', `${v}さんはもう登録されています。`, true); return; }
    $('newMember').value = '';
    await write(() => store.addPerson(v), null, { toast: 'memberToast' });
    $('newMember').focus();
  });

  $('members').addEventListener('click', e => {
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const p = S.people.find(x => x.id === rn.dataset.rename); if (!p) return;
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'rename-input'; input.value = p.name; input.maxLength = 20;
      input.setAttribute('aria-label', '新しい名前');
      rn.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async save => {
        if (done) return; done = true;
        const v = input.value.trim();
        input.remove();
        if (save && v && v !== p.name) {
          if (S.people.some(x => x.id !== p.id && x.name === v)) flash('memberToast', `${v}さんはもう登録されています。`, true);
          else await write(() => store.renamePerson(p.id, v), null, { toast: 'memberToast' });
        }
        renderAll();
      };
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } if (ev.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
      return;
    }
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

  $('modeSwitch').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]'); if (!b || !store) return;
    if ((b.dataset.mode === 'equal') === isEqual()) return;
    write(() => store.setMeta({ mode: b.dataset.mode }), null, { toast: 'modeToast', denied: RULES_OLD });
  });

  const saveWeight = (pid, v) => {
    if (!Number.isFinite(v)) return;
    const w = Math.min(10, Math.max(0, Math.round(v * 10) / 10));
    const p = S.people.find(x => x.id === pid);
    if (!p || weightOf(p) === w) { renderAll(); return; }
    write(() => store.setWeight(pid, w), null, { toast: 'modeToast', denied: RULES_OLD });
  };
  $('weights').addEventListener('click', e => {
    const b = e.target.closest('[data-wstep]'); if (!b) return;
    const p = S.people.find(x => x.id === b.dataset.wid); if (!p) return;
    saveWeight(p.id, weightOf(p) + Number(b.dataset.wstep));
  });
  $('weights').addEventListener('change', e => {
    const id = e.target.dataset && e.target.dataset.wid; if (!id || e.target.tagName !== 'INPUT') return;
    saveWeight(id, e.target.value === '' ? 1 : Number(e.target.value));
  });
  $('weights').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });

  document.querySelector('.units').addEventListener('click', e => {
    const u = Number(e.target.dataset.unit); if (!u || !store) return;
    write(() => store.setMeta({ unit: u }));
  });

  $('deleteEvent').addEventListener('click', async () => {
    const btn = $('deleteEvent');
    if (!arm('event', btn, 'もう一度押すと全員分を削除します')) return;
    btn.disabled = true;
    deleting = true;
    try {
      await store.deleteEvent();
      forgetRecent(eventId);
      lsSet(meKey, '');
      location.href = './';
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      deleting = false;
      flash('deleteToast', '削除できませんでした。通信状態を確認して、もう一度押してください。', true);
    }
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
  const renderRecent = () => {
    const list = recentList();
    $('recentBox').hidden = !list.length;
    $('recent').innerHTML = list.map(r => `
      <div class="recent-row">
        <a href="?e=${encodeURIComponent(r.id)}">${esc(r.title)}</a>
        <button class="btn small" type="button" data-forget="${esc(r.id)}">一覧から外す</button>
      </div>`).join('');
  };
  renderRecent();
  $('recent').addEventListener('click', e => {
    const btn = e.target.closest('[data-forget]'); if (!btn) return;
    forgetRecent(btn.dataset.forget);
    renderRecent();
  });
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
