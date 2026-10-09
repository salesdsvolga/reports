// Забирает вложения из самого свежего письма с нужной темой по IMAP (Яндекс Почта).
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function pickAttachments(parsed){
  return (parsed.attachments || [])
    .filter(function(a){ return a.filename; })
    .map(function(a){ return { filename: a.filename, content: a.content }; });
}

async function fetchFromMail(cfg, env){
  const user = env.MAIL_USER, pass = env.MAIL_PASSWORD;
  if(!user || !pass) throw new Error('Не заданы секреты MAIL_USER и MAIL_PASSWORD (Settings → Secrets and variables → Actions).');
  const m = cfg.mail;
  const client = new ImapFlow({ host: m.host, port: m.port, secure: m.secure !== false, auth: { user: user, pass: pass }, logger: false });
  try{ await client.connect(); }
  catch(e){ throw new Error('Не удалось войти в почту (' + (e.responseText || e.message) + '). Проверьте MAIL_USER, MAIL_PASSWORD (нужен пароль приложения) и что IMAP включён.'); }
  try{
    const lock = await client.getMailboxLock(m.folder);
    try{
      const since = new Date(Date.now() - m.searchDays * 86400000);
      const uids = await client.search({ since: since, subject: m.subject }, { uid: true });
      const cands = [];
    if(uids && uids.length){
  const want = String(m.subject).trim();
  // «123» / «123 от 08.10.2026» — подходит; «1234 …» и «8123 …» — нет
  const re = new RegExp('^' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)');
  for await (const msg of client.fetch(uids.join(','), { envelope: true, internalDate: true }, { uid: true })){
    const subj = String((msg.envelope && msg.envelope.subject) || '').trim();
    if(re.test(subj)) cands.push({ uid: msg.uid, date: new Date(msg.internalDate), subject: subj });
  }
}
      if(!cands.length) throw new Error('Не найдено письмо с темой «' + m.subject + '» за последние ' + m.searchDays + ' дн. в папке ' + m.folder + '.');
      cands.sort(function(a, b){ return b.date - a.date; });
      const best = cands[0];
      const ageH = (Date.now() - best.date.getTime()) / 3600000;
      if(ageH > m.maxAgeHours){
        throw new Error('Самое свежее письмо «' + m.subject + '» старое: ' + best.date.toISOString() + ' (' + Math.round(ageH) + ' ч назад, лимит ' + m.maxAgeHours + ' ч). Возможно, 1С не отправила отчёты.');
      }
      const full = await client.fetchOne(best.uid, { source: true }, { uid: true });
      const parsed = await simpleParser(full.source);
      return { files: pickAttachments(parsed), date: best.date };
    } finally { lock.release(); }
  } finally { try{ await client.logout(); }catch(e){} }
}

// Для проверок без почты: разобрать сохранённое письмо .eml
async function readEml(buf){
  const parsed = await simpleParser(buf);
  return { files: pickAttachments(parsed), date: parsed.date || new Date() };
}

module.exports = { fetchFromMail, readEml };
