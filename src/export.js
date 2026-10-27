// Расчёт отчётов из прямой выгрузки 1С (portal-export/1) вместо Excel-вложений письма.
// Результат имеет ту же форму, что reports.parseAll(), поэтому дальше работает обычный конвейер
// (checkPeriods → assemble → страницы). Правила отчётов — в rules.json.
'use strict';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function norm(s){ return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(); }
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

function compute(exp, rules, managers){
  if(!exp || exp.format !== 'portal-export/1') throw new Error('неизвестный формат выгрузки 1С (ожидался portal-export/1)');
  const allowed = new Set(managers);
  const today = String(exp.periodTo || exp.createdAt).slice(0, 10);
  const curMonth = ym(today);

  // ---------- справочники ----------
  const props = new Map(exp.properties.map(p => [p.id, p.name]));
  const vals = new Map();
  (exp.propertyValues || []).concat(exp.propertyValuesHier || []).forEach(v => vals.set(v.id, v));
  const items = new Map(exp.items.map(i => [i.id, i]));
  const partners = new Map(exp.partners.map(p => [p.id, p]));

  function objProps(rows){
    const m = new Map();
    (rows || []).forEach(r => {
      if(!r.prop) return;
      if(!m.has(r.obj)) m.set(r.obj, new Map());
      m.get(r.obj).set(r.prop, r);
    });
    return m;
  }
  const pProps = objProps((exp.partnerProps || []).concat(exp.partnerInfo || []));
  const iProps = objProps((exp.itemProps || []).concat(exp.itemInfo || []));
  const propVal = (m, obj, propId) => { const o = m.get(obj); return o ? o.get(propId) : undefined; };
  const propByName = name => { for(const [id, n] of props) if(norm(n) === norm(name)) return id; return null; };

  function inValueTree(vid, root){
    for(let i = 0; vid && i < 30; i++){ if(vid === root) return true; vid = (vals.get(vid) || {}).parent; }
    return false;
  }
  function inItemTree(iid, roots){
    for(let i = 0; iid && i < 40; i++){ if(roots.has(iid)) return true; iid = (items.get(iid) || {}).parent; }
    return false;
  }

  const chProp = rules.channelProperty.id;
  const stProp = rules.clientStatusProperty.id;
  function partnerType(pid){ const r = propVal(pProps, pid, chProp); return r ? r.val : null; }
  function typeName(pid){ const v = vals.get(partnerType(pid)); return v ? v.name : ''; }
  function typeParentName(pid){ const v = vals.get(partnerType(pid)); const p = v && vals.get(v.parent); return p ? p.name : ''; }
  function inChannel(pid, channelKey){ const t = partnerType(pid); return !!t && inValueTree(t, rules.channels[channelKey].id); }
  const isPoint = p => p && !p.isGroup;
  const mgr = p => (p && p.manager) ? p.managerText : null;

  // ---------- продажи: индекс по месяцу ----------
  const sales = exp.sales || [];

  // ---------- ММЛ ----------
  function mml(channelKey){
    const r = rules.mml;
    const posList = r.positions[channelKey];
    const byName = new Map();
    posList.forEach(p => p.items.forEach(n => byName.set(n, p.name)));
    const taskVal = r.taskValues[channelKey].id;
    const qty = new Map();
    const unmapped = new Set();
    // товары с меткой ММЛ-задачи канала, которых нет ни в одной позиции rules.json (новые/переименованные)
    exp.items.forEach(it => {
      const tv = propVal(iProps, it.id, r.taskProperty.id);
      if(tv && tv.val === taskVal && !it.isGroup && !byName.has(it.name)) unmapped.add(it.name);
    });
    sales.forEach(s => {
      const d = s.dt.slice(0, 10);
      if(d < r.from || d > r.to) return;
      const it = items.get(s.item); if(!it) return;
      const tv = propVal(iProps, s.item, r.taskProperty.id);
      if(!tv || tv.val !== taskVal) return;
      const pos = byName.get(it.name); if(!pos) return;
      const k = s.partner + '|' + pos;
      qty.set(k, (qty.get(k) || 0) + (Number(s.qty) || 0));
    });
    const out = [];
    partners.forEach(p => {
      if(!isPoint(p) || !mgr(p) || !allowed.has(mgr(p)) || !inChannel(p.id, channelKey)) return;
      const st = propVal(pProps, p.id, stProp);
      const e = { t: p.name.trim(), m: mgr(p), c: channelKey, reg: null, city: null, typ: null, net: null, addr: null,
        st: p.pointStatusText || (st ? st.text : null) || null, p: {}, g: {} };
      posList.forEach(pos => { e.p[pos.name] = (qty.get(p.id + '|' + pos.name) || 0) > 0 ? 1 : 0; e.g[pos.name] = pos.group; });
      out.push(e);
    });
    return { data: sortRows(out), period: ruDate(r.from) + ' - ' + ruDate(r.to), unmapped: Array.from(unmapped).sort() };
  }

  // ---------- KPI (продажи по месяцам по группе товаров) ----------
  function kpi(key, kind){
    const r = rules.kpi[key];
    const roots = new Set([r.group.id]);
    const months = []; for(let i = r.months - 1; i >= 0; i--) months.push(addMonths(curMonth, -i));
    const mset = new Set(months);
    const agg = new Map();
    sales.forEach(s => {
      const m = ym(s.dt); if(!mset.has(m)) return;
      if(!inItemTree(s.item, roots)) return;
      if(!agg.has(s.partner)) agg.set(s.partner, new Map());
      const a = agg.get(s.partner); const v = a.get(m) || { revenue: 0, qty: 0 };
      v.revenue += Number(s.amount) || 0; v.qty += Number(s.qty) || 0; a.set(m, v);
    });
    const out = [];
    agg.forEach((a, pid) => {
      const p = partners.get(pid);
      if(!isPoint(p) || !mgr(p) || !allowed.has(mgr(p))) return;
      const ms = months.map(m => {
        const v = a.get(m) || { revenue: 0, qty: 0 };
        const o = { label: monthLabel(m), revenue: round2(v.revenue) };
        if(r.withQty) o.qty = Math.round(v.qty * 1000) / 1000;
        return o;
      });
      if(kind === 'sales') out.push({ t: p.name.trim(), m: mgr(p), channel: typeParentName(pid) || '', months: ms });
      else out.push({ t: p.name.trim(), m: mgr(p), typ: typeName(pid) || null, channel: typeParentName(pid) || null, months: ms });
    });
    return { data: sortRows(out), period: ruDate(curMonth + '-01') + ' - ' + ruDate(lastDay(curMonth)) };
  }

  // ---------- Тёмные силы ----------
  function dark(){
    const r = rules.dark;
    const roots = new Set(r.groups.map(g => g.id));
    const exclude = new Set(r.excludeManagers || []);
    const [y, m] = curMonth.split('-');
    const planName = r.planProperty.replace('{MM}', m).replace('{YY}', y.slice(2)).replace('{YYYY}', y);
    const planProp = propByName(planName);
    const fact = new Map();
    sales.forEach(s => {
      if(ym(s.dt) !== curMonth || !inItemTree(s.item, roots)) return;
      fact.set(s.partner, (fact.get(s.partner) || 0) + (Number(s.amount) || 0));
    });
    const out = [];
    partners.forEach(p => {
      if(!isPoint(p) || !mgr(p) || exclude.has(mgr(p)) || !allowed.has(mgr(p)) || !inChannel(p.id, r.channel)) return;
      const pv = planProp ? propVal(pProps, p.id, planProp) : null;
      out.push({ t: p.name.trim(), m: mgr(p), plan: pv && typeof pv.val === 'number' ? pv.val : 0, fact: round2(fact.get(p.id) || 0) });
    });
    return { data: sortRows(out), period: ruDate(curMonth + '-01') + ' - ' + ruDate(lastDay(curMonth)), planProperty: planName, planFound: !!planProp };
  }

  function sortRows(rows){
    return rows.sort((a, b) => a.m.localeCompare(b.m, 'ru') || a.t.localeCompare(b.t, 'ru'));
  }

  const src = 'выгрузка 1С от ' + ruDate(String(exp.createdAt)) + ' ' + String(exp.createdAt).slice(11, 16);
  const res = {
    'Хорека': Object.assign(mml('Хорека'), { kind: 'channel' }),
    'Розница': Object.assign(mml('Розница'), { kind: 'channel' }),
    'Продажи АКБ': Object.assign(kpi('Продажи АКБ', 'sales'), { kind: 'sales' }),
    'Кальяны и аксессуары': Object.assign(kpi('Кальяны и аксессуары', 'acc'), { kind: 'acc' }),
    'ЭСДН': Object.assign(kpi('ЭСДН', 'esdn'), { kind: 'esdn' }),
    'Тёмные силы': Object.assign(dark(), { kind: 'dark' })
  };
  Object.keys(res).forEach(k => { res[k].filename = src; });
  return res;
}

module.exports = { compute };
