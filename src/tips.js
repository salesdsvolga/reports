// Советы для менеджера от Gemini. Вызывается ТОЛЬКО из build.js с флагом --tips
// (см. update.yml). Ручная сборка (manual.js) флаг не передаёт — Gemini не вызывается.
//
// Любая ошибка здесь не должна ломать сборку: при сбое возвращаем null,
// и страница собирается без кнопки «Советы».

// Модель можно сменить без правки кода: переменная GEMINI_MODEL в Actions (Variables).
const DEFAULT_MODEL = 'gemini-flash-latest';
// Если основная модель перегружена (503/429) — пробуем запасную, более лёгкую.
const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const RETRY_DELAYS_MS = [4000, 12000]; // пауза перед 2-й и 3-й попыткой на каждой модели
// Отправлять ли в Google названия торговых точек (нужно для советов вида «позвоните в точку X»).
const SEND_POINT_NAMES = true;
const TIMEOUT_MS = 60000;
const DARK_THRESHOLD = 90; // порог «Тёмных сил», % — как DARK_THRESHOLD в template.html

function sum(arr){ return arr.reduce(function(a, b){ return a + (Number(b) || 0); }, 0); }
function pct(a, b){ return b > 0 ? Math.round(a / b * 100) : null; }
function round(n){ return Math.round(Number(n) || 0); }
function top(arr, n, keyFn){ return arr.slice().sort(function(a, b){ return keyFn(b) - keyFn(a); }).slice(0, n); }
function names(list){ return SEND_POINT_NAMES ? list : undefined; } // списки с названиями точек — только если разрешено

// Сегодняшняя дата в Самаре и сколько рабочих дней (пн–пт, включая сегодня) осталось до конца месяца.
function calendar(){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Samara', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
  const y = +parts[0], m = +parts[1], d = +parts[2];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let left = 0;
  for(let day = d; day <= last; day++){ const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay(); if(wd !== 0 && wd !== 6) left++; }
  return { date: String(d).padStart(2, '0') + '.' + String(m).padStart(2, '0') + '.' + y, workdaysLeft: Math.max(left, 1) };
}

// Бизнес-ограничения для Gemini. Если появятся новые правила («X продаётся только в Y») — добавляйте сюда.
const BUSINESS_RULES =
  'ЭСДН продаётся ТОЛЬКО в канале «Розница». Никогда не советуй продавать, предлагать или «запускать» ЭСДН точкам канала «Хорека» ' +
  'и точкам, у которых канал не определён как «Розница». Для ЭСДН называй точки только из списка «розничные точки для предложения ЭСДН». ' +
  'Если такого списка в сводке нет — не называй конкретных точек для ЭСДН, говори только про план, остаток и дневную норму.';

const NO_ROWS = 'в отчёте нет ни одной точки этого менеджера — значит, продаж по этому показателю нет (факт = 0)';

