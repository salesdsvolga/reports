// Расчёт отчётов из прямой выгрузки 1С (portal-export/1) вместо Excel-вложений письма.
// Правила (отборы, периоды, позиции ММЛ, исключения, план) берутся из настроек отчётов
// рассылки «123» в самой 1С — см. rules1c.js. Результат имеет ту же форму, что reports.parseAll(),
// поэтому дальше работает обычный конвейер (checkPeriods → assemble → страницы).
'use strict';

const rules1c = require('./rules1c');

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function ruDate(iso){ const [y, m, d] = iso.slice(0, 10).split('-'); return d + '.' + m + '.' + y; }
function ym(iso){ return iso.slice(0, 7); }
function addMonths(ymStr, n){
  let [y, m] = ymStr.split('-').map(Number);
  m += n; while(m < 1){ m += 12; y--; } while(m > 12){ m -= 12; y++; }
  return y + '-' + String(m).padStart(2, '0');
}
function monthLabel(ymStr){ const [y, m] = ymStr.split('-'); return MONTHS[Number(m) - 1] + ' ' + y + ' г.'; }
function lastDay(ymStr){ const [y, m] = ymStr.split('-').map(Number); return ymStr + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0'); }
function round2(n){ return Math.round(n * 100) / 100; }
// порядок как в 1С: латиница раньше кириллицы, без учёта регистра
function cmp1c(a, b){ return a.localeCompare(b, 'en', { sensitivity: 'base' }); }

function compute(exp, cfg, managers){
  if(!exp || exp.format !== 'portal-export/1') throw new Error('неизвестный формат выгрузки 1С (ожидался portal-export/1)');
  const { spec, ctx } = rules1c.build(exp, cfg);
  const allowed = new Set(managers);
  const users = new Map((exp.users || []).map(u => [u.id, u.name]));
  const sales = exp.sales || [];
  const { items, partners, vals } = ctx;

  const isPoint = p => p && !p.isGroup;
  const mgrName = p => (p && p.manager) ? (p.managerText || users.get(p.manager) || null) : null;
  // общие условия строки отчёта: точка, менеджер на сайте, отборы по партнёру и менеджеру из 1С
  const rowOk = (p, r) => isPoint(p) && mgrName(p) && allowed.has(mgrName(p)) && r.filters.manager(p.manager) && r.filters.partner(p.id);
  const typeVal = (pid, r) => { const x = ctx.propRow(ctx.pProps, pid, r.typeProp); return x ? x.val : null; };
  const typeName = (pid, r) => { const v = vals.get(typeVal(pid, r)); return v ? v.name : ''; };
  const typeParentName = (pid, r) => { const v = vals.get(typeVal(pid, r)); const p = v && vals.get(v.parent); return p ? p.name : ''; };
  const sortRows = rows => rows.sort((a, b) => a.m.localeCompare(b.m, 'ru') || a.t.localeCompare(b.t, 'ru'));

  // ---------- ММЛ ----------
  function mml(r){
    const itemPos = new Map();
    const unmapped = new Set();
    items.forEach(it => {
      if(it.isGroup || !r.filters.item(it.id)) return;
      const pos = r.choice.get(it.name);
      if(pos) itemPos.set(it.id, pos);
      else if(!it.deleted) unmapped.add(it.name);
    });
    const positions = Array.from(new Set(itemPos.values())).sort(cmp1c);
    const qty = new Map();
    sales.forEach(s => {
      const d = s.dt.slice(0, 10);
      if(d < r.from || d > r.to) return;
      const pos = itemPos.get(s.item); if(!pos) return;
      const k = s.partner + '|' + pos;
      qty.set(k, (qty.get(k) || 0) + (Number(s.qty) || 0));
    });
    const out = [];
    partners.forEach(p => {
      if(!rowOk(p, r)) return;
      const st = ctx.propRow(ctx.pProps, p.id, r.statusProp);
      const e = { t: p.name.trim(), m: mgrName(p), c: r.key, reg: null, city: null, typ: null, net: null, addr: null,
        st: p.pointStatusText || (st ? st.text : null) || null, p: {}, g: {} };
      positions.forEach(pos => { e.p[pos] = (qty.get(p.id + '|' + pos) || 0) > 0 ? 1 : 0; e.g[pos] = pos.split(' ')[0]; });
      out.push(e);
    });
    return { data: sortRows(out), period: ruDate(r.from) + ' - ' + ruDate(r.to), positions, unmapped: Array.from(unmapped).sort() };
  }

  // ---------- KPI (продажи по месяцам) ----------
  function kpi(r){
    const months = []; for(let i = r.months - 1; i >= 0; i--) months.push(addMonths(r.lastMonth, -i));
    const mset = new Set(months);
    const agg = new Map();
    const itemOk = new Map();
    sales.forEach(s => {
      const m = ym(s.dt); if(!mset.has(m)) return;
      if(!itemOk.has(s.item)) itemOk.set(s.item, r.filters.item(s.item));
      if(!itemOk.get(s.item)) return;
      if(!agg.has(s.partner)) agg.set(s.partner, new Map());
      const a = agg.get(s.partner); const v = a.get(m) || { revenue: 0, qty: 0 };
      v.revenue += Number(s.amount) || 0; v.qty += Number(s.qty) || 0; a.set(m, v);
    });
    const out = [];
    agg.forEach((a, pid) => {
      const p = partners.get(pid);
      if(!rowOk(p, r)) return;
      const ms = months.map(m => {
        const v = a.get(m) || { revenue: 0, qty: 0 };
        const o = { label: monthLabel(m), revenue: round2(v.revenue) };
        if(r.withQty) o.qty = Math.round(v.qty * 1000) / 1000;
        return o;
      });
      if(r.kind === 'sales') out.push({ t: p.name.trim(), m: mgrName(p), channel: typeParentName(pid, r) || '', months: ms });
      else out.push({ t: p.name.trim(), m: mgrName(p), typ: typeName(pid, r) || null, channel: typeParentName(pid, r) || null, months: ms });
    });
    return { data: sortRows(out), period: ruDate(r.lastMonth + '-01') + ' - ' + ruDate(lastDay(r.lastMonth)) };
  }

  // ---------- Тёмные силы ----------
  function dark(r){
    const fact = new Map();
    const itemOk = new Map();
    sales.forEach(s => {
      const d = s.dt.slice(0, 10);
      if(d < r.from || d > r.to) return;
      if(!itemOk.has(s.item)) itemOk.set(s.item, r.filters.item(s.item));
      if(!itemOk.get(s.item)) return;
      fact.set(s.partner, (fact.get(s.partner) || 0) + (Number(s.amount) || 0));
    });
    const out = [];
    partners.forEach(p => {
      if(!rowOk(p, r)) return;
      const pv = r.planProp.length ? ctx.propRow(ctx.pProps, p.id, r.planProp) : null;
      out.push({ t: p.name.trim(), m: mgrName(p), plan: pv && typeof pv.val === 'number' ? pv.val : 0, fact: round2(fact.get(p.id) || 0) });
    });
    return { data: sortRows(out), period: ruDate(r.from) + ' - ' + ruDate(r.to), planProperty: r.planPropertyName, planFound: r.planProp.length > 0 };
  }

  const src = 'выгрузка 1С от ' + ruDate(String(exp.createdAt)) + ' ' + String(exp.createdAt).slice(11, 16);
  const res = {};
  Object.keys(spec).forEach(k => {
    const r = spec[k];
    const v = r.kind === 'channel' ? mml(r) : r.kind === 'dark' ? dark(r) : kpi(r);
    res[k] = Object.assign(v, { kind: r.kind, filename: src, reportName: r.reportName });
  });
  return res;
}

module.exports = { compute };
