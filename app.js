'use strict';
/* העסק שלי - יומן שעות, הוצאות, חשבוניות ודיווחים. כל הנתונים נשמרים על המכשיר בלבד. */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const r2 = n => Math.round((n || 0) * 100) / 100;
const money = n => r2(n).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₪';
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : 0; };
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const mLabel = k => { const [y, m] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const fmtDate = s => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
const addMonths = (k, n) => { const [y, m] = k.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const endOfMonth = k => { const [y, m] = k.split('-').map(Number); return ymd(new Date(y, m, 0)); };
let toastT;
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2600); }

/* ---------- אחסון ---------- */
let _db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('bizdb', 1);
    r.onupgradeneeded = () => { const d = r.result; ['shifts', 'expenses', 'invoices', 'custom'].forEach(s => d.createObjectStore(s, { keyPath: 'id', autoIncrement: true })); d.createObjectStore('kv'); };
    r.onsuccess = () => { _db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (s, m = 'readonly') => _db.transaction(s, m).objectStore(s);
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbAll = s => rq(tx(s).getAll());
const dbPut = (s, o) => rq(tx(s, 'readwrite').put(o));
const dbDel = (s, id) => rq(tx(s, 'readwrite').delete(id));
const kvGet = async (k, d) => { const v = await rq(tx('kv').get(k)); return v === undefined ? d : v; };
const kvSet = (k, v) => rq(tx('kv', 'readwrite').put(v, k));

const DEF = { rate: 200, ovh: 15, vat: 18, credit: 45, setAside: 30, vatPeriod: 2, vatStart: 1, vatDay: 15, advDay: 15, blDay: 15, annual: '04-30' };
const D = { shifts: [], expenses: [], invoices: [], custom: [], st: { ...DEF }, active: null, done: {}, lastBackup: null };
async function load() {
  for (const s of ['shifts', 'expenses', 'invoices', 'custom']) D[s] = await dbAll(s);
  D.st = { ...DEF, ...(await kvGet('settings', {})) };
  D.active = await kvGet('active', null);
  D.done = await kvGet('done', {});
  D.lastBackup = await kvGet('lastBackup', null);
  D.started = await kvGet('started', null);
  if (!D.started) { D.started = todayStr(); await kvSet('started', D.started); }
}

/* ---------- חישובים ---------- */
function shiftHours(s) {
  if (!s.start || !s.end) return 0;
  const [a, b] = s.start.split(':').map(Number), [c, d] = s.end.split(':').map(Number);
  const m = (c * 60 + d) - (a * 60 + b);
  return m > 0 ? m / 60 : 0;
}
const isOral = s => s.type === 'נסיעה' || (s.type || '').startsWith('ברצף');
function expCalc(e) {
  const rate = (e.vatRate ?? 18) / 100;
  const total = e.total || 0;
  const vatIn = rate > 0 ? total - total / (1 + rate) : 0;
  const rec = e.hasInvoice ? vatIn * ((e.vatPct ?? 100) / 100) : 0;
  const recog = (total - rec) * ((e.recogPct ?? 100) / 100);
  return { vatIn, rec, recog, net: total - vatIn };
}
function monthCalc(key) {
  const st = D.st;
  const sh = D.shifts.filter(s => s.date.startsWith(key));
  const hApproved = sh.filter(s => s.approved && !isOral(s)).reduce((a, s) => a + shiftHours(s), 0);
  const hPending = sh.filter(s => !s.approved && !isOral(s)).reduce((a, s) => a + shiftHours(s), 0);
  const hOral = sh.filter(isOral).reduce((a, s) => a + shiftHours(s), 0);
  const oralNet = hOral * st.rate * (1 - st.ovh / 100);
  const gross = hApproved * st.rate, ovh = gross * st.ovh / 100, net = gross - ovh, vat = net * st.vat / 100;
  const ex = D.expenses.filter(e => e.date.startsWith(key));
  const recog = ex.reduce((a, e) => a + expCalc(e).recog, 0);
  const inVat = ex.reduce((a, e) => a + expCalc(e).rec, 0);
  const setAside = Math.max(0, net - recog) * st.setAside / 100;
  return { hApproved, hPending, hOral, oralNet, gross, ovh, net, vat, total: net + vat, recog, inVat, setAside, pay: addDays(endOfMonth(key), st.credit), inv: D.invoices.find(i => i.forMonth === key) };
}
function periodMonths(key) {
  const st = D.st;
  if (st.vatPeriod === 1) return [key];
  const [y, m] = key.split('-').map(Number);
  const k = ((m - st.vatStart) % 2 === 0) ? key : addMonths(key, -1);
  return [k, addMonths(k, 1)];
}
function vatReport(months) {
  const inP = d => d && months.some(k => d.startsWith(k));
  const invs = D.invoices.filter(i => inP(i.invoiceDate));
  const sales = invs.reduce((a, i) => a + i.net, 0), salesVat = invs.reduce((a, i) => a + i.net * D.st.vat / 100, 0);
  const ex = D.expenses.filter(e => inP(e.date));
  const inNet = ex.filter(e => e.hasInvoice).reduce((a, e) => a + expCalc(e).net, 0);
  const inVat = ex.reduce((a, e) => a + expCalc(e).rec, 0);
  return { invs, sales, salesVat, inNet, inVat, payable: salesVat - inVat, n: invs.length };
}

/* ---------- מדריכים ---------- */
const GUIDES = {
  vat: ['לוודא שכל החשבוניות שהוצאת ושכל חשבוניות ההוצאות של התקופה הוזנו באפליקציה.', 'במסך "דיווחים" לבחור את התקופה. המספרים מוכנים שם להעתקה.', 'להיכנס לאתר רשות המסים, לאזור האישי של העוסק, ולדיווח מע"מ מקוון. בפעם הראשונה כדאי לעשות זאת יחד עם רואה החשבון.', 'להזין: עסקאות חייבות (נטו), מע"מ עסקאות, ותשומות (נטו ומע"מ). שמות השדות בטופס עשויים להיות מעט שונים.', 'אם לא היו עסקאות בתקופה, מגישים "דוח אפס" ולא מדלגים.', 'אם יוצא מע"מ לתשלום, משלמים דרך האתר או הבנק לפי ההוראות בטופס. אם יוצא לקבל, אין לשלם.', 'לשמור את אישור ההגשה ואת אסמכתת התשלום, ולסמן כאן "בוצע".'],
  adv: ['לבדוק באזור האישי באתר רשות המסים מה הסכום והמועד של מקדמת מס ההכנסה שנקבעה לך.', 'לשלם דרך האתר, אפליקציית הבנק או כרטיס אשראי.', 'לשמור אסמכתא בתיקיית החודש, ולסמן כאן "בוצע".', 'אם ההכנסה שלך שונה מאוד ממה שהוערך, לדבר עם רואה החשבון על עדכון המקדמות.'],
  bl: ['לבדוק באתר הביטוח הלאומי, באזור האישי, את הסכום והמועד של דמי הביטוח כעצמאי.', 'לשלם דרך האתר, הבנק או בהוראת קבע.', 'לשמור אסמכתא ולסמן כאן "בוצע".', 'אם יש שינוי במצבך (אבטלה, חזרה לעבודה כשכיר), לדווח על כך לביטוח הלאומי.'],
  hrs: ['לסכם את שעות החודש לפי היומן.', 'לשלוח את הסיכום למנהל המרפאה לאישור, ועדיף בכתב.', 'לסמן באפליקציה "אושר" ליד השעות שאושרו.', 'לשמור את האישור. התשלום תלוי בו.'],
  pay: ['לבדוק שהתשלום נכנס לחשבון העסק.', 'להשוות לפירוט שכללית שלחה על חישוב התמורה.', 'להוציא חשבונית מס כדין בתוכנת החשבוניות, תוך שבועיים מקבלת התשלום (לפי ההסכם).', 'לתעד באפליקציה במסך "חשבוניות" ולשמור עותק PDF.', 'אם הסכום שונה ממה שצפית, להגיש השגה להנהלת המחוז בכתב תוך 180 יום.'],
  ann: ['הדוח השנתי למס הכנסה נעשה עם רואה החשבון.', 'להעביר לו את הייצוא של השנה (יומן שעות, חשבוניות, הוצאות עם תמונות) ואישור ניכוי מס במקור מכללית.', 'לשאול על פנסיה, קרן השתלמות והוצאות שנשארו פתוחות.'],
  bak: ['לפתוח "הגדרות" ולהקיש "ייצוא גיבוי".', 'לשמור את הקובץ בענן או במחשב. כך הנתונים שלך לא נעלמים אם הטלפון אובד.']
};
const KIND = { vat: 'דיווח מע"מ', adv: 'תשלום מקדמת מס הכנסה', bl: 'תשלום ביטוח לאומי', hrs: 'אישור שעות', pay: 'בדיקת תשלום והוצאת חשבונית', ann: 'דוח שנתי', bak: 'גיבוי' };

function upcoming(from, months = 14) {
  const st = D.st, out = [];
  const startKey = from.slice(0, 7);
  for (let i = -2; i < months; i++) {
    const k = addMonths(startKey, i);
    const m = Number(k.split('-')[1]);
    const isPeriodEnd = st.vatPeriod === 1 || ((m - st.vatStart) % 2 === 1 || (m - st.vatStart) % 2 === -1);
    if (isPeriodEnd) {
      const per = periodMonths(k), due = `${addMonths(k, 1)}-${pad(st.vatDay)}`;
      out.push({ id: 'vat-' + per[0], date: due, kind: 'vat', title: `דיווח מע"מ: ${per.map(mLabel).join(' + ')}`, desc: `לדווח על ${per.map(mLabel).join(' ו-')}` });
      out.push({ id: 'adv-' + per[0], date: `${addMonths(k, 1)}-${pad(st.advDay)}`, kind: 'adv', title: `מקדמת מס הכנסה: ${per.map(mLabel).join(' + ')}`, desc: 'סכום ומועד לפי רשות המסים' });
    }
    out.push({ id: 'bl-' + k, date: `${addMonths(k, 1)}-${pad(st.blDay)}`, kind: 'bl', title: `ביטוח לאומי: ${mLabel(k)}`, desc: 'סכום ומועד לפי הביטוח הלאומי' });
    out.push({ id: 'hrs-' + k, date: endOfMonth(k), kind: 'hrs', title: `אישור שעות: ${mLabel(k)}`, desc: 'לקבל אישור מהמנהל' });
    const mc = monthCalc(k);
    if (!mc.inv && (mc.hApproved > 0 || mc.hPending > 0)) out.push({ id: 'pay-' + k, date: mc.pay, kind: 'pay', title: `בדיקת תשלום והוצאת חשבונית: ${mLabel(k)}`, desc: `צפוי ${money(mc.net)} + מע"מ` });
  }
  const y = Number(startKey.split(' ')[0].split('-')[0]);
  for (const yy of [y - 1, y, y + 1]) out.push({ id: 'ann-' + yy, date: `${yy + 1}-${st.annual}`, kind: 'ann', title: `דוח שנתי של ${yy}`, desc: 'עם רואה החשבון' });
  const lb = D.lastBackup || '2000-01-01';
  out.push({ id: 'bak-' + addDays(lb, 14), date: addDays(lb, 14), kind: 'bak', title: 'גיבוי נתונים', desc: 'ייצוא קובץ גיבוי' });
  D.custom.forEach(c => out.push({ id: 'c-' + c.id, date: c.date, kind: 'custom', title: c.title, desc: c.note || '' }));
  return out.filter(e => e.date >= D.started && e.date >= addDays(from, -60)).sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- OCR מקומי ---------- */
let _worker, ocrProg = () => { };
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function prepImages(file) {
  const bmp = await createImageBitmap(file);
  const scale = (max) => Math.min(1, max / Math.max(bmp.width, bmp.height));
  const mk = (max, filter, q) => new Promise(res => {
    const sc = scale(max), c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    const x = c.getContext('2d'); x.filter = filter; x.drawImage(bmp, 0, 0, c.width, c.height); c.toBlob(res, 'image/jpeg', q);
  });
  return { ocr: await mk(1800, 'grayscale(1) contrast(1.35)', 0.9), keep: await mk(1400, 'none', 0.72) };
}
async function ocrImage(blob) {
  if (!window.Tesseract) await loadScript('lib/tesseract.min.js');
  const base = new URL('lib/', location.href).href;
  if (!_worker) _worker = await Tesseract.createWorker(['heb', 'eng'], 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang', gzip: true, logger: m => ocrProg(m) });
  const r = await _worker.recognize(blob);
  return r.data.text;
}
function nums(line) {
  const out = [], re = /(\d{1,3}(?:[,\s]\d{3})+|\d+)[.,](\d{2})(?!\d)/g; let m;
  while ((m = re.exec(line))) out.push(parseFloat(m[1].replace(/[,\s]/g, '') + '.' + m[2]));
  return out;
}
function parseInvoice(text, vatPct) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean), res = { warnings: [], suggestions: [] };
  const kw = /סה["״'׳]?כ|סהכ|לתשלום|total|amount\s*due|סכום/i;
  let tl = lines.filter(l => kw.test(l) && nums(l).length);
  const strict = tl.filter(l => !/לפני|before|ללא|net/i.test(l)); if (strict.length) tl = strict;
  const tnums = tl.flatMap(nums), all = lines.flatMap(nums);
  res.total = tnums.length ? Math.max(...tnums) : (all.length ? Math.max(...all) : null);
  res.suggestions = [...new Set([...tnums.sort((a, b) => b - a), ...all.sort((a, b) => b - a)])].slice(0, 5);
  const vl = lines.filter(l => /מע["״'׳]?מ|vat/i.test(l)).flatMap(nums);
  if (vl.length) {
    const exp = res.total ? res.total * vatPct / (100 + vatPct) : null;
    res.vat = exp ? vl.reduce((a, b) => Math.abs(b - exp) < Math.abs(a - exp) ? b : a) : vl[0];
  }
  const dm = text.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/g) || [];
  for (const s of dm) {
    const [d, m, y0] = s.split(/[\/.\-]/).map(Number), y = y0 < 100 ? 2000 + y0 : y0;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2035) { res.date = `${y}-${pad(m)}-${pad(d)}`; break; }
  }
  const im = text.match(/(?:חשבונית(?:\s*מס)?(?:\s*קבלה)?|invoice|מס['״׳]?)[^\d\n]{0,15}(\d{3,})/i); if (im) res.invNo = im[1];
  const sup = lines.find(l => /[A-Za-zא-ת]{3,}/.test(l) && !/חשבונית|invoice|תאריך|עוסק|ח\.?פ|סה|מע["״'׳]?מ|סכום|total|\d{3,}/i.test(l)); if (sup) res.supplier = sup.replace(/[^\wא-ת\s'".\-&]/g, '').trim().slice(0, 40);
  res.taxInvoice = /חשבונית\s*מס/.test(text);
  if (res.total == null) res.warnings.push('לא זוהה סכום בתמונה. כדאי להזין ידנית או לצלם שוב מקרוב ובתאורה טובה.');
  if (res.total != null && res.vat != null) {
    const exp = res.total * vatPct / (100 + vatPct);
    if (Math.abs(exp - res.vat) > 0.1) {
      const implied = res.vat * (100 + vatPct) / vatPct, near = res.suggestions.find(n => Math.abs(n - implied) <= 0.1);
      res.warnings.push(`המע"מ שזוהה (${money(res.vat)}) לא מתאים לסכום (${money(res.total)}) לפי ${vatPct}%. ` + (near ? `יכול להיות שהסכום הנכון הוא ${money(near)}.` : `לפי הסכום המע"מ אמור להיות כ-${money(exp)}. כדאי לבדוק מול החשבונית.`));
      if (near) res.fix = near;
    }
  }
  if (!res.taxInvoice) res.warnings.push('לא נמצא בתמונה הכיתוב "חשבונית מס". אם זו קבלה בלבד, אי אפשר לקזז עליה מע"מ. כדאי לבקש מהספק חשבונית מס על שם העסק.');
  return res;
}

/* ---------- ממשק ---------- */
const TABS = [['home', '🏠', 'היום'], ['hours', '⏱', 'שעות'], ['exp', '🧾', 'הוצאות'], ['inv', '📄', 'חשבוניות'], ['rep', '📅', 'דיווחים'], ['set', '⚙️', 'עוד']];
const S = { tab: 'home', month: todayStr().slice(0, 7), form: null, guide: null, rep: null };
const CATS = { 'ביטוח אחריות מקצועית': [100, 100], 'דמי חבר ארגון מקצועי': [100, 100], 'השתלמויות וכנסים': [100, 100], 'ספרות מקצועית ומנויים': [100, 100], 'ציוד רפואי קטן': [100, 100], 'תוכנה ומנויים': [100, 100], 'רואה חשבון והנהלת חשבונות': [100, 100], 'עמלות בנק': [0, 100], 'ציוד משרדי': [100, 100], 'טלפון ואינטרנט (לשאול רו"ח)': [0, 0], 'רכב ודלק (לשאול רו"ח)': [0, 0], 'חדר בבית (לשאול רו"ח)': [0, 0], 'נסיעות ציבוריות/חניה': [100, 100], 'אחר (לשאול רו"ח)': [0, 0] };
const main = () => $('#main');

function renderNav() {
  $('#nav').innerHTML = TABS.map(([k, i, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}" aria-label="${l}"><b>${i}</b>${l}</button>`).join('');
}
function monthNav() {
  return `<div class="row" style="margin-bottom:10px"><button class="btn sec sm" data-act="mprev" style="flex:0">›</button><b style="text-align:center">${mLabel(S.month)}</b><button class="btn sec sm" data-act="mnext" style="flex:0">‹</button></div>`;
}
async function render() {
  renderNav();
  const T = { home: viewHome, hours: viewHours, exp: viewExp, inv: viewInv, rep: viewRep, set: viewSet }[S.tab];
  $('#title').textContent = TABS.find(t => t[0] === S.tab)[2];
  $('#sub').textContent = '';
  main().innerHTML = T();
  if (S.tab === 'exp' && S.form && S.form.kind === 'exp') bindExpForm();
}

/* --- בית --- */
function viewHome() {
  const t = todayStr(), mc = monthCalc(t.slice(0, 7));
  const ev = upcoming(t).filter(e => !D.done[e.id] && e.date <= addDays(t, 21));
  const a = D.active;
  const evHtml = ev.length ? ev.map(e => {
    const d = daysBetween(t, e.date), cls = d < 0 ? 'bad' : d <= 3 ? 'warn' : '';
    return `<div class="item"><div class="l"><b>${esc(e.title)}</b><div class="mut">${fmtDate(e.date)}</div></div><div class="r"><span class="pill ${cls}">${d < 0 ? `באיחור ${-d} ימים` : d === 0 ? 'היום' : `בעוד ${d} ימים`}</span><div><button class="btn sec sm" data-act="guide" data-id="${esc(e.id)}">איך עושים</button></div></div></div>`;
  }).join('') : '<p class="mut">אין משימות קרובות.</p>';
  const unapproved = D.shifts.filter(s => !s.approved && s.end && s.date < addDays(t, -3)).length;
  return `
  <div class="card"><h2>${a ? 'משמרת פעילה' : 'להתחיל משמרת'}</h2>
  ${a ? `<p>התחלת ב-${a.start} ${a.clinic ? `ב${esc(a.clinic)}` : ''}</p><button class="btn acc" data-act="stop" style="width:100%">סיימתי</button>` :
      `<label for="c0">מרפאה</label><input id="c0" list="clinics" placeholder="שם המרפאה"><datalist id="clinics">${[...new Set(D.shifts.map(s => s.clinic).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist><button class="btn" data-act="start" style="width:100%;margin-top:10px">התחלתי</button>`}
  </div>
  <div class="card"><h2>${mLabel(t.slice(0, 7))} עד עכשיו</h2>
    <div class="row"><div><div class="mut">שעות מאושרות</div><div class="big">${r2(mc.hApproved)}</div></div><div><div class="mut">ממתינות לאישור</div><div class="big">${r2(mc.hPending)}</div></div></div>
    <div class="mut" style="margin-top:8px">צפוי נטו לפני מע"מ: <b>${money(mc.net)}</b> · תשלום משוער ב-${fmtDate(mc.pay)}</div>
    ${mc.hOral ? `<div class="mut" style="margin-top:6px">בנוסף, <b>${r2(mc.hOral)} שעות</b> נסיעה/ברצף שלא אושרו בכתב (פוטנציאל כ-${money(mc.oralNet)})</div>` : ''}</div>
  ${unapproved ? `<div class="note warn">יש ${unapproved} משמרות ללא אישור מהמנהל מלפני יותר משלושה ימים. כדאי לבקש אישור.</div>` : ''}
  <div class="card"><h2>מה לעשות בקרוב</h2>${evHtml}</div>
  <div class="note">התזכורות כאן מופיעות כשהאפליקציה פתוחה. כדי לקבל התראה גם כשהיא סגורה, ייצא אותן ליומן הטלפון במסך "דיווחים".</div>`;
}

/* --- שעות --- */
function shiftForm(s) {
  s = s || { date: todayStr(), start: '', end: '', clinic: '', type: 'מרפאה', approved: false };
  return `<div class="card"><h2>${s.id ? 'עריכת משמרת' : 'משמרת חדשה'}</h2>
  <label>תאריך</label><input type="date" id="f_date" value="${s.date}">
  <div class="row"><div><label>התחלה</label><input type="time" id="f_start" value="${s.start}"></div><div><label>סיום</label><input type="time" id="f_end" value="${s.end || ''}"></div></div>
  <label>מרפאה / מקום</label><input id="f_clinic" value="${esc(s.clinic)}">
  <label>סוג</label><select id="f_type">${['מרפאה', 'נסיעה', 'ברצף (בין מרפאות)', 'אחר'].map(t => `<option ${t === s.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
  <label><input type="checkbox" id="f_appr" ${s.approved ? 'checked' : ''}> אושר ע"י המנהל</label>
  <div class="note warn">נסיעות ותשלום ברצף הן הבטחות בעל פה שלא כתובות בחוזה. רשום אותן בנפרד כדי שאפשר יהיה לדרוש אם יאושרו בכתב.</div>
  <div class="row"><button class="btn" data-act="saveShift" data-id="${s.id || ''}">שמור</button><button class="btn sec" data-act="cancel">ביטול</button>${s.id ? `<button class="btn danger" data-act="delShift" data-id="${s.id}">מחק</button>` : ''}</div></div>`;
}
function viewHours() {
  if (S.form && S.form.kind === 'shift') return shiftForm(S.form.data);
  const list = D.shifts.filter(s => s.date.startsWith(S.month)).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  const mc = monthCalc(S.month);
  const dayTot = {}; list.forEach(s => dayTot[s.date] = (dayTot[s.date] || 0) + shiftHours(s));
  let lastDay = '';
  const rows = list.map(s => {
    const head = s.date !== lastDay ? `<div class="mut" style="padding-top:10px"><b>${fmtDate(s.date)}</b> · סה"כ ביום ${r2(dayTot[s.date])} ש'</div>` : ''; lastDay = s.date;
    const pill = isOral(s) ? '<span class="pill bad">לא אושר בכתב</span>' : `<span class="pill ${s.approved ? 'ok' : 'warn'}">${s.approved ? 'אושר' : 'ממתין'}</span>`;
    return head + `<div class="item" data-act="editShift" data-id="${s.id}" role="button" tabindex="0"><div class="l">${esc(s.clinic)}<div class="mut">${s.start}–${s.end || '...'} · ${esc(s.type)}</div></div><div class="r"><b>${r2(shiftHours(s))}</b> ש'<div>${pill}</div></div></div>`;
  }).join('');
  return monthNav() + `<button class="btn" data-act="newShift" style="width:100%;margin-bottom:12px">+ הוספת משמרת ידנית</button>
  <div class="card"><div class="row"><div><div class="mut">מאושרות</div><b>${r2(mc.hApproved)} שעות</b></div><div><div class="mut">ממתינות לאישור</div><b>${r2(mc.hPending)} שעות</b></div></div>
  ${mc.hOral ? `<div class="note warn" style="margin-bottom:0">נסיעות ותשלום ברצף שלא אושרו בכתב: <b>${r2(mc.hOral)} שעות</b>. אם יאושרו באותו תעריף, זה כ-${money(mc.oralNet)} נטו נוסף. הן לא נכללות בהכנסה הצפויה.</div>` : ''}</div>
  <div class="card">${list.length ? rows : '<p class="mut">אין משמרות בחודש הזה.</p>'}</div>`;
}

/* --- הוצאות --- */
function expForm(e) {
  e = e || { date: todayStr(), supplier: '', desc: '', category: Object.keys(CATS)[0], invNo: '', hasInvoice: true, total: '', vatRate: D.st.vat, vatPct: 100, recogPct: 100, note: '' };
  const url = e.image ? URL.createObjectURL(e.image) : '';
  return `<div class="card"><h2>${e.id ? 'עריכת הוצאה' : 'הוצאה חדשה'}</h2>
  <label for="f_img">צילום או קובץ של החשבונית</label><input type="file" id="f_img" accept="image/*" capture="environment">
  <div id="ocrbox">${url ? `<img class="thumb" src="${url}" alt="חשבונית">` : ''}</div>
  <label>תאריך</label><input type="date" id="f_date" value="${e.date}">
  <label>ספק</label><input id="f_sup" value="${esc(e.supplier)}">
  <label>תיאור</label><input id="f_desc" value="${esc(e.desc)}">
  <label>קטגוריה</label><select id="f_cat">${Object.keys(CATS).map(c => `<option ${c === e.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
  <label>מספר חשבונית</label><input id="f_inv" value="${esc(e.invNo)}">
  <label>חשבונית מס על שם העסק שלי?</label><select id="f_has"><option value="1" ${e.hasInvoice ? 'selected' : ''}>כן</option><option value="0" ${!e.hasInvoice ? 'selected' : ''}>לא (קבלה בלבד, או חשבונית על שם אחר)</option></select>
  <label>סכום ששולם כולל מע"מ</label><input id="f_tot" inputmode="decimal" value="${e.total}">
  <div class="row"><div><label>שיעור מע"מ בחשבונית %</label><input id="f_rate" inputmode="decimal" value="${e.vatRate}"></div><div><label>% מע"מ לקיזוז</label><input id="f_vp" inputmode="decimal" value="${e.vatPct}"></div><div><label>% הוכר למס הכנסה</label><input id="f_rp" inputmode="decimal" value="${e.recogPct}"></div></div>
  <label>הערות / לשאול רו"ח</label><input id="f_note" value="${esc(e.note)}">
  <div id="calcline" class="mut" style="margin:8px 0"></div>
  <div class="row"><button class="btn" data-act="saveExp" data-id="${e.id || ''}">שמור</button><button class="btn sec" data-act="cancel">ביטול</button>${e.id ? `<button class="btn danger" data-act="delExp" data-id="${e.id}">מחק</button>` : ''}</div></div>`;
}
function bindExpForm() {
  const upd = () => {
    const tot = num($('#f_tot').value), rate = num($('#f_rate').value) / 100, vat = rate > 0 ? tot - tot / (1 + rate) : 0;
    const e = expCalc({ total: tot, vatRate: num($('#f_rate').value), hasInvoice: $('#f_has').value === '1', vatPct: num($('#f_vp').value), recogPct: num($('#f_rp').value) });
    $('#calcline').textContent = tot ? `מע"מ בחשבונית ${money(vat)} · לקיזוז ${money(e.rec)} · הוצאה מוכרת ${money(e.recog)}` : '';
  };
  ['f_tot', 'f_rate', 'f_has', 'f_vp', 'f_rp'].forEach(id => $('#' + id).addEventListener('input', upd)); upd();
  $('#f_cat').addEventListener('change', () => { const [v, r] = CATS[$('#f_cat').value] || [100, 100]; $('#f_vp').value = v; $('#f_rp').value = r; upd(); });
  $('#f_img').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    const box = $('#ocrbox'); box.innerHTML = '<p class="mut">מעבד את התמונה על המכשיר בלבד. בפעם הראשונה זה לוקח עד דקה.</p><progress id="pg" max="1" value="0"></progress>';
    try {
      const { ocr, keep } = await prepImages(f); S.form.image = keep;
      ocrProg = m => { if (m.progress != null) { const p = $('#pg'); if (p) p.value = m.progress; } };
      const text = await ocrImage(ocr), r = parseInvoice(text, num($('#f_rate').value) || 18);
      const url = URL.createObjectURL(keep);
      const chips = r.suggestions.length ? `<div class="mut">סכומים שנמצאו, הקש לבחירה:</div><div class="chips">${r.suggestions.map(n => `<button type="button" data-pick="${n}">${money(n)}</button>`).join('')}</div>` : '';
      box.innerHTML = `<img class="thumb" src="${url}" alt="חשבונית">` + chips + r.warnings.map(w => `<div class="note warn">${esc(w)}</div>`).join('') + (r.fix ? `<button type="button" class="btn sec sm" data-pick="${r.fix}">תקן לסכום ${money(r.fix)}</button>` : '') + `<div class="note ok">הנתונים מולאו אוטומטית. תבדוק מול החשבונית לפני שמירה.</div>`;
      if (r.total != null) $('#f_tot').value = r.fix ?? r.total;
      if (r.date) $('#f_date').value = r.date;
      if (r.supplier && !$('#f_sup').value) $('#f_sup').value = r.supplier;
      if (r.invNo && !$('#f_inv').value) $('#f_inv').value = r.invNo;
      $('#f_has').value = r.taxInvoice ? '1' : '0'; upd();
    } catch (err) { box.innerHTML = `<div class="note warn">הקריאה האוטומטית נכשלה (${esc(err.message || err)}). אפשר להזין ידנית. התמונה תישמר.</div>`; }
  });
  $('#ocrbox').addEventListener('click', ev => { const b = ev.target.closest('[data-pick]'); if (b) { $('#f_tot').value = b.dataset.pick; upd(); } });
}
function viewExp() {
  if (S.form && S.form.kind === 'exp') return expForm(S.form.data);
  const list = D.expenses.filter(e => e.date.startsWith(S.month)).sort((a, b) => b.date.localeCompare(a.date));
  const mc = monthCalc(S.month);
  return monthNav() + `<button class="btn" data-act="newExp" style="width:100%;margin-bottom:12px">📷 הוצאה חדשה מתמונה</button>
  <div class="card"><div class="row"><div><div class="mut">הוצאות מוכרות</div><b>${money(mc.recog)}</b></div><div><div class="mut">מע"מ תשומות</div><b>${money(mc.inVat)}</b></div></div></div>
  <div class="card">${list.length ? list.map(e => { const c = expCalc(e); return `<div class="item" data-act="editExp" data-id="${e.id}" role="button" tabindex="0"><div class="l"><b>${esc(e.supplier || e.desc || 'הוצאה')}</b><div class="mut">${fmtDate(e.date)} · ${esc(e.category)}</div>${e.recogPct === 0 || (e.hasInvoice && e.vatPct === 0) ? '<span class="pill warn">ממתין לרו"ח</span>' : ''}${!e.hasInvoice ? '<span class="pill bad">אין חשבונית מס</span>' : ''}</div><div class="r"><b>${money(e.total)}</b><div class="mut">מוכר ${money(c.recog)}</div></div></div>`; }).join('') : '<p class="mut">אין הוצאות בחודש הזה.</p>'}</div>`;
}

/* --- חשבוניות --- */
function invForm(i) {
  const mc = monthCalc(i.forMonth);
  return `<div class="card"><h2>${i.id ? 'עריכת חשבונית' : 'חשבונית שהוצאתי'}</h2>
  <label>עבור חודש</label><input type="month" id="f_for" value="${i.forMonth}">
  <label>תאריך החשבונית</label><input type="date" id="f_idate" value="${i.invoiceDate}">
  <label>מספר חשבונית</label><input id="f_ino" value="${esc(i.invoiceNo || '')}">
  <label>סכום נטו לפני מע"מ (לפי פירוט כללית)</label><input id="f_net" inputmode="decimal" value="${i.net ?? r2(mc.net)}">
  <div class="mut">מע"מ ${D.st.vat}%: <b id="vl"></b></div>
  <label>תאריך שהכסף נכנס</label><input type="date" id="f_paid" value="${i.paidDate || ''}">
  <div class="row" style="margin-top:12px"><button class="btn" data-act="saveInv" data-id="${i.id || ''}">שמור</button><button class="btn sec" data-act="cancel">ביטול</button>${i.id ? `<button class="btn danger" data-act="delInv" data-id="${i.id}">מחק</button>` : ''}</div></div>`;
}
function viewInv() {
  if (S.form && S.form.kind === 'inv') return invForm(S.form.data);
  const list = [...D.invoices].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
  const pend = [];
  for (let i = -6; i <= 0; i++) { const k = addMonths(todayStr().slice(0, 7), i), mc = monthCalc(k); if (!mc.inv && (mc.hApproved > 0)) pend.push([k, mc]); }
  return `<button class="btn" data-act="newInv" style="width:100%;margin-bottom:12px">+ תיעוד חשבונית שהוצאתי</button>
  ${pend.length ? `<div class="card"><h2>עוד לא הוצאת חשבונית</h2>${pend.map(([k, mc]) => `<div class="item"><div class="l"><b>${mLabel(k)}</b><div class="mut">צפוי ${money(mc.net)} + מע"מ · תשלום ב-${fmtDate(mc.pay)}</div></div><div class="r"><button class="btn sec sm" data-act="invFor" data-id="${k}">תעד</button></div></div>`).join('')}</div>` : ''}
  <div class="card"><h2>חשבוניות שהוצאתי</h2>${list.length ? list.map(i => `<div class="item" data-act="editInv" data-id="${i.id}" role="button" tabindex="0"><div class="l"><b>${i.invoiceNo ? 'מס׳ ' + esc(i.invoiceNo) : 'חשבונית'}</b><div class="mut">${mLabel(i.forMonth)} · ${fmtDate(i.invoiceDate)}</div></div><div class="r"><b>${money(i.net * (1 + D.st.vat / 100))}</b><div class="mut">נטו ${money(i.net)}</div>${(() => { const ex = monthCalc(i.forMonth).net, df = i.net - ex; return ex > 0 && Math.abs(df) > 0.5 ? `<span class="pill warn">שונה מהצפוי ב-${money(df)}</span>` : ''; })()}</div></div>`).join('') : '<p class="mut">עדיין אין.</p>'}</div>
  <div class="note">החשבונית עצמה מוצאת בתוכנת חשבוניות מוכרת, כי היא חייבת לכלול מספר הקצאה ופרטים לפי החוק. כאן מתעדים אותה כדי שהמע"מ יחושב.</div>`;
}

/* --- דיווחים --- */
function copyRow(label, val) { return `<div class="copy"><span>${label}</span><span><b>${money(val)}</b> <button class="btn sec sm" data-act="copy" data-id="${r2(val)}">העתק</button></span></div>`; }
function viewRep() {
  const t = todayStr();
  if (S.guide) {
    const g = GUIDES[S.guide.kind] || [], ev = S.guide;
    return `<button class="btn sec sm" data-act="back">‹ חזרה</button><div class="card" style="margin-top:10px"><h2>${esc(ev.title || KIND[ev.kind])}</h2><ol class="steps">${g.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    ${ev.id ? `<button class="btn" data-act="done" data-id="${esc(ev.id)}">${D.done[ev.id] ? 'בוצע ✓ (בטל)' : 'סמן כבוצע'}</button>` : ''}</div>
    <div class="note warn">ההוראות כלליות. שמות הטפסים ותאריכי היעד צריכים אימות מול רשות המסים, הביטוח הלאומי ורואה החשבון.</div>`;
  }
  const per = S.rep || periodMonths(addMonths(t.slice(0, 7), -1)), r = vatReport(per);
  const list = upcoming(t).filter(e => e.date >= addDays(t, -30)).slice(0, 40);
  return `<div class="card"><h2>מע"מ: ${per.map(mLabel).join(' + ')}</h2>
  <div class="row"><button class="btn sec sm" data-act="pprev" style="flex:0">›</button><span class="mut" style="text-align:center">${r.n} חשבוניות בתקופה</span><button class="btn sec sm" data-act="pnext" style="flex:0">‹</button></div>
  ${copyRow('עסקאות חייבות (נטו)', r.sales)}${copyRow('מע"מ עסקאות', r.salesVat)}${copyRow('תשומות (נטו)', r.inNet)}${copyRow('מע"מ תשומות לקיזוז', r.inVat)}
  <div class="copy"><b>${r.payable >= 0 ? 'מע"מ לתשלום' : 'מע"מ להחזר'}</b><b class="big">${money(Math.abs(r.payable))}</b></div>
  ${r.n === 0 ? '<div class="note">אין חשבוניות בתקופה. לפי הנחיות הרשות מגישים דוח אפס. כדאי לאמת זאת עם רואה החשבון.</div>' : ''}
  <button class="btn" data-act="guide" data-kind="vat" data-id="vat-${per[0]}" style="width:100%;margin-top:8px">איך מגישים</button></div>
  <div class="card"><h2>לוח מועדים</h2>${list.map(e => { const d = daysBetween(t, e.date); return `<div class="item"><div class="l"><b>${esc(e.title)}</b><div class="mut">${fmtDate(e.date)}</div></div><div class="r">${D.done[e.id] ? '<span class="pill ok">בוצע</span>' : `<span class="pill ${d < 0 ? 'bad' : d <= 3 ? 'warn' : ''}">${d < 0 ? 'איחור' : d + ' ימים'}</span>`}<div><button class="btn sec sm" data-act="guide" data-id="${esc(e.id)}">איך</button></div></div></div>`; }).join('')}</div>
  <div class="card"><h2>תזכורות ביומן הטלפון</h2><p class="mut">מייצא את כל המועדים עם התראה 3 ימים ויום לפני. פותחים את הקובץ בטלפון ומאשרים הוספה ליומן.</p><button class="btn acc" data-act="ics" style="width:100%">ייצוא ליומן</button>
  <label>תזכורת משלי</label><input id="cu_t" placeholder="למשל: לבדוק קרן השתלמות"><input type="date" id="cu_d" style="margin-top:6px"><button class="btn sec" data-act="addCustom" style="margin-top:6px">הוסף</button></div>`;
}

/* --- הגדרות --- */
function viewSet() {
  const s = D.st, f = (id, label, v, extra = '') => `<label for="s_${id}">${label}</label><input id="s_${id}" inputmode="decimal" value="${v}" ${extra}>`;
  return `<div class="card"><h2>תעריפים</h2>${f('rate', 'תעריף לשעה לפני מע"מ', s.rate)}${f('ovh', 'תקורה % (15 או 25, לברר איזה נספח תקף)', s.ovh)}${f('vat', 'מע"מ %', s.vat)}${f('credit', 'ימי אשראי אחרי סוף החודש', s.credit)}${f('setAside', 'הפרשה למס ולביטוח לאומי % (הערכה גסה)', s.setAside)}</div>
  <div class="card"><h2>דיווחים</h2><label for="s_vatPeriod">תדירות דיווח מע"מ</label><select id="s_vatPeriod"><option value="1" ${s.vatPeriod === 1 ? 'selected' : ''}>חודשי</option><option value="2" ${s.vatPeriod === 2 ? 'selected' : ''}>דו-חודשי</option></select>
  <label for="s_vatStart">בדו-חודשי: החודש הראשון בכל תקופה</label><select id="s_vatStart"><option value="1" ${s.vatStart === 1 ? 'selected' : ''}>ינואר-פברואר, מרץ-אפריל...</option><option value="2" ${s.vatStart === 2 ? 'selected' : ''}>פברואר-מרץ, אפריל-מאי...</option></select>
  ${f('vatDay', 'יום בחודש להגשת מע"מ (לאמת)', s.vatDay)}${f('advDay', 'יום בחודש למקדמות מס הכנסה (לאמת)', s.advDay)}${f('blDay', 'יום בחודש לביטוח לאומי (לאמת)', s.blDay)}
  <label for="s_annual">מועד הדוח השנתי (חודש-יום, לאמת)</label><input id="s_annual" value="${s.annual}">
  <div class="note warn">כל התאריכים כאן הם ברירת מחדל שלי, ולא מועדים רשמיים. לאמת באתר רשות המסים ואצל רואה החשבון.</div></div>
  <button class="btn" data-act="saveSet" style="width:100%;margin-bottom:12px">שמור הגדרות</button>
  <div class="card"><h2>גיבוי</h2><p class="mut">הנתונים נשמרים רק על המכשיר הזה. אם הוא אובד בלי גיבוי, הם נעלמים. ${D.lastBackup ? 'גיבוי אחרון: ' + fmtDate(D.lastBackup) : 'עדיין לא גובה.'}</p>
  <button class="btn" data-act="export" style="width:100%">ייצוא גיבוי (כולל תמונות)</button>
  <label for="imp">שחזור מגיבוי</label><input type="file" id="imp" accept="application/json"></div>
  <div class="card"><h2>פרטיות</h2><p class="mut">הקריאה האוטומטית של חשבוניות רצה על המכשיר, ושום תמונה לא נשלחת לשום שרת. אין חשבון משתמש.</p>
  <button class="btn danger" data-act="wipe">מחיקת כל הנתונים</button></div>`;
}

/* ---------- פעולות ---------- */
const val = id => $('#' + id).value;
async function act(a, el) {
  const id = el.dataset.id;
  switch (a) {
    case 'mprev': S.month = addMonths(S.month, -1); break;
    case 'mnext': S.month = addMonths(S.month, 1); break;
    case 'cancel': S.form = null; break;
    case 'back': S.guide = null; break;
    case 'start': D.active = { date: todayStr(), start: new Date().toTimeString().slice(0, 5), clinic: val('c0') }; await kvSet('active', D.active); break;
    case 'stop': { const n = new Date().toTimeString().slice(0, 5); await dbPut('shifts', { date: D.active.date, start: D.active.start, end: n, clinic: D.active.clinic, type: 'מרפאה', approved: false }); D.active = null; await kvSet('active', null); await load(); toast('המשמרת נשמרה'); break; }
    case 'newShift': S.form = { kind: 'shift' }; break;
    case 'editShift': S.form = { kind: 'shift', data: D.shifts.find(s => s.id == id) }; break;
    case 'saveShift': {
      const o = { date: val('f_date'), start: val('f_start'), end: val('f_end'), clinic: val('f_clinic'), type: val('f_type'), approved: $('#f_appr').checked };
      if (!o.date || !o.start || !o.end) return toast('חסרים תאריך, התחלה או סיום');
      if (shiftHours(o) <= 0) return toast('שעת הסיום חייבת להיות אחרי ההתחלה');
      if (id) o.id = Number(id); await dbPut('shifts', o); await load(); S.form = null; S.month = o.date.slice(0, 7); toast('נשמר'); break;
    }
    case 'delShift': if (confirm('למחוק את המשמרת?')) { await dbDel('shifts', Number(id)); await load(); S.form = null; } break;
    case 'newExp': S.form = { kind: 'exp' }; break;
    case 'editExp': S.form = { kind: 'exp', data: D.expenses.find(e => e.id == id), image: D.expenses.find(e => e.id == id).image }; break;
    case 'saveExp': {
      const o = { date: val('f_date'), supplier: val('f_sup'), desc: val('f_desc'), category: val('f_cat'), invNo: val('f_inv'), hasInvoice: val('f_has') === '1', total: num(val('f_tot')), vatRate: num(val('f_rate')), vatPct: num(val('f_vp')), recogPct: num(val('f_rp')), note: val('f_note'), image: S.form.image || (S.form.data && S.form.data.image) || null };
      if (!o.date || !o.total) return toast('חסרים תאריך או סכום');
      if (id) o.id = Number(id); await dbPut('expenses', o); await load(); S.form = null; S.month = o.date.slice(0, 7); toast('נשמר'); break;
    }
    case 'delExp': if (confirm('למחוק את ההוצאה?')) { await dbDel('expenses', Number(id)); await load(); S.form = null; } break;
    case 'newInv': S.form = { kind: 'inv', data: { forMonth: addMonths(todayStr().slice(0, 7), -1), invoiceDate: todayStr() } }; break;
    case 'invFor': S.form = { kind: 'inv', data: { forMonth: id, invoiceDate: todayStr() } }; break;
    case 'editInv': S.form = { kind: 'inv', data: D.invoices.find(i => i.id == id) }; break;
    case 'saveInv': {
      const o = { forMonth: val('f_for'), invoiceDate: val('f_idate'), invoiceNo: val('f_ino'), net: num(val('f_net')), paidDate: val('f_paid') };
      if (!o.forMonth || !o.invoiceDate || !o.net) return toast('חסרים חודש, תאריך או סכום');
      if (id) o.id = Number(id); await dbPut('invoices', o); await load(); S.form = null; toast('נשמר'); break;
    }
    case 'delInv': if (confirm('למחוק?')) { await dbDel('invoices', Number(id)); await load(); S.form = null; } break;
    case 'guide': { const ev = upcoming(todayStr(), 30).find(e => e.id === id); S.guide = ev ? { ...ev } : { kind: el.dataset.kind || 'vat', id }; S.tab = 'rep'; break; }
    case 'done': D.done[id] = !D.done[id]; await kvSet('done', D.done); S.guide = null; toast(D.done[id] ? 'סומן כבוצע' : 'בוטל'); break;
    case 'pprev': S.rep = (S.rep || periodMonths(addMonths(todayStr().slice(0, 7), -1))).map(k => addMonths(k, -D.st.vatPeriod)); break;
    case 'pnext': S.rep = (S.rep || periodMonths(addMonths(todayStr().slice(0, 7), -1))).map(k => addMonths(k, D.st.vatPeriod)); break;
    case 'copy': try { await navigator.clipboard.writeText(id); toast('הועתק ' + id); } catch { toast(id); } return;
    case 'addCustom': { if (!val('cu_t') || !val('cu_d')) return toast('חסר טקסט או תאריך'); await dbPut('custom', { title: val('cu_t'), date: val('cu_d') }); await load(); toast('נוסף'); break; }
    case 'ics': exportIcs(); return;
    case 'saveSet': {
      const n = { ...D.st };
      ['rate', 'ovh', 'vat', 'credit', 'setAside', 'vatDay', 'advDay', 'blDay'].forEach(k => n[k] = num(val('s_' + k)));
      n.vatPeriod = Number(val('s_vatPeriod')); n.vatStart = Number(val('s_vatStart')); n.annual = val('s_annual');
      D.st = n; await kvSet('settings', n); S.rep = null; toast('נשמר'); break;
    }
    case 'export': await exportBackup(); return;
    case 'wipe': if (confirm('למחוק את כל הנתונים מהמכשיר? אי אפשר לשחזר בלי גיבוי.') && confirm('בטוח?')) { for (const s of ['shifts', 'expenses', 'invoices', 'custom']) for (const r of await dbAll(s)) await dbDel(s, r.id); for (const k of ['settings', 'active', 'done', 'lastBackup', 'started']) await rq(tx('kv', 'readwrite').delete(k)); await load(); toast('נמחק'); } break;
  }
  render();
}

/* ---------- יומן וגיבוי ---------- */
function exportIcs() {
  const t = todayStr(), ev = upcoming(t, 18).filter(e => e.date >= t && !D.done[e.id]);
  const dt = s => s.replace(/-/g, ''), stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//biz//he//EN', 'CALSCALE:GREGORIAN'];
  ev.forEach(e => {
    L.push('BEGIN:VEVENT', `UID:${e.id}-${e.date}@biz`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt(e.date)}`, `DTEND;VALUE=DATE:${dt(addDays(e.date, 1))}`, `SUMMARY:${e.title.replace(/[,;]/g, ' ')}`, `DESCRIPTION:${(e.desc || '').replace(/[,;\n]/g, ' ')}`);
    [['-P3D', '3 ימים'], ['-P1D', 'יום']].forEach(([tr, w]) => L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:בעוד ${w}`, `TRIGGER:${tr}`, 'END:VALARM'));
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  dl(new Blob([L.join('\r\n')], { type: 'text/calendar' }), 'reminders.ics'); toast(`יוצאו ${ev.length} תזכורות`);
}
function dl(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
const b2d = b => new Promise(res => { if (!b) return res(null); const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
async function exportBackup() {
  const data = { v: 1, at: new Date().toISOString(), st: D.st, shifts: D.shifts, invoices: D.invoices, custom: D.custom, done: D.done, expenses: [] };
  for (const e of D.expenses) data.expenses.push({ ...e, image: await b2d(e.image) });
  dl(new Blob([JSON.stringify(data)], { type: 'application/json' }), `backup-${todayStr()}.json`);
  D.lastBackup = todayStr(); await kvSet('lastBackup', D.lastBackup); toast('הגיבוי יוצא'); render();
}
async function importBackup(file) {
  const d = JSON.parse(await file.text()); if (!d || d.v !== 1) return toast('קובץ לא תקין');
  if (!confirm('השחזור יחליף את הנתונים הקיימים. להמשיך?')) return;
  for (const s of ['shifts', 'expenses', 'invoices', 'custom']) for (const r of await dbAll(s)) await dbDel(s, r.id);
  for (const s of ['shifts', 'invoices', 'custom']) for (const r of d[s] || []) await dbPut(s, r);
  for (const e of d.expenses || []) { if (e.image) e.image = await (await fetch(e.image)).blob(); await dbPut('expenses', e); }
  await kvSet('settings', d.st || {}); await kvSet('done', d.done || {}); await load(); toast('שוחזר'); render();
}

/* ---------- הפעלה ---------- */
document.addEventListener('click', e => {
  const tb = e.target.closest('[data-tab]'); if (tb) { S.tab = tb.dataset.tab; S.form = null; S.guide = null; render(); return; }
  const a = e.target.closest('[data-act]'); if (a) act(a.dataset.act, a);
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-act]')) { e.preventDefault(); act(e.target.dataset.act, e.target); } });
document.addEventListener('change', e => { if (e.target.id === 'imp' && e.target.files[0]) importBackup(e.target.files[0]); });
(async () => {
  await openDB(); await load(); render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