// Все цифры считаем кодом — модель только формулирует текст.
// Ключи — на русском, как названия разделов отчёта, чтобы модель не использовала технические имена.
function summarize(payload, managerName){
  const cal = calendar();
  const s = { 'Менеджер': managerName, 'Сегодня': cal.date, 'Рабочих дней до конца месяца': cal.workdaysLeft };

  // Канал точки: надёжнее всего — из отчётов «Хорека»/«Розница» (там канал задан явно),
  // запасной вариант — текст канала/типа клиента в остальных отчётах.
  const retail = new Set(), horeca = new Set();
  (payload.data || []).forEach(function(e){ if(e.c === 'Розница') retail.add(e.t); else if(e.c === 'Хорека') horeca.add(e.t); });
  [].concat(payload.sales || [], payload.accessories || [], payload.esdn || []).forEach(function(e){
    const txt = (String(e.channel || '') + ' ' + String(e.typ || '')).toLowerCase();
    if(/розн/.test(txt)) retail.add(e.t); else if(/хорек|horeca|ресторан|кафе/.test(txt)) horeca.add(e.t);
  });
  function chanOf(name){
    if(retail.has(name) && !horeca.has(name)) return 'Розница';
    if(horeca.has(name) && !retail.has(name)) return 'Хорека';
    return null;
  }

  // 1. «Незакупленные позиции» — по каналам
  const byChannel = {};
  (payload.data || []).forEach(function(e){
    const c = byChannel[e.c] || (byChannel[e.c] = { pts: [], bought: {}, cells: 0, got: 0 });
    c.pts.push(e);
    Object.keys(e.p).forEach(function(prod){
      c.cells++;
      if(e.p[prod]){ c.got++; c.bought[prod] = (c.bought[prod] || 0) + 1; }
    });
  });
  if(!Object.keys(byChannel).length) s['Незакупленные позиции'] = { 'данные': 'в отчёте нет ни одной точки этого менеджера' };
  else s['Незакупленные позиции'] = Object.keys(byChannel).map(function(ch){
    const c = byChannel[ch];
    const n = c.pts.length;
    const miss = {};
    c.pts.forEach(function(e){ Object.keys(e.p).forEach(function(prod){ if(!e.p[prod]) miss[prod] = (miss[prod] || 0) + 1; }); });
    const topMissing = top(Object.keys(miss), 6, function(p){ return miss[p]; })
      .map(function(p){ return { 'позиция': p, 'нет в точках': miss[p], 'из': n }; });
    // точки с наибольшим числом незакупленных позиций + ходовые позиции (их берут другие точки канала), которых у них нет
    const worst = top(c.pts, 6, function(e){ return Object.keys(e.p).filter(function(k){ return !e.p[k]; }).length; })
      .map(function(e){
        const lacks = Object.keys(e.p).filter(function(k){ return !e.p[k]; });
        const popular = top(lacks, 3, function(k){ return c.bought[k] || 0; })
          .map(function(k){ return { 'позиция': k, 'берут точек канала': c.bought[k] || 0 }; });
        const o = { 'точка': e.t, 'не закуплено позиций': lacks.length, 'из': Object.keys(e.p).length, 'ходовые, которых нет': popular };
        if(e.st) o['статус'] = e.st;
        return o;
      });
    const r = { 'канал': ch, 'точек': n, 'охват ассортимента, %': pct(c.got, c.cells), 'чаще всего не закуплено': topMissing };
    if(SEND_POINT_NAMES) r['точки с наибольшим числом незакупленных'] = worst;
    return r;
  });

  // 2. «Продажи АКБ» (вкладка «Нет продаж за месяц»): последний столбец months — текущий месяц
  const sales = payload.sales || [];
  if(!sales.length) s['Продажи АКБ'] = { 'данные': NO_ROWS };
  else {
    const cur = function(e){ return e.months.length ? e.months[e.months.length - 1] : null; };
    const prev = function(e){ return e.months.length > 1 ? e.months[e.months.length - 2] : null; };
    const rev = function(m){ return m && m.revenue ? m.revenue : 0; };
    const noSales = sales.filter(function(e){ return !rev(cur(e)); });
    const lost = noSales.filter(function(e){ return rev(prev(e)) > 0; });
    const drops = sales.filter(function(e){ return rev(prev(e)) > 0 && rev(cur(e)) > 0 && rev(cur(e)) < rev(prev(e)) * 0.7; });
    const r = {
      'точек': sales.length,
      'текущий месяц': sales[0].months.length ? cur(sales[0]).label : null,
      'выручка за текущий месяц, ₽': round(sum(sales.map(function(e){ return rev(cur(e)); }))),
      'выручка за прошлый месяц, ₽': round(sum(sales.map(function(e){ return rev(prev(e)); }))),
      'точек без продаж в этом месяце': noSales.length,
      'из них покупали в прошлом месяце': lost.length
    };
    const l1 = names(top(lost, 8, function(e){ return rev(prev(e)); }).map(function(e){ return { 'точка': e.t, 'прошлый месяц, ₽': round(rev(prev(e))) }; }));
    if(l1) r['потерянные точки (покупали в прошлом месяце, в этом нет)'] = l1;
    const l2 = names(top(drops, 5, function(e){ return rev(prev(e)) - rev(cur(e)); }).map(function(e){ return { 'точка': e.t, 'прошлый месяц, ₽': round(rev(prev(e))), 'этот месяц, ₽': round(rev(cur(e))) }; }));
    if(l2) r['точки с просадкой более 30%'] = l2;
    const bestA = names(top(sales, 5, function(e){ return rev(cur(e)); }).filter(function(e){ return rev(cur(e)) > 0; }).map(function(e){ return { 'точка': e.t, 'канал': chanOf(e.t) || 'не определён', 'выручка в этом месяце, ₽': round(rev(cur(e))) }; }));
    if(bestA) r['самые активные точки (по выручке в этом месяце)'] = bestA;
    s['Продажи АКБ'] = r;
  }

  // 3. «Аксессуары» и «ЭСДН» — отчёты по месяцам: факт = выручка последнего месяца, план — из plans
  function monthly(list, planTotal){
    if(!list.length){
      const e0 = { 'данные': NO_ROWS, 'точек': 0, 'план, ₽': round(planTotal), 'факт, ₽': 0 };
      if(planTotal > 0){
        e0['выполнение плана, %'] = 0;
        e0['осталось до плана, ₽'] = round(planTotal);
        e0['нужно продавать в рабочий день, ₽'] = round(planTotal / cal.workdaysLeft);
      }
      return e0;
    }
    const cur = function(e){ return e.months.length ? e.months[e.months.length - 1] : null; };
    const prev = function(e){ return e.months.length > 1 ? e.months[e.months.length - 2] : null; };
    const rev = function(m){ return m && m.revenue ? m.revenue : 0; };
    const fact = sum(list.map(function(e){ return rev(cur(e)); }));
    const noSales = list.filter(function(e){ return !rev(cur(e)); });
    const r = {
      'точек': list.length,
      'текущий месяц': list[0].months.length ? cur(list[0]).label : null,
      'план, ₽': round(planTotal), 'факт, ₽': round(fact), 'выполнение плана, %': pct(fact, planTotal),
      'выручка за прошлый месяц, ₽': round(sum(list.map(function(e){ return rev(prev(e)); }))),
      'точек без продаж в этом месяце': noSales.length
    };
    if(planTotal > 0 && fact < planTotal){
      r['осталось до плана, ₽'] = round(planTotal - fact);
      r['нужно продавать в рабочий день, ₽'] = round((planTotal - fact) / cal.workdaysLeft);
    }
    const l = names(top(noSales, 8, function(e){ return rev(prev(e)); }).map(function(e){ return { 'точка': e.t, 'прошлый месяц, ₽': round(rev(prev(e))) }; }));
    if(l) r['точки без продаж в этом месяце (список)'] = l;
    const best = names(top(list, 3, function(e){ return rev(cur(e)); }).filter(function(e){ return rev(cur(e)) > 0; }).map(function(e){ return { 'точка': e.t, 'факт, ₽': round(rev(cur(e))) }; }));
    if(best) r['лучшие точки'] = best;
    return r;
  }
  const acc = monthly(payload.accessories || [], (payload.plans || {})['Аксессуары'] || 0);
  s['Аксессуары'] = acc;
  const esdn = monthly(payload.esdn || [], (payload.plans || {})['ЭСДН'] || 0);
  s['ЭСДН'] = esdn;
  esdn['ограничение'] = 'ЭСДН продаётся только в канале «Розница»';
  if(SEND_POINT_NAMES){
    const sold = new Set((payload.esdn || []).filter(function(e){ const m = e.months[e.months.length - 1]; return m && m.revenue > 0; }).map(function(e){ return e.t; }));
    const lastRev = function(e){ const m = e.months.length ? e.months[e.months.length - 1] : null; return m && m.revenue ? m.revenue : 0; };
    const cands = top((payload.sales || []).filter(function(e){ return chanOf(e.t) === 'Розница' && lastRev(e) > 0 && !sold.has(e.t); }), 8, lastRev)
      .map(function(e){ return { 'точка': e.t, 'выручка АКБ в этом месяце, ₽': round(lastRev(e)) }; });
    if(cands.length) esdn['розничные точки для предложения ЭСДН'] = cands;
    else esdn['розничные точки для предложения ЭСДН'] = 'не определены — не называй конкретных точек для ЭСДН';
  }

  // 4. «Тёмные силы»: показатель менеджера — доля точек, выполнивших план на 90% и выше (не деньги)
  const darkList = (payload.dark || []).filter(function(e){ return e.plan > 0; });
  if(!darkList.length) s['Тёмные силы'] = { 'данные': 'в отчёте нет ни одной точки этого менеджера с планом — значит, выполнивших план нет (0 точек)' };
  else {
    const dp = function(e){ return (e.fact || 0) / e.plan * 100; };
    const ok = darkList.filter(function(e){ return dp(e) >= DARK_THRESHOLD; });
    const below = darkList.filter(function(e){ return dp(e) < DARK_THRESHOLD; });
    const r = {
      'точек с планом': darkList.length,
      'выполнили план на 90% и выше': ok.length,
      'доля точек, выполнивших план на 90%+, %': pct(ok.length, darkList.length),
      'не дотянули до 90%': below.length,
      'из них с нулевым фактом': below.filter(function(e){ return !e.fact; }).length
    };
    // ближе всего к порогу — быстрее всего «закрыть» точку
    const near = names(top(below, 10, dp).map(function(e){
      return { 'точка': e.t, 'выполнение, %': Math.round(dp(e)), 'план': round(e.plan), 'факт': round(e.fact), 'не хватает до 90%': Math.max(1, Math.ceil(e.plan * DARK_THRESHOLD / 100 - (e.fact || 0))) };
    }));
    if(near) r['ближе всего к порогу 90%'] = near;
    const zero = names(below.filter(function(e){ return !e.fact; }).slice(0, 5).map(function(e){ return { 'точка': e.t, 'план': round(e.plan) }; }));
    if(zero) r['точки с нулевым фактом'] = zero;
    s['Тёмные силы'] = r;
  }

  return s;
}

