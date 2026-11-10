// Дистрибуция новинки (config.json → launch). Сейчас — «Грин Бим 2.0».
//
// Правила:
//  • товары новинки — номенклатура, в названии которой есть launch.item («Грин Бим 2.0»);
//    фасовка — число граммов в конце названия («…, 100 г»);
//  • старт — дата первой продажи любой фасовки новинки (или launch.start, если задан);
//  • АКБ — точки менеджера, у которых были продажи (количество > 0) за launch.akbMonths
//    полных календарных месяца до месяца старта: старт 15.11 → август, сентябрь, октябрь;
//  • канал — родитель «Тип клиента» точки: HoReCa → «Хорека», Розница → «Розница»;
//  • задача выполнена, если точке с начала продаж продали (в сумме, с учётом возвратов) хотя бы одну
//    засчитываемую фасовку своего канала: launch.packs (Хорека — 100 и 250 г, Розница — 25 и 100 г).
//
// Данные — «Плоский отчет - полная» из рассылки «123» (launch.report — слова в названии):
//  • при сборке из выгрузки 1С берутся продажи по дням из выгрузки и отборы этого отчёта из 1С
//    (сейчас отборов нет — все продажи);
//  • при резервной сборке из письма — Excel-вложение этого отчёта.
'use strict';

const rules1c = require('./rules1c');

const MONTHS_GEN = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const CLOSED = /закрыт|архив/i;

function norm(s){ return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
function pad(n){ return String(n).padStart(2, '0'); }
function ruDate(iso){ return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4); }
function addMonths(ym, n){
  let [y, m] = ym.split('-').map(Number);
  m += n; while(m < 1){ m += 12; y--; } while(m > 12){ m -= 12; y++; }
  return y + '-' + pad(m);
}
function lastDay(ym){ const [y, m] = ym.split('-').map(Number); return ym + '-' + pad(new Date(Date.UTC(y, m, 0)).getUTCDate()); }
function packOf(name){ const m = /(\d+)\s*гр?\.?\s*$/i.exec(String(name || '').trim()); return m ? m[1] : null; }
function channelOf(parentName){
  const n = norm(parentName);
  if(/horeca|хорека/.test(n)) return 'Хорека';
  if(/розниц/.test(n)) return 'Розница';
  return null;
}

function settings(cfg){
  const L = cfg.launch || {};
  return {
    title: L.title || 'Новинка',
    item: norm(L.item || L.title),
    report: L.report || ['плоск'],
    akbMonths: Number(L.akbMonths) || 3,
    packs: L.packs || {},
    start: L.start || null
  };
}

