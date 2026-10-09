// Парсеры отчётов 1С. Перенесены из админ-панели без изменений логики
// (функции normName ... parseDarkWorkbook из distribution-admin-v5.html).
// Единственное отличие: ALLOWED_MANAGERS, FULL_MML и XLSX приходят снаружи.
module.exports = function createParsers(XLSX, cfg){
  var ALLOWED_MANAGERS = cfg.managers;
  var FULL_MML = cfg.fullMml;

  function normName(v){ return String(v||'').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim(); }

  function cellText(v){ return (v===null||v===undefined) ? '' : String(v).trim(); }

  function findHeaderRowIdx(rows){
    for(var r=0;r<rows.length;r++){
      var row = rows[r];
      for(var c=0;c<row.length;c++){
        if(row[c] === 'Партнер' || row[c] === 'Торговая точка') return r;
      }
    }
    return -1;
  }
  function colIndexOf(row, label){
    for(var c=0;c<row.length;c++){ if(row[c]===label) return c; }
    return -1;
  }

  function extractPeriod(rows){
    var limit = Math.min(rows.length, 10);
    for(var r=0;r<limit;r++){
      var row = rows[r];
      for(var c=0;c<row.length;c++){
        var v = row[c];
        if(typeof v === 'string'){
          var m = /Период:\s*(.+)/i.exec(v.trim());
          if(m) return m[1].trim();
        }
      }
    }
    return null;
  }

  // New report format: one row of column labels ("Основной менеджер", "Партнер", ...),
  // a sub-row naming the measure ("ММЛ Показатель" / "Значение") that marks which
  // columns are product columns, then data rows with "Есть" / blank per product.
  function parseChannelSheet(rows, channelLabel){
    var hdrIdx = findHeaderRowIdx(rows);
    if(hdrIdx < 0) throw new Error('не найдена строка заголовка (колонка «Партнер» / «Торговая точка»)');
    var headerRow = rows[hdrIdx];
    var subRow = rows[hdrIdx+1] || [];

    var ttCol = colIndexOf(headerRow, 'Партнер');
    if(ttCol < 0) ttCol = colIndexOf(headerRow, 'Торговая точка');
    if(ttCol < 0) throw new Error('не найдена колонка «Партнер» / «Торговая точка»');
    var mgrCol = colIndexOf(headerRow, 'Основной менеджер');
    if(mgrCol < 0) throw new Error('не найдена колонка «Основной менеджер»');
    var statusClientCol = colIndexOf(headerRow, 'Партнер.Статус клиента (Общие)');
    var statusPointCol = colIndexOf(headerRow, 'Партнер.Статус точки');

    var prodStart = -1;
    for(var i=0;i<subRow.length;i++){
      var sv = subRow[i];
      if(sv !== null && sv !== undefined && String(sv).trim() !== ''){ prodStart = i; break; }
    }
    if(prodStart < 0) throw new Error('не найдена строка-подзаголовок показателя над товарами');
    var prodEnd = prodStart - 1;
    for(var i=prodStart; i<subRow.length; i++){
      var sv = subRow[i];
      var hv = headerRow[i];
      if(sv === null || sv === undefined || String(sv).trim() === '') break;
      if(hv && String(hv).trim().toLowerCase() === 'итого') break;
      prodEnd = i;
    }
    if(prodEnd < prodStart) throw new Error('не найдено ни одной товарной позиции');

    var products = [];
    for(var pc = prodStart; pc <= prodEnd; pc++){
      var raw = cellText(headerRow[pc]);
      if(!raw) continue;
      var sp = raw.indexOf(' ');
      var grp = sp >= 0 ? raw.slice(0, sp) : raw;
      products.push({ col: pc, full: raw, group: grp });
    }
    if(!products.length) throw new Error('не найдено ни одной товарной позиции');

    // сверяем колонки отчёта с полным ММЛ канала и добавляем отсутствующие позиции
    var canon = FULL_MML[channelLabel] || [];
    var canonByNorm = {};
    canon.forEach(function(c){ canonByNorm[normName(c.n)] = c; });
    var seen = {};
    products.forEach(function(pr){
      var c = canonByNorm[normName(pr.full)];
      if(c){ pr.full = c.n; pr.group = c.g; seen[c.n] = true; }
    });
    canon.forEach(function(c){
      if(!seen[c.n]) products.push({ col: -1, full: c.n, group: c.g });
    });

    var out = [];
    for(var r = hdrIdx+2; r < rows.length; r++){
      var row = rows[r];
      var tt = cellText(row[ttCol]);
      if(!tt) break;
      var manager = cellText(row[mgrCol]);
      if(!manager) continue;
      if(ALLOWED_MANAGERS.indexOf(manager) === -1) continue;
      var entry = {
        t: tt, m: manager, c: channelLabel,
        reg: null, city: null, typ: null, net: null, addr: null,
        st: statusPointCol>=0 ? cellText(row[statusPointCol]) : (statusClientCol>=0 ? cellText(row[statusClientCol]) : null),
        p: {}, g: {}
      };
      products.forEach(function(pr){
        var v = pr.col >= 0 ? row[pr.col] : null;
        var present = (v !== null && v !== undefined && String(v).trim() !== '') ? 1 : 0;
        entry.p[pr.full] = Math.max(entry.p[pr.full] || 0, present);
        entry.g[pr.full] = pr.group;
      });
      out.push(entry);
    }
    return out;
  }

  function parseChannelWorkbook(wb, channelLabel){
    var sheetName = wb.SheetNames[0];
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, raw:true, defval:null});
    var period = extractPeriod(rows);
    var data = parseChannelSheet(rows, channelLabel);
    return { data: data, period: period };
  }

  // "Sales by month" report: manager subtotal rows + client rows, with repeating
  // month blocks (each a "Выручка"/"Итого АКБ" column pair) under a group row.
  var MONTH_RE = /^(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь)\s+\d{4}\s*г\.?$/i;

  function findSalesHeaderRowIdx(rows){
    for(var r=0;r<rows.length;r++){
      var row = rows[r];
      for(var c=0;c<row.length;c++){
        if(row[c] === 'Клиент') return r;
      }
    }
    return -1;
  }

  function parseSalesSheet(rows){
    var hdrIdx = findSalesHeaderRowIdx(rows);
    if(hdrIdx < 0) throw new Error('не найдена строка заголовка (колонка «Клиент»)');
    var headerRow = rows[hdrIdx];
    var groupRow = rows[hdrIdx-1] || [];

    var ttCol = colIndexOf(headerRow, 'Клиент');
    if(ttCol < 0) throw new Error('не найдена колонка «Клиент»');

    var mgrCol = -1;
    for(var c=0;c<groupRow.length;c++){
      if(groupRow[c] === 'Клиент.Основной менеджер' && c !== ttCol){ mgrCol = c; break; }
    }
    if(mgrCol < 0) throw new Error('не найдена колонка менеджера');

    var channelCol = -1;
    for(var c=0;c<groupRow.length;c++){
      if(groupRow[c] === 'Клиент.Тип клиента (Клиенты).Входит в группу'){ channelCol = c; break; }
    }

    var monthBlocks = [];
    for(var c=0;c<groupRow.length;c++){
      var v = groupRow[c];
      if(typeof v === 'string' && MONTH_RE.test(v.trim())){
        monthBlocks.push({ label: v.trim(), revenueCol: c });
      }
    }
    if(!monthBlocks.length) throw new Error('не найдено ни одного периода (столбцов с названием месяца)');

    var out = [];
    for(var r = hdrIdx+1; r < rows.length; r++){
      var row = rows[r];
      var tt = cellText(row[ttCol]);
      if(!tt) continue;
      var manager = cellText(row[mgrCol]);
      if(!manager) continue;
      if(ALLOWED_MANAGERS.indexOf(manager) === -1) continue;
      var months = monthBlocks.map(function(mb){
        var rev = row[mb.revenueCol];
        return { label: mb.label, revenue: (rev === null || rev === undefined || rev === '') ? 0 : rev };
      });
      out.push({
        t: tt, m: manager,
        channel: channelCol>=0 ? cellText(row[channelCol]) : null,
        months: months
      });
    }
    return out;
  }

  function parseSalesWorkbook(wb){
    var sheetName = wb.SheetNames[0];
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, raw:true, defval:null});
    var period = extractPeriod(rows);
    var data = parseSalesSheet(rows);
    return { data: data, period: period };
  }

  // KPI-отчёты («Кальяны и аксессуары», «ЭСДН»): строка-группа с месяцами,
  // строка заголовка («Клиент»), затем подытоги менеджеров, строки точек
  // (есть канал) и строки товаров (без канала — относятся к предыдущей точке).
  function findKpiGroupRowIdx(rows){
    for(var r=0;r<rows.length;r++){
      var row = rows[r];
      for(var c=0;c<row.length;c++){
        if(row[c] === 'Клиент.Основной менеджер') return r;
      }
    }
    return -1;
  }

  function numVal(v){
    if(v === null || v === undefined || v === '') return 0;
    if(typeof v === 'number') return v;
    var n = parseFloat(String(v).replace(/[\s\xa0]/g,'').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }

  function looksLikeManager(name){
    if(!/^[А-ЯЁ][а-яё\-]+( [А-ЯЁ][а-яё\-]+)+$/.test(name)) return false;
    if(/["0-9()/·]/.test(name)) return false;
    return true;
  }

  function parseKpiSheet(rows){
    var gIdx = findKpiGroupRowIdx(rows);
    if(gIdx < 0) throw new Error('не найдена строка-группа (колонка «Клиент.Основной менеджер»)');
    var groupRow = rows[gIdx];
    var headerRow = rows[gIdx+1] || [];

    var nameCol = colIndexOf(headerRow, 'Клиент');
    if(nameCol < 0) throw new Error('не найдена колонка «Клиент»');
    var typeCol = colIndexOf(groupRow, 'Клиент.Тип клиента (Клиенты)');
    var channelCol = colIndexOf(groupRow, 'Клиент.Тип клиента (Клиенты).Входит в группу');
    if(channelCol < 0) throw new Error('не найдена колонка канала');

    var monthBlocks = [];
    for(var c=0;c<groupRow.length;c++){
      var v = groupRow[c];
      if(typeof v === 'string' && MONTH_RE.test(v.trim())){
        var qtyCol = (c+1 < headerRow.length && headerRow[c+1] === 'Количество') ? c+1 : -1;
        monthBlocks.push({ label: v.trim(), revCol: c, qtyCol: qtyCol });
      }
    }
    if(!monthBlocks.length) throw new Error('не найдено ни одного периода (столбцов с названием месяца)');
    var hasQty = monthBlocks.some(function(mb){ return mb.qtyCol >= 0; });

    var currentManager = null;
    var currentPoint = null;
    var out = [];

    for(var r = gIdx+2; r < rows.length; r++){
      var row = rows[r];
      var name = cellText(row[nameCol]);
      if(!name) continue;
      if(name === 'Итого') break;
      if(ALLOWED_MANAGERS.indexOf(name) !== -1 || looksLikeManager(name)){
        currentManager = ALLOWED_MANAGERS.indexOf(name) !== -1 ? name : null;
        currentPoint = null;
        continue;
      }
      var typ = typeCol >= 0 ? cellText(row[typeCol]) : '';
      var chan = cellText(row[channelCol]);
      if(typ || chan){
        if(!currentManager) continue;
        var entry = {
          t: name, m: currentManager,
          typ: typ || null, channel: chan || null,
          months: monthBlocks.map(function(){ return { label: '', revenue: 0, qty: 0 }; }),
          _pr: monthBlocks.map(function(){ return 0; }),
          _pq: monthBlocks.map(function(){ return 0; })
        };
        monthBlocks.forEach(function(mb, i){
          entry.months[i].label = mb.label;
          var rv = numVal(row[mb.revCol]);
          if(rv) entry.months[i].revenue = rv;
          if(mb.qtyCol >= 0){
            var qv = numVal(row[mb.qtyCol]);
            if(qv) entry.months[i].qty = qv;
          }
        });
        out.push(entry);
        currentPoint = entry;
        continue;
      }
      if(currentPoint){
        monthBlocks.forEach(function(mb, i){
          currentPoint._pr[i] += numVal(row[mb.revCol]);
          if(mb.qtyCol >= 0) currentPoint._pq[i] += numVal(row[mb.qtyCol]);
        });
      }
    }

    out.forEach(function(e){
      e.months.forEach(function(mo, i){
        if(!mo.revenue) mo.revenue = Math.round(e._pr[i] * 100) / 100;
        if(hasQty && !mo.qty) mo.qty = Math.round(e._pq[i] * 1000) / 1000;
      });
      if(!hasQty) e.months.forEach(function(mo){ delete mo.qty; });
      delete e._pr;
      delete e._pq;
    });
    return out;
  }

  function parseKpiWorkbook(wb){
    var sheetName = wb.SheetNames[0];
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, raw:true, defval:null});
    var period = extractPeriod(rows);
    var data = parseKpiSheet(rows);
    return { data: data, period: period };
  }

  // ---------- «Тёмные силы»: план (колонка «Партнер.ТС …») / факт («Итог этого месяца») ----------
  function parseDarkSheet(rows){
    var hdrIdx = findHeaderRowIdx(rows);
    if(hdrIdx < 0) throw new Error('не найдена строка заголовка (колонка «Партнер»)');
    var header = rows[hdrIdx];
    var nameCol = colIndexOf(header, 'Партнер');
    var mgrCol = colIndexOf(header, 'Основной менеджер');
    if(mgrCol < 0) throw new Error('не найдена колонка «Основной менеджер»');
    var planCol = -1, factCol = -1;
    for(var c=0;c<header.length;c++){
      var h = cellText(header[c]);
      if(planCol < 0 && /^Партнер\.ТС/i.test(h)) planCol = c;
      if(factCol < 0 && /^Итог/i.test(h)) factCol = c;
    }
    if(planCol < 0) throw new Error('не найдена колонка плана («Партнер.ТС …»)');
    if(factCol < 0) throw new Error('не найдена колонка факта («Итог этого месяца»)');

    var out = [];
    for(var r = hdrIdx+1; r < rows.length; r++){
      var row = rows[r];
      var name = cellText(row[nameCol]);
      if(!name || /^Итого/i.test(name)) continue;
      var manager = cellText(row[mgrCol]);
      if(ALLOWED_MANAGERS.indexOf(manager) === -1) continue;
      out.push({ t: name, m: manager, plan: numVal(row[planCol]), fact: numVal(row[factCol]) });
    }
    return out;
  }

  function parseDarkWorkbook(wb){
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true, defval:null});
    return { data: parseDarkSheet(rows), period: extractPeriod(rows) };
  }

  return {
    parseChannelWorkbook: parseChannelWorkbook,
    parseSalesWorkbook: parseSalesWorkbook,
    parseKpiWorkbook: parseKpiWorkbook,
    parseDarkWorkbook: parseDarkWorkbook
  };
};
