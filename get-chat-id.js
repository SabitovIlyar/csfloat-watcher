#!/usr/bin/env node
// Finds your Telegram chat id and writes it into .env, so you do not have to
// read raw JSON in the browser.
//
// Before running: send any message to your bot. Telegram will not hand out
// your chat id until you have written to the bot at least once.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(ROOT, '.env');

if (!existsSync(ENV_FILE)) {
  console.error('Нет файла .env рядом со скриптом. Скопируйте .env.example в .env.');
  process.exit(1);
}

const raw = readFileSync(ENV_FILE, 'utf8');

// Parse line by line: a multiline regex would let \s cross newlines and pick
// up the next line's content as the value.
function readVar(name) {
  for (const line of raw.split('\n')) {
    const m = line.match(new RegExp('^[ \\t]*' + name + '[ \\t]*=[ \\t]*(.*)$'));
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return null;
}

const token = readVar('TELEGRAM_BOT_TOKEN');

if (!token) {
  console.error('В .env не заполнен TELEGRAM_BOT_TOKEN.');
  console.error('Получите токен у @BotFather (/newbot) и впишите его в .env.');
  process.exit(1);
}

let body;
try {
  const res = await fetch('https://api.telegram.org/bot' + token + '/getUpdates');
  body = await res.json();
} catch (e) {
  console.error('Не удалось обратиться к Telegram: ' + e.message);
  process.exit(1);
}

if (!body.ok) {
  console.error('Telegram отклонил запрос: ' + (body.description ?? JSON.stringify(body)));
  if (body.error_code === 401) console.error('Скорее всего, токен скопирован с ошибкой.');
  process.exit(1);
}

// Collect distinct chats across whatever update types came back.
const chats = new Map();
for (const u of body.result ?? []) {
  const chat = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat;
  if (chat) chats.set(String(chat.id), chat);
}

if (chats.size === 0) {
  console.error('Telegram не вернул ни одного сообщения.\n');

  // Name the bot explicitly: messaging the wrong bot is the usual cause.
  try {
    const me = await (await fetch('https://api.telegram.org/bot' + token + '/getMe')).json();
    if (me.ok) {
      console.error('Токен принадлежит боту: @' + me.result.username + '  (' + me.result.first_name + ')');
      console.error('Откройте в Telegram именно его: https://t.me/' + me.result.username);
      console.error('и отправьте любое сообщение, затем запустите скрипт снова.\n');
    }
  } catch {
    /* diagnostics only */
  }

  // A webhook silently swallows every update, so getUpdates stays empty.
  try {
    const wh = await (await fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo')).json();
    if (wh.ok && wh.result?.url) {
      console.error('ВНИМАНИЕ: у бота включён вебхук (' + wh.result.url + ').');
      console.error('Пока он активен, getUpdates всегда пуст. Снять: /deleteWebhook у того же токена.');
    }
  } catch {
    /* diagnostics only */
  }

  console.error('Если вы писали боту давно — отправьте ещё одно сообщение:');
  console.error('Telegram хранит необработанные апдейты около суток.');
  process.exit(1);
}

console.log('Найдено чатов: ' + chats.size);
for (const [id, chat] of chats) {
  const who = chat.username ? '@' + chat.username : [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  console.log('  ' + id + '  ' + (who || chat.title || chat.type));
}

const [id] = [...chats.keys()];
if (chats.size > 1) {
  console.log('\nЧатов несколько, беру первый. Если нужен другой — впишите id в .env вручную.');
}

const line = 'TELEGRAM_CHAT_ID=' + id;
const target = /^[ \t]*TELEGRAM_CHAT_ID[ \t]*=.*$/m;
const updated = target.test(raw) ? raw.replace(target, line) : raw.trimEnd() + '\n' + line + '\n';

writeFileSync(ENV_FILE, updated);
console.log('\nЗаписано в .env: ' + line);
console.log('Теперь проверьте доставку:  node watch.js --test-telegram');