// rows: [{ pid, t, m, ch, closed, item, dt (YYYY-MM-DD), qty }] — уже отфильтрованы по менеджерам сайта
function calc(rows, S, info){
  const isNew = name => norm(name).indexOf(S.item) >= 0;
  const newRows = rows.filter(r => isNew(r.item) && r.dt <= info.today);
  const items = Array.from(new Set(newRows.map(r => r.item))).sort();
  // старт: первая продажа новинки по всем точкам (в том числе не наших менеджеров)
  let start = S.start || info.firstSale || null;
  if(!start){ const pos = newRows.filter(r => r.qty > 0).map(r => r.dt).sort(); start = pos[0] || null; }
  if(!start) return null; // продаж новинки ещё не было — раздел не показываем
  const startYm = start.slice(0, 7);
  const akbFrom = addMonths(startYm, -S.akbMonths) + '-01';
  const akbTo = lastDay(addMonths(startYm, -1));

  const points = new Map();
  const point = r => {
    let p = points.get(r.pid);
    if(!p){ p = { t: r.t, m: r.m, ch: r.ch, closed: r.closed, akb: false, q: {}, last: null }; points.set(r.pid, p); }
    return p;
  };
  const noChannel = new Set(); // активные точки без канала (тип клиента не HoReCa/Розница) — в отчёт не попадают
  rows.forEach(r => {
    if(r.m && !r.ch && r.dt >= akbFrom && r.dt <= akbTo && r.qty > 0 && !r.closed) noChannel.add(r.pid);
    if(!r.m || !r.ch) return;
    if(r.dt >= akbFrom && r.dt <= akbTo && r.qty > 0 && !r.closed) point(r).akb = true;
    if(r.dt >= start && r.dt <= info.today && isNew(r.item)){
      const pk = packOf(r.item); if(!pk) return;
      const p = point(r);
      p.q[pk] = (p.q[pk] || 0) + r.qty;
      if(r.qty > 0 && (!p.last || r.dt > p.last)) p.last = r.dt;
    }
  });

  const out = [];
  points.forEach(p => {
    Object.keys(p.q).forEach(k => { p.q[k] = Math.round(p.q[k] * 1000) / 1000; if(!p.q[k]) delete p.q[k]; });
    const ok = (S.packs[p.ch] || []).map(String);
    p.done = ok.some(k => (p.q[k] || 0) > 0);
    if(!p.akb && !p.done) return; // вне АКБ показываем только тех, кто уже купил засчитываемую фасовку
    out.push({ t: p.t, m: p.m, ch: p.ch, akb: p.akb, done: p.done, q: p.q, last: p.last });
  });
  out.sort((a, b) => a.m.localeCompare(b.m, 'ru') || a.t.localeCompare(b.t, 'ru'));

  const mFrom = Number(akbFrom.slice(5, 7)) - 1, mTo = Number(akbTo.slice(5, 7)) - 1;
  const akbLabel = MONTHS_GEN[mFrom] + ' – ' + MONTHS_GEN[mTo] + ' ' + akbTo.slice(0, 4);
  const meta = {
    title: S.title, items, packs: S.packs, start, akbFrom, akbTo, akbLabel, today: info.today,
    reportName: info.reportName || '', source: info.source, noChannel: noChannel.size,
    period: ruDate(start) + ' - ' + ruDate(info.today) + ' (АКБ: ' + ruDate(akbFrom) + ' - ' + ruDate(akbTo) + ')'
  };
  return { meta, data: out, warnings: info.warnings || [] };
}

// ---------- из прямой выгрузки 1С ----------
function fromExport(exp, cfg, managers){
  const S = settings(cfg);
  const warnings = [];
  const today = String(exp.periodTo || exp.createdAt).slice(0, 10);
  const ctx = rules1c.makeContext(exp);
  const rep = rules1c.findReport(exp, cfg, S.report);
  let flt = null;
  if(rep) flt = rules1c.compileFilters(rep.filters, ctx, rep.reportName);
  else warnings.push('в рассылке «' + ((cfg.export && cfg.export.mailing) || '123') + '» нет отчёта «' + S.report.join(' + ') + '» — считаю по всем продажам из выгрузки');

  const allowed = new Set(managers);
  const users = new Map((exp.users || []).map(u => [u.id, u.name]));
  const typeIds = ctx.propIds('Тип клиента');
  const pinfo = new Map();
  ctx.partners.forEach(p => {
    if(p.isGroup) return;
    const m = p.manager ? (p.managerText || users.get(p.manager) || null) : null;
    const tr = ctx.propRow(ctx.pProps, p.id, typeIds);
    const v = tr && ctx.vals.get(tr.val);
    const par = v && ctx.vals.get(v.parent);
    const ok = m && allowed.has(m) && (!flt || (flt.partner(p.id) && flt.manager(p.manager)));
    pinfo.set(p.id, {
      t: String(p.name || '').trim(), m: ok ? m : null, ch: channelOf(par ? par.name : ''),
      closed: !!p.deleted || CLOSED.test(String(p.pointStatusText || ''))
    });
  });

  const itemOk = new Map();
  const rows = [];
  let firstSale = null;
  const S_item = S.item;
  (exp.sales || []).forEach(s => {
    const it = ctx.items.get(s.item); if(!it) return;
    if(!itemOk.has(s.item)) itemOk.set(s.item, !flt || flt.item(s.item));
    if(!itemOk.get(s.item)) return;
    const dt = String(s.dt).slice(0, 10);
    const qty = Number(s.qty) || 0;
    // первая продажа новинки — по всем точкам, не только наших менеджеров
    if(qty > 0 && norm(it.name).indexOf(S_item) >= 0 && (!firstSale || dt < firstSale)) firstSale = dt;
    const p = pinfo.get(s.partner); if(!p || !p.m) return;
    rows.push({ pid: s.partner, t: p.t, m: p.m, ch: p.ch, closed: p.closed, item: it.name, dt, qty });
  });

  const from = String(exp.periodFrom || '').slice(0, 10);
  const res = calc(rows, S, { today, firstSale, reportName: rep ? rep.reportName : '', source: 'export', warnings });
  if(res && from){
    if(res.meta.akbFrom < from) warnings.push('выгрузка 1С начинается с ' + ruDate(from) + ' — АКБ с ' + ruDate(res.meta.akbFrom) + ' посчитана не полностью');
    if(!S.start && firstSale && firstSale.slice(0, 7) === from.slice(0, 7)) warnings.push('первая продажа ' + ruDate(firstSale) + ' — в первом месяце выгрузки; если продажи были раньше, задайте launch.start в config.json');
  }
  return res;
}