const PROMPT =
  'Ты — опытный коммерческий аналитик дистрибьютора. Ты готовишь менеджера по продажам к рабочему дню. ' +
  'Ниже — сводка по его портфелю торговых точек (JSON; ключи на русском — это названия разделов и показателей отчёта). ' +
  'Составь 4–6 советов: конкретные действия на сегодня и ближайшие дни, которые сильнее всего двигают выполнение планов.\n\n' +
  'ЖЁСТКИЕ ОГРАНИЧЕНИЯ БИЗНЕСА (нарушать нельзя):\n' + BUSINESS_RULES + '\n\n' +
  'ТРЕБОВАНИЯ:\n' +
  '1. Каждый совет = действие + кому (точное название точки из сводки) + что именно (позиции, суммы, проценты из сводки) + какой эффект на показатель. ' +
  'Хороший пример: «Точка „Х“ выполнила 84% плана, до порога 90% не хватает 12 — начните с неё: уточните остатки и догрузите недостающее, это добавит ещё одну точку в долю выполнивших». ' +
  'ЗАПРЕЩЕНЫ общие фразы вроде «улучшайте продажи», «работайте с клиентами», «повышайте охват», «обратите внимание на план» — если совет можно дать без цифр и названий из сводки, он не годится.\n' +
  '2. Опирайся ТОЛЬКО на сводку. Названия точек и позиций переписывай дословно, числа не выдумывай и не пересчитывай, если нужное число уже есть в сводке. Если данных для вывода нет — не делай вывод.\n' +
  '3. Называй показатели так, как они называются в отчёте: «Незакупленные позиции», «Продажи АКБ», «Аксессуары», «ЭСДН», «Тёмные силы». ' +
  'Никогда не пиши английские или технические названия (dark, esdn, accessories, sales, plan, fact и т. п.) и не цитируй имена полей.\n' +
  '4. «Тёмные силы» измеряются долей точек, выполнивших план на 90% и выше, а не деньгами; к плану и факту «Тёмных сил» не добавляй «₽». Деньги (₽) — только там, где в сводке стоит «₽».\n' +
  '5. Приоритет — что быстрее всего даёт результат: сначала точки, близкие к порогу 90% («Тёмные силы»); потерянные точки, которые покупали в прошлом месяце, но не покупают в этом; разрыв до плана по «Аксессуарам» и «ЭСДН» с учётом того, сколько нужно продавать в рабочий день; ходовые позиции, которых нет у точки, хотя их берут другие точки канала.\n' +
  '6. Учитывай «Рабочих дней до конца месяца»: если дней мало — советуй самые быстрые действия.\n' +
  '7. Советы — про РАЗНЫЕ показатели, не больше двух на один. Каждый раз подходи свежо: не повторяй шаблонные формулировки, а при равном приоритете называй разные точки и позиции (значение «Вариант» в конце — зерно разнообразия).\n' +
  '8. Если у показателя в сводке стоит «данные: в отчёте нет ни одной точки… продаж нет» — это не отсутствие информации, а нулевые продажи. Считай факт нулём, а план (если он есть) невыполненным; назови показатель, сумму плана и дневную норму. Конкретные точки называй только если они разрешены ограничениями выше (для ЭСДН — только из списка «розничные точки для предложения ЭСДН»); для остальных показателей можно предложить активные точки из других разделов. Не придумывай причин, почему продаж нет.\n' +
  '9. Тон деловой, на «вы», без воды и мотивационных лозунгов. Текст совета — 2–3 предложения, до 350 символов.\n\n' +
  'ФОРМАТ: строго JSON {"tips":[{"kpi":"название показателя по-русски","title":"суть до 8 слов","text":"совет"}]}';

