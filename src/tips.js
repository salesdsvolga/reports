// Советы для менеджера от Gemini. Вызывается ТОЛЬКО из build.js с флагом --tips
// (см. update.yml). Ручная сборка (manual.js) флаг не передаёт — Gemini не вызывается.
//
// Любая ошибка здесь не должна ломать сборку: при сбое возвращаем null,
// и страница собирается без кнопки «Советы».

// Модель можно сменить без правки кода: переменная GEMINI_MODEL в Actions (Variables).
const DEFAULT_MODEL = 'gemini-flash-latest';
// Отправлять ли в Google названия торговых точек. По умолчанию — нет (только агрегаты).
const SEND_POINT_NAMES = true;
const TIMEOUT_MS = 45000;

function sum(arr){ return arr.reduce(function(a, b){ return a + (Number(b) || 0); }, 0); }
function pct(a, b){ return b > 0 ? Math.round(a / b * 100) : null; }
function round(n){ return Math.round(Number(n) || 0); }

// Все цифры считаем кодом — модель только формулирует текст.
function summarize(payload, managerName){
  const s = { manager: managerName };

  // 1. Незакупленные позиции (ММЛ) по каналам
  const byChannel = {};
  (payload.data || []).forEach(function(e){
    const c = byChannel[e.c] || (byChannel[e.c] = { points: 0, cells: 0, bought: 0, miss: {}, missGroup: {} });
    c.points++;
    Object.keys(e.p).forEach(function(prod){
      c.cells++;
      if(e.p[prod]) c.bought++;
      else {
        c.miss[prod] = (c.miss[prod] || 0) + 1;
        const g = e.g && e.g[prod];
        if(g) c.missGroup[g] = (c.missGroup[g] || 0) + 1;
      }
    });
  });
  s.assortment = Object.keys(byChannel).map(function(ch){
    const c = byChannel[ch];
    const top = Object.keys(c.miss).sort(function(a, b){ return c.miss[b] - c.miss[a]; }).slice(0, 6)
      .map(function(p){ return { product: p, pointsWithoutIt: c.miss[p] }; });
    const groups = Object.keys(c.missGroup).sort(function(a, b){ return c.missGroup[b] - c.missGroup[a]; }).slice(0, 3);
    return { channel: ch, points: c.points, coveragePercent: pct(c.bought, c.cells), mostMissingProducts: top, mostMissingGroups: groups };
  });

  // 2. Продажи АКБ: последний столбец months — текущий месяц (так же считает template.html)
  const sales = payload.sales || [];
  if(sales.length){
    const last = function(e){ return e.months[e.months.length - 1]; };
    const prev = function(e){ return e.months.length > 1 ? e.months[e.months.length - 2] : null; };
    const noSales = sales.filter(function(e){ const m = last(e); return !m || !m.revenue; });
    const lost = noSales.filter(function(e){ const p = prev(e); return p && p.revenue > 0; });
    s.akb = {
      points: sales.length,
      currentMonth: sales[0].months.length ? last(sales[0]).label : null,
      revenueCurrent: round(sum(sales.map(function(e){ return last(e) && last(e).revenue; }))),
      revenuePrevious: round(sum(sales.map(function(e){ const p = prev(e); return p && p.revenue; }))),
      pointsWithoutSalesThisMonth: noSales.length,
      ofThemBoughtPreviousMonth: lost.length
    };
    if(SEND_POINT_NAMES) s.akb.lostPoints = lost.slice(0, 5).map(function(e){ return e.t; });
  }

  // 3. Аксессуары: факт = выручка последнего месяца, план — из plans
  const acc = payload.accessories || [];
  if(acc.length){
    const fact = sum(acc.map(function(e){ const m = e.months[e.months.length - 1]; return m && m.revenue; }));
    const plan = (payload.plans || {})['Аксессуары'] || 0;
    s.accessories = { points: acc.length, plan: round(plan), fact: round(fact), planPercent: pct(fact, plan) };
  }

  // 4. ЭСДН и «Тёмные силы»: план/факт по точкам
  function kpi(list, planTotal){
    if(!list.length) return null;
    const plan = sum(list.map(function(e){ return e.plan; }));
    const fact = sum(list.map(function(e){ return e.fact; }));
    const behind = list.filter(function(e){ return e.plan > 0 && e.fact < e.plan; });
    const res = { points: list.length, plan: round(plan || planTotal), fact: round(fact), planPercent: pct(fact, plan || planTotal), pointsBelowPlan: behind.length };
    if(SEND_POINT_NAMES) res.biggestGaps = behind.sort(function(a, b){ return (b.plan - b.fact) - (a.plan - a.fact); }).slice(0, 5).map(function(e){ return e.t; });
    return res;
  }
  const esdn = kpi(payload.esdn || [], (payload.plans || {})['ЭСДН'] || 0);
  if(esdn) s.esdn = esdn;
  const dark = kpi(payload.dark || [], 0);
  if(dark) s.dark = dark;

  return s;
}

const PROMPT =
  'Ты помощник менеджера по дистрибуции. Ниже — сводка по его портфелю за текущий месяц (JSON). ' +
  'Составь 3–7 коротких практичных советов, что сделать в первую очередь, чтобы вырасти в продажах и выполнить планы. ' +
  'Правила: пиши по-русски, обращайся на «вы»; опирайся ТОЛЬКО на данные из сводки, не выдумывай цифры и названия; ' +
  'каждый совет — 1–2 предложения; сначала самое важное (где самый большой отрыв от плана или больше всего упущенного). ' +
  'Верни строго JSON: {"tips":[{"title":"до 5 слов","text":"совет"}]}.';

async function callGemini(summary, env){
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT + '\n\n' + JSON.stringify(summary) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
      }),
      signal: ctrl.signal
    });
    if(!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    const text = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts
      .map(function(p){ return p.text || ''; }).join('');
    const parsed = JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
    const tips = (parsed.tips || []).filter(function(t){ return t && t.text; }).slice(0, 5)
      .map(function(t){ return { title: String(t.title || '').slice(0, 60), text: String(t.text).slice(0, 400) }; });
    return tips.length ? tips : null;
  } finally { clearTimeout(timer); }
}

// pages: массив {slug, payload, managerName?}. Дописывает payload.tips там, где получилось.
async function addTips(pages, env){
  if(!env.GEMINI_API_KEY){ console.log('  💡 GEMINI_API_KEY не задан — советы пропущены.'); return; }
  for(const p of pages){
    if(!p.managerName) continue; // общая страница — без советов
    try{
      const tips = await callGemini(summarize(p.payload, p.managerName), env);
      if(tips){ p.payload.tips = tips; console.log('  💡 ' + p.slug + ': советов ' + tips.length); }
    }catch(e){
      console.warn('  ⚠ Советы для «' + p.slug + '» не получены (' + (e && e.message ? e.message : e) + ') — страница соберётся без них.');
    }
  }
}

module.exports = { addTips, summarize };