// ---------- из Excel «Плоский отчет - полная» (резервная сборка из письма) ----------
function excelDate(v, XLSX){
  if(v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  if(typeof v === 'number' && v > 20000 && v < 80000){ const d = XLSX.SSF.parse_date_code(v); return d ? d.y + '-' + pad(d.m) + '-' + pad(d.d) : null; }
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(v || ''));
  return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : null;
}
function num(v){ if(typeof v === 'number') return v; const n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; }

function fromFiles(files, cfg, managers, today){
  const XLSX = require('xlsx');
  const S = settings(cfg);
  const f = (files || []).find(x => /\.xlsx?$/i.test(x.filename) && S.report.every(w => norm(x.filename).indexOf(norm(w)) >= 0));
  if(!f) return null;
  const wb = XLSX.read(f.content, { type: 'buffer' });
  const rowsX = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  // строка заголовков: есть «Номенклатура» и «Партнер»
  let h = -1;
  for(let i = 0; i < Math.min(rowsX.length, 40) && h < 0; i++){
    const r = rowsX[i].map(norm);
    if(r.indexOf('номенклатура') >= 0 && r.some(c => /^партнер/.test(c))) h = i;
  }
  if(h < 0) throw new Error('в файле «' + f.filename + '» не найдена строка заголовков (Номенклатура, Партнер)');
  const head = rowsX[h].map(norm);
  const col = re => head.findIndex(c => re.test(c));
  const ci = { item: col(/^номенклатура$/), partner: col(/^партнер$/), dt: col(/^(дата|период)/), qty: col(/^количество/),
    mgr: col(/менеджер/), parent: col(/родитель/), type: col(/тип клиента/) };
  const miss = Object.keys(ci).filter(k => k !== 'parent' && k !== 'type' && ci[k] < 0);
  if(miss.length) throw new Error('в файле «' + f.filename + '» нет столбцов: ' + miss.join(', ') + ' (заголовки: ' + rowsX[h].filter(Boolean).join(', ') + ')');
  const allowed = new Set(managers);
  const rows = [];
  let firstSale = null;
  for(let i = h + 1; i < rowsX.length; i++){
    const r = rowsX[i];
    const item = String(r[ci.item] || '').trim(); const t = String(r[ci.partner] || '').trim();
    const dt = excelDate(r[ci.dt], XLSX); if(!item || !t || !dt) continue;
    const qty = num(r[ci.qty]);
    if(qty > 0 && norm(item).indexOf(S.item) >= 0 && (!firstSale || dt < firstSale)) firstSale = dt;
    const m = String(r[ci.mgr] || '').trim();
    if(!allowed.has(m)) continue;
    let ch = ci.parent >= 0 ? channelOf(r[ci.parent]) : null;
    if(!ch && ci.type >= 0) ch = channelOf(r[ci.type]);
    rows.push({ pid: t + '|' + m, t, m, ch, closed: false, item, dt, qty });
  }
  if(!today) today = rows.reduce((a, r) => r.dt > a ? r.dt : a, '');
  return calc(rows, S, { today, firstSale, reportName: f.filename, source: 'mail' });
}

module.exports = { fromExport, fromFiles, calc, packOf };