async function callGemini(summary, env, model){
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT + '\n\nВариант: ' + Math.floor(Math.random() * 1e6) + '\n\nСВОДКА:\n' + JSON.stringify(summary) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 }
      }),
      signal: ctrl.signal
    });
    if(!res.ok){
      const err = new Error('HTTP ' + res.status + ' [' + model + '] ' + (await res.text()).replace(/\s+/g, ' ').slice(0, 160));
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    const text = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts
      .map(function(p){ return p.text || ''; }).join('');
    const parsed = JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
    const tips = (parsed.tips || []).filter(function(t){ return t && t.text; }).slice(0, 6)
      .map(function(t){
        const kpi = String(t.kpi || '').trim(), title = String(t.title || '').trim();
        return { title: ((kpi && title) ? kpi + ': ' + title : (kpi || title)).slice(0, 90), text: String(t.text).slice(0, 450) };
      });
    return tips.length ? tips : null;
  } finally { clearTimeout(timer); }
}

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// Повторяем при временных ошибках (503/429/500/сеть/таймаут); при 400/403/404 повторять бессмысленно.
async function callWithRetry(summary, env){
  const models = [env.GEMINI_MODEL || DEFAULT_MODEL];
  if(FALLBACK_MODEL !== models[0]) models.push(FALLBACK_MODEL);
  let lastErr;
  for(const model of models){
    for(let i = 0; i <= RETRY_DELAYS_MS.length; i++){
      try{ return await callGemini(summary, env, model); }
      catch(e){
        lastErr = e;
        const transient = !e.status || e.status === 429 || e.status >= 500;
        if(!transient) break;               // постоянная ошибка — сразу к следующей модели
        if(i < RETRY_DELAYS_MS.length){ console.log('  … ' + model + ': ' + (e.status || 'сбой') + ', повтор через ' + RETRY_DELAYS_MS[i] / 1000 + ' с'); await sleep(RETRY_DELAYS_MS[i]); }
      }
    }
  }
  throw lastErr;
}

// pages: массив {slug, payload, managerName?}. Дописывает payload.tips там, где получилось.
async function addTips(pages, env){
  if(!env.GEMINI_API_KEY){ console.log('  💡 GEMINI_API_KEY не задан — советы пропущены.'); return; }
  for(const p of pages){
    if(!p.managerName) continue; // общая страница — без советов
    try{
      const summary = summarize(p.payload, p.managerName);
      const cand = summary['ЭСДН'] && summary['ЭСДН']['розничные точки для предложения ЭСДН'];
      console.log('  ℹ ' + p.slug + ': розничных точек-кандидатов для ЭСДН — ' + (Array.isArray(cand) ? cand.length : 0));
      const tips = await callWithRetry(summary, env);
      if(tips){ p.payload.tips = tips; console.log('  💡 ' + p.slug + ': советов ' + tips.length); }
    }catch(e){
      console.warn('  ⚠ Советы для «' + p.slug + '» не получены (' + (e && e.message ? e.message : e) + ') — страница соберётся без них.');
    }
  }
}

module.exports = { addTips, summarize };
