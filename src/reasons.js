// Поводы для советов. Код сам находит конкретные ситуации по точкам менеджера и считает все цифры;
// модель потом только превращает поводы в текст (см. tips.js).
//
// Два источника:
//  • ежедневные продажи из выгрузки 1С (только при сборке из выгрузки): ритм заказов точки,
//    пропавшие точки, позиции, которые точка перестала брать, падение по месяцам;
//  • страницы отчётов (работают и при резервной сборке из письма): ММЛ, «Тёмные силы», ЭСДН,
//    аксессуары, разрыв до плана.
//
// Каждый повод: { type, kpi, key, point, value, facts, fallback }
//   key      — для журнала повторов (одинаковый повод не показываем каждый день);
//   value    — вес внутри своего типа (обычно деньги «на кону»);
//   facts    — только готовые цифры и названия для модели;
//   fallback — готовый текст на случай, если ни одна модель недоступна.
'use strict';

const DAY = 86400000;
const DARK_THRESHOLD = 90; // порог «Тёмных сил», % — как DARK_THRESHOLD в template.html
const CLOSED = /закрыт|архив/i;

function pad(n){ return String(n).padStart(2, '0'); }
function dayNum(iso){ return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY; }
function ruDay(n){ const d = new Date(n * DAY); return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1); }
function ymOf(n){ const d = new Date(n * DAY); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); }
function round(n){ return Math.round(Number(n) || 0); }
function rub(n){ return round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ₽'; }
function sum(arr){ return arr.reduce(function(a, b){ return a + (Number(b) || 0); }, 0); }
function median(arr){ const s = arr.slice().sort(function(a, b){ return a - b; }); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function days(n){ n = Math.round(n); const a = n % 10, b = n % 100; return n + ' ' + (a === 1 && b !== 11 ? 'день' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'дня' : 'дней'); }
function lastRev(e){ const m = e.months && e.months.length ? e.months[e.months.length - 1] : null; return m && m.revenue ? m.revenue : 0; }
function prevRev(e){ const m = e.months && e.months.length > 1 ? e.months[e.months.length - 2] : null; return m && m.revenue ? m.revenue : 0; }
function curLabel(list){ const e = list.find(function(x){ return x.months && x.months.length; }); return e ? e.months[e.months.length - 1].label : ''; }

// ---------- поводы из ежедневных продаж 1С ----------
function fromSales(exp, managerName, today, closedNames){
  const out = [];
  const T = dayNum(today);
  const users = new Map((exp.users || []).map(function(u){ return [u.id, u.name]; }));
  const items = new Map((exp.items || []).map(function(i){ return [i.id, i]; }));
  const mine = new Map();
  (exp.partners || []).forEach(function(p){
    if(p.isGroup || !p.manager) return;
    const m = p.managerText || users.get(p.manager);
    if(m !== managerName) return;
    const name = String(p.name || '').trim();
    if(CLOSED.test(String(p.pointStatusText || '')) || closedNames.has(name)) return;
    mine.set(p.id, { id: p.id, name: name, days: new Map(), items: new Map() });
  });
  // последняя продажа каждого товара по всей базе — чтобы не советовать то, чего нет в продаже
  const itemLast = new Map();
  (exp.sales || []).forEach(function(s){
    const d = dayNum(String(s.dt).slice(0, 10));
    if(d > T) return;
    if((Number(s.qty) || 0) > 0 && (itemLast.get(s.item) || -1) < d) itemLast.set(s.item, d);
    const p = mine.get(s.partner); if(!p) return;
    const amt = Number(s.amount) || 0, qty = Number(s.qty) || 0;
    p.days.set(d, (p.days.get(d) || 0) + amt);
    let it = p.items.get(s.item); if(!it){ it = { qty: new Map(), amount: 0, amount90: 0 }; p.items.set(s.item, it); }
    it.qty.set(d, (it.qty.get(d) || 0) + qty);
    if(d > T - 150 && d <= T - 45) it.amount += amt;
    if(d > T - 90) it.amount90 += amt;
  });
  const itemName = function(id){ return (items.get(id) || {}).name || ''; };
  const usual = function(p){ // что точка обычно берёт — топ-3 позиции за 90 дней
    return Array.from(p.items.entries()).filter(function(x){ return x[1].amount90 > 0; })
      .sort(function(a, b){ return b[1].amount90 - a[1].amount90; }).slice(0, 3).map(function(x){ return itemName(x[0]); }).filter(Boolean);
  };

  // месяц: [первый день, последний день] по номеру дня
  const monthStart = function(n){ const d = new Date(n * DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY; };
  const M0 = monthStart(T);
  const Ms = [M0]; for(let i = 0; i < 4; i++) Ms.unshift(monthStart(Ms[0] - 1)); // Ms[4] = текущий, Ms[3] = прошлый …
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const mName = function(n){ return MONTHS[new Date(n * DAY).getUTCMonth()]; };

  mine.forEach(function(p){
    const orderDays = Array.from(p.days.entries()).filter(function(x){ return x[1] > 0 && x[0] > T - 180; }).map(function(x){ return x[0]; }).sort(function(a, b){ return a - b; });
    if(!orderDays.length) return;
    const last = orderDays[orderDays.length - 1];
    const since = T - last;
    const revBetween = function(a, b){ let s = 0; p.days.forEach(function(v, d){ if(d >= a && d < b) s += v; }); return s; };

    // 1. Пора заказывать: точка заказывает регулярно, а сейчас пауза заметно дольше обычной
    if(orderDays.length >= 5 && since <= 45){ // дольше 45 дней — это уже «пропала»
      const gaps = []; for(let i = 1; i < orderDays.length; i++) gaps.push(orderDays[i] - orderDays[i - 1]);
      const I = Math.max(2, median(gaps.slice(-8)));
      if(I <= 30 && since >= Math.max(I * 1.6, I + 5)){
        const lastOrders = orderDays.slice(-6).map(function(d){ return p.days.get(d); });
        const avgOrder = sum(lastOrders) / lastOrders.length;
        const u = usual(p);
        out.push({
          type: 'overdue', kpi: 'Заказы', key: 'overdue|' + p.name, point: p.name, value: avgOrder * Math.min(since / I, 3),
          facts: { 'точка': p.name, 'обычно заказывает': 'примерно раз в ' + days(Math.round(I)), 'последний заказ': ruDay(last) + ' (' + days(since) + ' назад)',
            'средний заказ': rub(avgOrder), 'обычно берёт': u },
          fallback: '«' + p.name + '» обычно заказывает примерно раз в ' + days(Math.round(I)) + ', а последний заказ был ' + ruDay(last) + ' — ' + days(since) + ' назад. Позвоните и предложите повторить заказ (средний — ' + rub(avgOrder) + ').'
        });
      }
    }

    // 2. Пропала: брала регулярно, но больше 45 дней нет заказов
    const olderOrders = orderDays.filter(function(d){ return d <= T - 45; });
    if(since > 45 && since <= 150 && olderOrders.length >= 3 && new Set(olderOrders.map(ymOf)).size >= 2){
      const monthly = revBetween(last - 90, last + 1) / 3;
      if(monthly > 0){
        out.push({
          type: 'lost', kpi: 'Продажи АКБ', key: 'lost|' + p.name, point: p.name, value: monthly,
          facts: { 'точка': p.name, 'последний заказ': ruDay(last) + ' (' + days(since) + ' назад)', 'до этого покупала в месяц в среднем': rub(monthly), 'брала': usual(p) },
          fallback: '«' + p.name + '» не заказывает уже ' + days(since) + ' (последний заказ ' + ruDay(last) + '), а раньше брала в среднем на ' + rub(monthly) + ' в месяц. Выясните причину и верните точку.'
        });
      }
    }

    // 3. Перестала брать позицию: брала регулярно, 45+ дней нет, хотя другое заказывает
    const recentOrders = orderDays.filter(function(d){ return d > T - 45; }).length;
    if(since <= 30 && recentOrders >= 2){
      const dropped = [];
      p.items.forEach(function(it, iid){
        const item = items.get(iid);
        if(!item || item.deleted || item.isGroup) return;
        if((itemLast.get(iid) || -1) < T - 30) return; // товар никто не берёт — скорее всего, нет в наличии или выведен
        let before = 0, recent = 0; const months = new Set();
        it.qty.forEach(function(q, d){ if(d > T - 150 && d <= T - 45 && q > 0){ before++; months.add(ymOf(d)); } else if(d > T - 45) recent += q; });
        if(before >= 3 && months.size >= 2 && recent <= 0 && it.amount > 0) dropped.push({ name: item.name, monthly: it.amount / 3.5 });
      });
      if(dropped.length){
        dropped.sort(function(a, b){ return b.monthly - a.monthly; });
        const top = dropped[0];
        out.push({
          type: 'dropped', kpi: 'Ассортимент', key: 'dropped|' + p.name + '|' + top.name, point: p.name, value: sum(dropped.slice(0, 3).map(function(x){ return x.monthly; })),
          facts: { 'точка': p.name, 'перестала брать (раньше брала регулярно, последние 45 дней — нет)': dropped.slice(0, 3).map(function(x){ return { 'позиция': x.name, 'в среднем в месяц было': rub(x.monthly) }; }),
            'другие заказы идут': 'последний заказ ' + ruDay(last) },
          fallback: '«' + p.name + '» продолжает заказывать, но 45 дней не берёт «' + top.name + '», хотя раньше брала регулярно (≈' + rub(top.monthly) + ' в месяц). Уточните причину и верните позицию в заказ.'
        });
      }
    }

    // 4. Падение три месяца подряд (только полные месяцы) + темп текущего месяца
    const r3 = revBetween(Ms[1], Ms[2]), r2 = revBetween(Ms[2], Ms[3]), r1 = revBetween(Ms[3], Ms[4]);
    if(r3 >= 5000 && r3 > r2 && r2 > r1 && r1 <= r3 * 0.75 && since <= 45){
      const dom = T - M0 + 1;
      const curPart = revBetween(M0, T + 1), prevPart = revBetween(Ms[3], Ms[3] + dom);
      out.push({
        type: 'trend', kpi: 'Продажи АКБ', key: 'trend|' + p.name, point: p.name, value: r3 - r1,
        facts: { 'точка': p.name, 'выручка по месяцам': [mName(Ms[1]) + ': ' + rub(r3), mName(Ms[2]) + ': ' + rub(r2), mName(Ms[3]) + ': ' + rub(r1)],
          'текущий месяц на сегодня': rub(curPart) + ' (за те же дни прошлого месяца — ' + rub(prevPart) + ')' },
        fallback: '«' + p.name + '» три месяца подряд берёт меньше: ' + rub(r3) + ' → ' + rub(r2) + ' → ' + rub(r1) + '. Разберитесь с причиной на визите — конкуренты, ассортимент или остатки.'
      });
    }
  });
  return out;
}

// ---------- поводы из отчётов (работают и без выгрузки 1С) ----------
function fromReports(payload, ctx){
  const out = [];
  const closed = ctx.closedNames;
  // точка открыта и (если есть ежедневные продажи) заказывала что-то за 45 дней — иначе ей нужен разговор «почему пропала», а не допродажа
  const active = function(name){ return !closed.has(name) && (!ctx.activeBuyers || ctx.activeBuyers.has(name)); };

  // ММЛ: позиции, которые берёт большинство точек канала, а у этой точки их нет
  const byCh = {};
  (payload.data || []).forEach(function(e){ (byCh[e.c] = byCh[e.c] || []).push(e); });
  Object.keys(byCh).forEach(function(ch){
    const rows = byCh[ch].filter(function(e){ return active(e.t); });
    const n = rows.length; if(n < 4) return;
    const have = {};
    rows.forEach(function(e){ Object.keys(e.p).forEach(function(k){ if(e.p[k]) have[k] = (have[k] || 0) + 1; }); });
    const period = ((payload.meta || {}).channels || {})[ch];
    const periodTo = period && /(\d\d\.\d\d\.\d{4})\s*$/.exec(period.period || '');
    rows.forEach(function(e){
      const total = Object.keys(e.p).length; if(!total) return;
      const got = Object.keys(e.p).filter(function(k){ return e.p[k]; }).length;
      if(got === 0) return; // точка вообще не берёт ММЛ в этом квартале — это другой разговор, не «добрать позиции»
      const miss = Object.keys(e.p).filter(function(k){ return !e.p[k] && (have[k] || 0) / n >= 0.5; })
        .sort(function(a, b){ return (have[b] || 0) - (have[a] || 0); });
      if(!miss.length) return;
      out.push({
        type: 'mml', kpi: 'Незакупленные позиции', key: 'mml|' + e.t, point: e.t, value: sum(miss.slice(0, 4).map(function(k){ return have[k] / n; })),
        facts: { 'точка': e.t, 'канал': ch, 'закуплено позиций ММЛ': got + ' из ' + total,
          'нет ходовых позиций (их берёт большинство точек канала)': miss.slice(0, 4).map(function(k){ return { 'позиция': k, 'берут': have[k] + ' из ' + n + ' точек канала' }; }),
          'период ММЛ до': periodTo ? periodTo[1] : null },
        fallback: 'У «' + e.t + '» нет ходовых позиций ММЛ: ' + miss.slice(0, 3).join(', ') + ' — их берёт большинство точек канала «' + ch + '». Предложите добавить в ближайший заказ.'
      });
    });
  });

  // «Тёмные силы»: точки, близкие к порогу, и точки с планом, но без факта
  (payload.dark || []).forEach(function(e){
    if(!(e.plan > 0) || !active(e.t)) return;
    const pct = (e.fact || 0) / e.plan * 100;
    const need = Math.max(1, Math.ceil(e.plan * DARK_THRESHOLD / 100 - (e.fact || 0)));
    if(pct >= 40 && pct < DARK_THRESHOLD){
      out.push({
        type: 'dark_near', kpi: 'Тёмные силы', key: 'dark|' + e.t, point: e.t, value: pct * 1000 - need / 100,
        facts: { 'точка': e.t, 'план': rub(e.plan), 'факт': rub(e.fact), 'выполнение': Math.round(pct) + '%', 'не хватает до 90%': rub(need), 'порог': '90% — точка засчитывается в долю выполнивших' },
        fallback: '«' + e.t + '» выполнила план «Тёмных сил» на ' + Math.round(pct) + '%, до порога 90% не хватает ' + rub(need) + '. Догрузите — и точка попадёт в долю выполнивших.'
      });
    } else if(!e.fact && (!ctx.recentBuyers || ctx.recentBuyers.has(e.t))){
      out.push({
        type: 'dark_zero', kpi: 'Тёмные силы', key: 'dark|' + e.t, point: e.t, value: e.plan,
        facts: { 'точка': e.t, 'план': rub(e.plan), 'факт': '0 ₽', 'нужно для порога 90%': rub(need), 'точка активна': ctx.recentBuyers ? 'да, заказывала другое за последние 30 дней' : null },
        fallback: 'У «' + e.t + '» план «Тёмных сил» ' + rub(e.plan) + ', а продаж пока нет' + (ctx.recentBuyers ? ', хотя другое точка заказывает' : '') + '. Предложите позиции «Тёмных сил» в ближайшем заказе.'
      });
    }
  });

  // ЭСДН — только розница: розничные точки, которые берут табак, но ЭСДН не брали ни разу за период отчёта
  const esdnAny = new Set((payload.esdn || []).filter(function(e){ return (e.months || []).some(function(m){ return m.revenue > 0; }); }).map(function(e){ return e.t; }));
  (payload.sales || []).forEach(function(e){
    if(ctx.channelOf(e.t) !== 'Розница' || !active(e.t) || esdnAny.has(e.t)) return;
    const r = Math.max(lastRev(e), prevRev(e)); if(r <= 0) return;
    out.push({
      type: 'esdn', kpi: 'ЭСДН', key: 'esdn|' + e.t, point: e.t, value: r,
      facts: { 'точка': e.t, 'канал': 'Розница', 'табак (Продажи АКБ) за месяц': rub(r), 'ЭСДН': 'не брала ни разу за период отчёта' },
      fallback: 'Розничная точка «' + e.t + '» берёт табак на ' + rub(r) + ' в месяц, но ЭСДН не брала ни разу. Предложите пробную поставку ЭСДН.'
    });
  });

  // Аксессуары: брали в прошлом месяце, в этом нет (только с 10-го числа — раньше это нормально)
  if(ctx.dayOfMonth >= 10){
    (payload.accessories || []).forEach(function(e){
      if(!active(e.t) || lastRev(e) > 0 || prevRev(e) <= 0) return;
      out.push({
        type: 'acc', kpi: 'Аксессуары', key: 'acc|' + e.t, point: e.t, value: prevRev(e),
        facts: { 'точка': e.t, 'прошлый месяц': rub(prevRev(e)), 'этот месяц': '0 ₽ (сегодня ' + ctx.dayOfMonth + '-е число)' },
        fallback: '«' + e.t + '» в прошлом месяце взяла кальяны и аксессуары на ' + rub(prevRev(e)) + ', в этом — пока ничего. Предложите пополнить.'
      });
    });
    // запасной повод для резервной сборки (без ежедневных продаж): пропавшие точки по отчёту АКБ
    if(!ctx.hasDaily){
      (payload.sales || []).forEach(function(e){
        if(!active(e.t) || lastRev(e) > 0 || prevRev(e) <= 0) return;
        out.push({
          type: 'lost', kpi: 'Продажи АКБ', key: 'lost|' + e.t, point: e.t, value: prevRev(e),
          facts: { 'точка': e.t, 'прошлый месяц': rub(prevRev(e)), 'этот месяц': '0 ₽ (сегодня ' + ctx.dayOfMonth + '-е число)' },
          fallback: '«' + e.t + '» в прошлом месяце купила табака на ' + rub(prevRev(e)) + ', в этом — ещё ничего. Позвоните и договоритесь о заказе.'
        });
      });
    }
  }

  // Разрыв до плана (по менеджеру, без конкретной точки)
  [['Аксессуары', payload.accessories || []], ['ЭСДН', payload.esdn || []]].forEach(function(x){
    const plan = Number((payload.plans || {})[x[0]]) || 0; if(plan <= 0) return;
    const fact = sum(x[1].map(lastRev));
    if(fact >= plan) return;
    const left = plan - fact;
    out.push({
      type: 'plan', kpi: x[0], key: 'plan|' + x[0], point: null, value: left,
      facts: { 'показатель': x[0], 'месяц': curLabel(x[1]) || null, 'план': rub(plan), 'факт': rub(fact), 'выполнение': Math.round(fact / plan * 100) + '%',
        'осталось': rub(left), 'рабочих дней до конца месяца': ctx.workdaysLeft, 'нужно в рабочий день': rub(left / ctx.workdaysLeft),
        'ограничение': x[0] === 'ЭСДН' ? 'ЭСДН продаётся только в рознице' : null },
      fallback: x[0] + ': выполнено ' + Math.round(fact / plan * 100) + '% плана, осталось ' + rub(left) + ' — это ' + rub(left / ctx.workdaysLeft) + ' в каждый оставшийся рабочий день.'
    });
  });
  return out;
}

// Канал точки — из отчётов ММЛ (там он явный), запасной вариант — текст канала в KPI-отчётах.
function channelResolver(payload){
  const retail = new Set(), horeca = new Set();
  (payload.data || []).forEach(function(e){ if(e.c === 'Розница') retail.add(e.t); else if(e.c === 'Хорека') horeca.add(e.t); });
  [].concat(payload.sales || [], payload.accessories || [], payload.esdn || []).forEach(function(e){
    const txt = (String(e.channel || '') + ' ' + String(e.typ || '')).toLowerCase();
    if(/розн/.test(txt)) retail.add(e.t); else if(/хорек|horeca|ресторан|кафе/.test(txt)) horeca.add(e.t);
  });
  return function(name){
    if(retail.has(name) && !horeca.has(name)) return 'Розница';
    if(horeca.has(name) && !retail.has(name)) return 'Хорека';
    return null;
  };
}

// opts: { payload, managerName, today: 'YYYY-MM-DD', exp?, workdaysLeft }
function find(opts){
  const payload = opts.payload, exp = opts.exp;
  const closedNames = new Set((payload.data || []).filter(function(e){ return CLOSED.test(String(e.st || '')); }).map(function(e){ return e.t; }));
  let recentBuyers = null, activeBuyers = null;
  if(exp){
    (exp.partners || []).forEach(function(p){ if(CLOSED.test(String(p.pointStatusText || ''))) closedNames.add(String(p.name || '').trim()); });
    const T = dayNum(opts.today);
    const names = new Map((exp.partners || []).map(function(p){ return [p.id, String(p.name || '').trim()]; }));
    recentBuyers = new Set(); activeBuyers = new Set();
    (exp.sales || []).forEach(function(s){
      const d = dayNum(String(s.dt).slice(0, 10));
      if(d > T || (Number(s.amount) || 0) <= 0) return;
      if(d > T - 30) recentBuyers.add(names.get(s.partner));
      if(d > T - 45) activeBuyers.add(names.get(s.partner));
    });
  }
  const ctx = {
    closedNames: closedNames, recentBuyers: recentBuyers, activeBuyers: activeBuyers, hasDaily: !!exp, channelOf: channelResolver(payload),
    dayOfMonth: +opts.today.slice(8, 10), workdaysLeft: Math.max(1, opts.workdaysLeft || 1)
  };
  const list = (exp ? fromSales(exp, opts.managerName, opts.today, closedNames) : []).concat(fromReports(payload, ctx));
  return list;
}

module.exports = { find, rub };
