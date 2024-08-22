import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { StringSession } from 'telegram/sessions/index.js';
import { createObjectCsvWriter } from 'csv-writer';
import { TelegramClient } from 'telegram/index.js';
import { Api } from 'telegram/tl/index.js';
import schedule from 'node-schedule';
import bigInt from "big-integer";
import winston from 'winston';
import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import OpenAI from 'openai';
import Redis from 'ioredis';
import path from 'path';
import pkg from 'pg';
import fs from 'fs';

// Загрузка переменных окружения и инициализация
dotenv.config();

const { Pool } = pkg;
const app = express();

const BOT_ID = process.env.BOT_ID!;
const PORT = process.env.PORT || 3000;
const API_HASH = process.env.API_HASH!;
const DB_URL = process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL!;
const DEEP_LOG = process.env.DEEP_LOG === 'true';
const API_ID = parseInt(process.env.API_ID!, 10);
const SESSION_STRING = process.env.SESSION_STRING!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const ADMIN_ID = parseInt(process.env.ADMIN_ID!, 10);
const BOT_ACCESS_HASH = process.env.BOT_ACCESS_HASH!;
const DB_CHECK_INTERVAL = parseInt(process.env.DB_CHECK_INTERVAL || '60000', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '300000', 10);

// Настройка Redis с персистентностью
const redis = new Redis.Redis(REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
  keepAlive: 10000,
  family: 4,
  db: 0
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Настройка логгера
const logger = winston.createLogger({
  level: DEEP_LOG ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

const log = (msg: string) => logger.info(msg);
const logErr = (ctx: string, err: unknown) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`Error in ${ctx}: ${errMsg}`);
  notify(`Error in ${ctx}: ${errMsg}`).catch(e => 
    logger.error(`Failed to notify admin: ${e instanceof Error ? e.message : String(e)}`)
  );
};

// Интерфейсы и типы
interface Report {
  reportId: string;
  messageContent?: string[];
  mediaHashes?: string[];
  complaintCount: number;
  source: string;
  sender: string;
  spamProbability: number;
  hasExternalLink: boolean;
  hasInternalLink: boolean;
  modFlood: number;
  modNotSpam: number;
  isSpam: boolean;
  reason?: string;
  confidence?: number;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

interface SpamDecision {
  isSpam: boolean;
  reason?: string;
  confidence?: number;
}

interface SysInfo {
  complaintCount: number;
  source: string;
  sender: string;
  hasLink: boolean;
  telegramSpamProbability: number;
}

enum ReportProcessingState {
  IDLE,
  WAITING_FOR_MODERATOR_OPINION,
  WAITING_FOR_NEXT_REPORT
}

// Конфигурация проверок
const checkConfig = {
  obviousSpam: true,
  cache: true,
  gpt: true,
  moderators: true
};

// Глобальные переменные
let client: TelegramClient;
let botEntity: Api.InputPeerUser | null = null;
let currentReport: Partial<Report> = {};
let autoMode = false;
let isProcessing = false;
let notifyAttempts = 0;
let currentState: ReportProcessingState = ReportProcessingState.IDLE;
let PROCESSING_INTERVAL = parseInt(process.env.PROCESSING_INTERVAL || '1000', 10);
let COMMAND_DELAY = parseInt(process.env.COMMAND_DELAY || '150', 10);

const MAX_NOTIFY_ATTEMPTS = 3;
const reportQueue: Report[] = [];
const dangEx = ['.exe', '.apk', '.bat', '.cmd', '.msi', '.vbs', '.js', '.scr', '.pif'];

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  spamProbability: /(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/,
  externalLink: /🔴/,
  internalLink: /🔶/
};

// Функции проверки спама
async function checkObviousSpam(report: Report): Promise<SpamDecision | null> {
  if (!checkConfig.obviousSpam) return null;

  if ((report.mediaHashes?.length || 
      report.messageContent?.some(msg => msg.includes('http') || msg.includes('@') || msg.match(/\+?[0-9]{10,14}/))) 
     && report.complaintCount > 2) {
    return { isSpam: true, reason: 'Media or links with high complaint count', confidence: 100 };
  }

  if (report.messageContent?.some(msg => msg.includes('story'))) {
    return { isSpam: true, reason: 'Story content', confidence: 100 };
  }

  // Добавьте здесь другие проверки на очевидный спам

  return null;
}

async function checkCache(report: Report): Promise<SpamDecision | null> {
  if (!checkConfig.cache) return null;

  try {
    const key = `report:${report.reportId}`;
    const cachedResult = await redis.get(key);
    if (cachedResult) {
      const cachedReport = JSON.parse(cachedResult) as Report;
      if (isReportIdentical(report, cachedReport)) {
        DEEP_LOG && log(`Cache hit for report ${report.reportId}`);
        return { 
          isSpam: cachedReport.isSpam, 
          confidence: cachedReport.confidence || 100, 
          reason: 'Cached result' 
        };
      }
    }
    DEEP_LOG && log(`Cache miss for report ${report.reportId}`);
    return null;
  } catch (error) {
    logErr('checkCache', error);
    return null;
  }
}

async function checkGPT(report: Report, sysInfo: SysInfo): Promise<SpamDecision | null> {
  if (!checkConfig.gpt) {
    DEEP_LOG && log('GPT check is disabled');
    return null;
  }

  const model = await selectGptModel(report.messageContent?.join(' ') || '');
  const gptPrompt = `Analyze multilingual Telegram messages for spam. Use provided context (complaints, source, sender) but focus primarily on message content. Classify as spam or not spam and provide a confidence score from 0 to 100.


Spam (1) if clear:
1. Commercial:
   - Unsolicited ads, subtle marketing
   - Self-promotion of unrelated channels/groups
   - Disguised promotions (e.g., informative messages with channel links)
2. Scams/Financial:
   - Phishing, fake giveaways, get-rich-quick schemes
   - Unrealistic financial promises, urgent decisions
   - Suspicious cryptocurrency/airdrop mentions
   - Offers of quick money or short-term "jobs"
3. Deceptive/Adult:
   - Impersonation, false promises
   - Explicit content, unsolicited services
   - Subtle invitations for private meetings, coded language
   - Requests for private photos/information
4. Unwanted:
   - Chain messages, excessive invites
   - Unsolicited job offers, surveys, personal requests
   - Irrelevant business/political/religious messages
5. Suspicious Behavior:
   - Bot-like messages, repetitive content
   - Attempts to move conversations to private channels
   - Excessive emojis, especially at line starts
   - Bypass attempts (e.g., unusual symbols)
6. Harmful:
   - Incitement to violence/illegal activities
   - Sharing others' personal information

Not Spam (0) for:
1. Normal Interactions:
   - Greetings, casual conversation, jokes
   - Short messages, single words, numbers, or emojis (unless suspicious pattern)
   - Questions, replies, opinions, reactions
   - Any form of inquiry or response
2. Legitimate Information:
   - Relevant news, educational content
   - Warnings about scams/spam (educational context)
3. Group Activities:
   - Bot commands (starting with "/"), unless they have 3 or more complaints
   - Relevant polls
   - Political discussions (unless inciting violence or illegal activities)
   - Any message that could be relevant to a group's theme
4. Expressive Language:
   - Profanity, crude language
   - Emotional outbursts or rants
   - Insults, arguments, or disagreements, even if very offensive or aggressive
5. Cultural Content:
   - Local slang, cultural references/jokes
   - Regional news/events discussion
6. Any message without clear spam indicators

Key Factors:
1. Message content and intent in any language
2. Relevance to the group's theme (provided in 'Source')
3. Number of complaints
4. Sender's behavior pattern

Important Notes:
- The 'Source' field indicates the group name. Use it for context, not as a spam indicator.
- Telegram's spam probability is a minor factor; don't rely on it heavily.
- Normal conversations, including casual chat and emoji usage, are not spam.
- Short messages are usually not spam unless part of a suspicious pattern.
- Personal opinions or reactions are generally not spam.
- Business or financial discussions are allowed unless clearly scams or promotions.
- Messages with high complaint counts should be scrutinized carefully, but complaint count alone is not definitive proof of spam.
- Be extra cautious with messages offering quick money or short-term "jobs", especially if they mention specific amounts.

Output: A single number from 0 to 100 representing spam likelihood:
0-24: Confident it's not spam
25-49: Leaning towards not spam
50: Too ambiguous to determine
51-75: Leaning towards spam
76-100: Confident it's spam`;

  const userPrompt = `Analyze:
"${report.messageContent?.join('\n')}"
Complaints: ${sysInfo.complaintCount}
Source (Group Name): ${sysInfo.source}
Sender: ${sysInfo.sender}
Spam Prob: ${sysInfo.telegramSpamProbability}

Spam likelihood (0-100):`;

  try {
    const response = await retryGptRequest(
      () => openai.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: gptPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 5,
        temperature: 0.1,
      }),
      2,
      30000,
      35000
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Empty GPT response');
    }

    const spamLikelihood = parseInt(content);
    
    if (isNaN(spamLikelihood) || spamLikelihood < 0 || spamLikelihood > 100) {
      throw new Error(`Invalid GPT response: ${content}`);
    }

    DEEP_LOG && log(`GPT spam likelihood: ${spamLikelihood}`);

    return {
      isSpam: spamLikelihood > 50,
      confidence: spamLikelihood,
      reason: `GPT assessment: ${spamLikelihood}`
    };
  } catch (error) {
    logErr('checkGPT', error);
    // В случае ошибки возвращаем null, чтобы система могла принять решение на основе других факторов
    return null;
  }
}

async function checkModerators(report: Report): Promise<SpamDecision | null> {
  if (!checkConfig.moderators) return null;

  if (report.modFlood >= 2) return { isSpam: true, confidence: 100, reason: 'Moderators: Flood' };
  if (report.modNotSpam >= 2) return { isSpam: false, confidence: 0, reason: 'Moderators: Not Spam' };
  if (report.modFlood === 1 && report.modNotSpam === 0) return { isSpam: true, confidence: 75, reason: 'Moderators: Leaning Flood' };
  if (report.modNotSpam === 1 && report.modFlood === 0) return { isSpam: false, confidence: 25, reason: 'Moderators: Leaning Not Spam' };
  if (report.modFlood === 1 && report.modNotSpam === 1) return { isSpam: false, confidence: 49, reason: 'Moderators: Conflicting opinions' };
  
  return null;
}

// Основная функция обработки отчета
async function processReport(report: Report): Promise<void> {
  const startTime = Date.now();

  const sysInfo: SysInfo = {
    complaintCount: report.complaintCount,
    source: report.source,
    sender: report.sender,
    hasLink: report.hasExternalLink || report.hasInternalLink,
    telegramSpamProbability: report.spamProbability
  };

  // Проверка кэша
  if (checkConfig.cache) {
    const cachedDecision = await checkCache(report);
    if (cachedDecision) {
      DEEP_LOG && log(`Using cached result: ${cachedDecision.isSpam ? 'SPAM' : 'NOT SPAM'}`);
      await delay(COMMAND_DELAY);
      await sendDecision(cachedDecision.isSpam ? '😡 SPAM' : '😌 NO');
      await ensureMinimumInterval(startTime, PROCESSING_INTERVAL);
      return;
    }
  }

  // Проверка на очевидный спам
  if (checkConfig.obviousSpam) {
    const obviousSpamDecision = await checkObviousSpam(report);
    if (obviousSpamDecision) {
      DEEP_LOG && log(`Obvious spam detected: ${obviousSpamDecision.reason}`);
      await delay(COMMAND_DELAY);
      await sendDecision(obviousSpamDecision.isSpam ? '😡 SPAM' : '😌 NO');
      await saveReport({ ...report, ...obviousSpamDecision });
      await ensureMinimumInterval(startTime, PROCESSING_INTERVAL);
      return;
    }
  }

  // GPT проверка
  let gptDecision: SpamDecision | null = null;
  if (checkConfig.gpt) {
    gptDecision = await checkGPT(report, sysInfo);
    if (gptDecision && (gptDecision.confidence! <= 24 || gptDecision.confidence! >= 76)) {
      DEEP_LOG && log(`GPT decision: ${gptDecision.isSpam ? 'SPAM' : 'NOT SPAM'} (${gptDecision.confidence})`);
      await delay(COMMAND_DELAY);
      await sendDecision(gptDecision.isSpam ? '😡 SPAM' : '😌 NO');
      await saveReport({ ...report, ...gptDecision });
      await ensureMinimumInterval(startTime, PROCESSING_INTERVAL);
      return;
    }
  }

  // Проверка модераторов
  let moderatorDecision: SpamDecision | null = null;
  if (checkConfig.moderators) {
    await delay(COMMAND_DELAY);
    await sendToBot("/stats");
    await delay(COMMAND_DELAY);
    await sendToBot(report.reportId);

    currentState = ReportProcessingState.WAITING_FOR_MODERATOR_OPINION;

    // Ожидаем мнения модераторов
    const moderatorOpinionTimeout = 30000; // 30 секунд максимального ожидания
    const moderatorOpinionStartTime = Date.now();
    while (currentState === ReportProcessingState.WAITING_FOR_MODERATOR_OPINION) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (Date.now() - moderatorOpinionStartTime > moderatorOpinionTimeout) {
        DEEP_LOG && log("Timeout waiting for moderator opinions");
        break;
      }
    }

    moderatorDecision = await checkModerators(report);
    
    await delay(COMMAND_DELAY);
    await sendToBot("/next");
  }

  // Принятие решения
  let finalDecision: SpamDecision;
  if (moderatorDecision) {
    finalDecision = moderatorDecision;
    DEEP_LOG && log(`Using moderator decision: ${finalDecision.isSpam ? 'SPAM' : 'NOT SPAM'} (${finalDecision.confidence})`);
  } else if (gptDecision) {
    finalDecision = gptDecision;
    DEEP_LOG && log(`Using GPT decision: ${finalDecision.isSpam ? 'SPAM' : 'NOT SPAM'} (${finalDecision.confidence})`);
  } else {
    // Если нет решения ни от модераторов, ни от GPT, принимаем решение на основе количества жалоб и спам-вероятности от Telegram
    const spamScore = report.complaintCount * 10 + report.spamProbability;
    finalDecision = {
      isSpam: spamScore >= 50,
      confidence: Math.min(Math.max(spamScore, 0), 100),
      reason: `Decision based on complaint count (${report.complaintCount}) and Telegram spam probability (${report.spamProbability})`
    };
    DEEP_LOG && log(`Using complaint count and Telegram probability decision: ${finalDecision.isSpam ? 'SPAM' : 'NOT SPAM'} (${finalDecision.confidence})`);
  }

  // Отправляем решение
  await delay(COMMAND_DELAY);
  await sendDecision(finalDecision.isSpam ? '😡 SPAM' : '😌 NO');
  await saveReport({ ...report, ...finalDecision });

  currentState = ReportProcessingState.WAITING_FOR_NEXT_REPORT;

  // Ожидаем следующий отчет
  const nextReportTimeout = 10000; // 10 секунд максимального ожидания
  const nextReportStartTime = Date.now();
  while (currentState === ReportProcessingState.WAITING_FOR_NEXT_REPORT) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (Date.now() - nextReportStartTime > nextReportTimeout) {
      DEEP_LOG && log("Timeout waiting for next report");
      break;
    }
  }

  currentState = ReportProcessingState.IDLE;
  await ensureMinimumInterval(startTime, PROCESSING_INTERVAL);
}

// Вспомогательная функция для создания задержки
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Вспомогательные функции
function preprocessMessage(message: string): string {
  return message.split('\n').slice(1).join('\n');
}

function parseSysMsg(msg: string): Partial<Report> {
  const info: Partial<Report> = {
    modFlood: 0,
    modNotSpam: 0,
    hasExternalLink: false,
    hasInternalLink: false,
    spamProbability: 0
  };

  const reportIdMatch = msg.match(sysRegex.reportId);
  if (reportIdMatch) info.reportId = reportIdMatch[0];

  const complaintMatch = msg.match(sysRegex.complaintCount);
  if (complaintMatch) info.complaintCount = parseInt(complaintMatch[1]);

  info.hasExternalLink = sysRegex.externalLink.test(msg);
  info.hasInternalLink = sysRegex.internalLink.test(msg);

  const sourceMatch = msg.match(sysRegex.source);
  if (sourceMatch) info.source = sourceMatch[1].trim();

  const senderMatch = msg.match(sysRegex.sender);
  if (senderMatch) info.sender = senderMatch[1].trim();

  const spamProbMatch = msg.match(sysRegex.spamProbability);
  if (spamProbMatch) info.spamProbability = parseInt(spamProbMatch[1]);

  const lines = msg.split('\n');
  for (const line of lines) {
    if (sysRegex.modFlood.test(line)) {
      info.modFlood = (info.modFlood || 0) + 1;
    }
    if (sysRegex.modNotSpam.test(line)) {
      info.modNotSpam = (info.modNotSpam || 0) + 1;
    }
  }

  return info;
}

async function getMediaHash(media: Api.TypeMessageMedia): Promise<string> {
  if (media instanceof Api.MessageMediaPhoto && media.photo)
    return `photo:${media.photo.id.toString()}`;
  if (media instanceof Api.MessageMediaDocument && media.document)
    return `doc:${media.document.id.toString()}`;
  if (media instanceof Api.MessageMediaWebPage && media.webpage && 'id' in media.webpage)
    return `webpage:${media.webpage.id.toString()}`;
  if (media instanceof Api.MessageMediaPoll && media.poll)
    return `poll:${media.poll.id}`;
  if (media instanceof Api.MessageMediaGeo && media.geo && 'long' in media.geo && 'lat' in media.geo)
    return `geo:${media.geo.long},${media.geo.lat}`;
  if (media instanceof Api.MessageMediaContact)
    return `contact:${media.phoneNumber}`;
  if (media instanceof Api.MessageMediaGame && media.game)
    return `game:${media.game.id}`;
  if (media instanceof Api.MessageMediaInvoice)
    return `invoice:${media.title}`;
  if (media instanceof Api.MessageMediaGeoLive && media.geo && 'long' in media.geo && 'lat' in media.geo)
    return `geolive:${media.geo.long},${media.geo.lat}`;
  if (media instanceof Api.MessageMediaDice)
    return `dice:${media.value}`;
  if (media instanceof Api.MessageMediaStory)
    return `story:${media.id}`;

  return `unknown:${crypto.createHash('md5').update(JSON.stringify(media)).digest('hex')}`;
}

function validateReport(report: Partial<Report>): ValidationResult {
  if (!report.reportId || typeof report.reportId !== 'string') {
    return { isValid: false, error: `Invalid or missing reportId: ${JSON.stringify(report.reportId)}` };
  }
  if (report.complaintCount === undefined || typeof report.complaintCount !== 'number' || report.complaintCount < 0) {
    return { isValid: false, error: `Invalid or missing complaintCount: ${JSON.stringify(report.complaintCount)}` };
  }
  if (!report.source || typeof report.source !== 'string') {
    return { isValid: false, error: `Invalid or missing source: ${JSON.stringify(report.source)}` };
  }
  if (!report.sender || typeof report.sender !== 'string') {
    return { isValid: false, error: `Invalid or missing sender: ${JSON.stringify(report.sender)}` };
  }
  if (report.spamProbability !== undefined && (typeof report.spamProbability !== 'number' || report.spamProbability < 0 || report.spamProbability > 100)) {
    return { isValid: false, error: `Invalid spamProbability: ${JSON.stringify(report.spamProbability)}` };
  }
  if (report.hasExternalLink !== undefined && typeof report.hasExternalLink !== 'boolean') {
    return { isValid: false, error: `Invalid hasExternalLink: ${JSON.stringify(report.hasExternalLink)}` };
  }
  if (report.hasInternalLink !== undefined && typeof report.hasInternalLink !== 'boolean') {
    return { isValid: false, error: `Invalid hasInternalLink: ${JSON.stringify(report.hasInternalLink)}` };
  }
  if (report.modFlood !== undefined && (typeof report.modFlood !== 'number' || report.modFlood < 0)) {
    return { isValid: false, error: `Invalid modFlood: ${JSON.stringify(report.modFlood)}` };
  }
  if (report.modNotSpam !== undefined && (typeof report.modNotSpam !== 'number' || report.modNotSpam < 0)) {
    return { isValid: false, error: `Invalid modNotSpam: ${JSON.stringify(report.modNotSpam)}` };
  }

  return { isValid: true };
}

function isReportIdentical(report1: Report, report2: Report): boolean {
  return report1.messageContent?.join('') === report2.messageContent?.join('') &&
         JSON.stringify(report1.mediaHashes) === JSON.stringify(report2.mediaHashes) &&
         report1.complaintCount === report2.complaintCount;
}

async function saveToCache(report: Report) {
  try {
    const key = `report:${report.reportId}`;
    const value = JSON.stringify({
      ...report,
      cachedAt: Date.now()
    });
    await redis.set(key, value, 'EX', 86400 * 7); // Кэш на 7 дней
    await redis.zadd('report_timestamps', Date.now(), report.reportId);
    DEEP_LOG && log(`Saved to cache: ${key}`);
  } catch (error) {
    logErr('saveToCache', error);
  }
}

async function saveReport(report: Report) {
  const validationResult = validateReport(report);
  if (!validationResult.isValid) {
    logErr('saveReport', validationResult.error || 'Report validation failed');
    return;
  }
  
  DEEP_LOG && log(`Saving report to Redis: ${report.reportId}`);
  try {
    await saveToCache(report);
    DEEP_LOG && log(`Report saved successfully to Redis: ${report.reportId}`);
  } catch (error) {
    logErr('saveReport - saving to Redis', error);
    // Если сохранение в Redis не удалось, пытаемся сохранить напрямую в PostgreSQL
    await saveToPostgres(report);
  }
}

async function saveToPostgres(report: Report) {
  DEEP_LOG && log(`Saving report to PostgreSQL: ${report.reportId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = `
    INSERT INTO reports (
      report_id, message_content, media_hashes, complaint_count, source, sender,
      spam_probability, has_external_link, has_internal_link,
      mod_flood, mod_not_spam, is_spam, reason, confidence, created_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'DD.MM.YY, HH24:MI:SS'))
    ON CONFLICT (report_id) 
    DO UPDATE SET
      message_content = EXCLUDED.message_content,
      media_hashes = EXCLUDED.media_hashes,
      complaint_count = EXCLUDED.complaint_count,
      source = EXCLUDED.source,
      sender = EXCLUDED.sender,
      spam_probability = EXCLUDED.spam_probability,
      has_external_link = EXCLUDED.has_external_link,
      has_internal_link = EXCLUDED.has_internal_link,
      mod_flood = EXCLUDED.mod_flood,
      mod_not_spam = EXCLUDED.mod_not_spam,
      is_spam = EXCLUDED.is_spam,
      reason = EXCLUDED.reason,
      confidence = EXCLUDED.confidence,
      created_at = EXCLUDED.created_at
    `;

    const values = [
      report.reportId,
      report.messageContent,
      report.mediaHashes,
      report.complaintCount,
      report.source,
      report.sender,
      report.spamProbability,
      report.hasExternalLink,
      report.hasInternalLink,
      report.modFlood,
      report.modNotSpam,
      report.isSpam,
      report.reason,
      report.confidence
    ];
    await client.query(query, values);
    await client.query('COMMIT');
    DEEP_LOG && log(`Report saved successfully to PostgreSQL: ${report.reportId}`);
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('saveToPostgres', error);
  } finally {
    client.release();
  }
}

// Инкрементальная выгрузка данных
async function incrementalDataTransfer() {
  const lastTransferKey = 'last_transfer_timestamp';
  const lastTransfer = await redis.get(lastTransferKey) || '0';
  const currentTime = Date.now().toString();

  log('Starting incremental data transfer from Redis to PostgreSQL');
  try {
    const keys = await redis.zrangebyscore('report_timestamps', lastTransfer, currentTime);
    for (const key of keys) {
      const reportData = await redis.get(`report:${key}`);
      if (reportData) {
        const report = JSON.parse(reportData) as Report;
        await saveToPostgres(report);
      }
    }
    await redis.set(lastTransferKey, currentTime);
    log('Incremental data transfer completed successfully');
  } catch (error) {
    logErr('Incremental data transfer', error);
    await notify('Failed to transfer data incrementally from Redis to PostgreSQL. Check logs for details.');
  }
}

// Настройка инкрементальных выгрузок
const transferSchedules = ['0 */4 * * *', '0 23 * * *']; // Каждые 4 часа и в 23:00
transferSchedules.forEach(cronSchedule => {
  schedule.scheduleJob(cronSchedule, incrementalDataTransfer);
});

// Функция восстановления состояния из PostgreSQL
async function restoreFromPostgresToRedis() {
  log('Starting data restoration from PostgreSQL to Redis');
  let restoredCount = 0;
  let errorCount = 0;

  const client = await pool.connect();
  try {
    const lastTransfer = await redis.get('last_transfer_timestamp') || '0';
    const result = await client.query('SELECT * FROM reports WHERE created_at > $1', [lastTransfer]);
    
    for (const row of result.rows) {
      try {
        const report: Report = {
          reportId: row.report_id,
          messageContent: row.message_content,
          mediaHashes: row.media_hashes,
          complaintCount: row.complaint_count,
          source: row.source,
          sender: row.sender,
          spamProbability: row.spam_probability,
          hasExternalLink: row.has_external_link,
          hasInternalLink: row.has_internal_link,
          modFlood: row.mod_flood,
          modNotSpam: row.mod_not_spam,
          isSpam: row.is_spam,
          reason: row.reason
        };

        await saveToCache(report);
        await redis.zadd('report_timestamps', new Date(row.created_at).getTime(), report.reportId);
        restoredCount++;
      } catch (error) {
        logErr(`Error restoring report ${row.report_id} to Redis`, error);
        errorCount++;
      }
    }

    log(`Data restoration completed. Restored: ${restoredCount}, Errors: ${errorCount}`);
    
    if (errorCount > 0) {
      await notify(`Data restoration completed with errors. Restored: ${restoredCount}, Errors: ${errorCount}`);
    } else {
      await notify(`Data restoration completed successfully. Restored: ${restoredCount} reports.`);
    }
  } catch (error) {
    logErr('restoreFromPostgresToRedis', error);
    await notify('Failed to restore data from PostgreSQL to Redis. Check logs for details.');
  } finally {
    client.release();
  }
}

// Функция проверки состояния Redis и восстановления при необходимости
async function checkRedisAndRestore() {
  try {
    await redis.ping();
  } catch (error) {
    logErr('Redis connection lost', error);
    await notify('Lost connection to Redis. Attempting to reconnect and restore data...');
    
    // Попытка переподключения к Redis
    redis.disconnect();
    await redis.connect();
    
    // Восстановление данных из PostgreSQL
    await restoreFromPostgresToRedis();
  }
}

function getProcessingInterval(): number {
  return parseInt(process.env.PROCESSING_INTERVAL || '1000', 10);
}

async function processNextReport() {
  if (!autoMode) {
    DEEP_LOG && log('Automatic mode is off, skipping report processing');
    return;
  }

  if (isProcessing || reportQueue.length === 0) return;

  isProcessing = true;
  const report = reportQueue.shift();

  if (report) {
    await new Promise(resolve => setTimeout(resolve, getProcessingInterval()));
    await processReport(report);
  }

  isProcessing = false;
  processNextReport(); // Обработка следующего отчета в очереди
}

async function ensureMinimumInterval(startTime: number, minInterval: number): Promise<void> {
  const elapsedTime = Date.now() - startTime;
  if (elapsedTime < minInterval) {
    await new Promise(resolve => setTimeout(resolve, minInterval - elapsedTime));
  }
}

async function reconnectClient() {
  try {
    DEEP_LOG && log('Attempting to reconnect Telegram client...');
    if (client) {
      await client.disconnect();
    }
    client = await initClient();
    DEEP_LOG && log('Telegram client reconnected successfully');
  } catch (error) {
    logErr('reconnectClient', error);
    throw new Error('Failed to reconnect Telegram client');
  }
}

async function notify(msg: string) {
  if (notifyAttempts >= MAX_NOTIFY_ATTEMPTS) {
    logger.error(`Failed to notify admin after ${MAX_NOTIFY_ATTEMPTS} attempts: ${msg}`);
    notifyAttempts = 0;
    return;
  }

  try {
    if (!client || !client.connected) {
      await reconnectClient();
    }

    DEEP_LOG && log(`Notifying admin: ${msg}`);
    await client.sendMessage(ADMIN_ID, { message: msg });
    DEEP_LOG && log(`Admin notified successfully: ${msg}`);
    notifyAttempts = 0;
  } catch (error) {
    notifyAttempts++;
    logErr('notify', error);
    DEEP_LOG && log(`Failed to notify admin: ${msg}. Attempt ${notifyAttempts}`);
    
    if (notifyAttempts < MAX_NOTIFY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await notify(msg);
    }
  }
}

async function startAutoMode() {
  autoMode = true;
  log('Automatic mode activated');
  await sendToBot("/next");
  processNextReport();
}

function stopAutoMode() {
  autoMode = false;
  reportQueue.length = 0;
  log('Automatic mode deactivated and report queue cleared');
}

async function sendStatus() {
  const status = `
Current status:
Auto mode: ${autoMode ? 'On' : 'Off'}
Processing delay: ${getProcessingInterval()} ms
Database connection: ${await checkDB() ? 'Connected' : 'Disconnected'}
Reports in database: ${await checkDBContent()}
Check configuration:
- Obvious spam: ${checkConfig.obviousSpam ? 'On' : 'Off'}
- Cache: ${checkConfig.cache ? 'On' : 'Off'}
- GPT: ${checkConfig.gpt ? 'On' : 'Off'}
- Moderators: ${checkConfig.moderators ? 'On' : 'Off'}
  `;
  await notify(status);
}

async function handleDbExport() {
  DEEP_LOG && log('Admin requested database export');
  try {
    const filename = await exportCSV();
    const fileStats = await fs.promises.stat(filename);
    await client.sendFile(ADMIN_ID, {
      file: filename,
      caption: `Database export: ${filename}\nSize: ${fileStats.size} bytes`,
    });
    await fs.promises.unlink(filename);
    DEEP_LOG && log('Database export sent to admin');
  } catch (error) {
    logErr('handleDbExport', error);
    await notify('Failed to export database. Check logs for details.');
  }
}

async function exportCSV(): Promise<string> {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Executing database query for export...');
    const result = await client.query('SELECT * FROM reports');
    DEEP_LOG && log(`Query executed. Found ${result.rows.length} rows.`);

    const filename = path.join(process.cwd(), `reports_export_${Date.now()}.csv`);
    const csvWriter = createObjectCsvWriter({
      path: filename,
      header: [
        { id: 'id', title: 'ID' },
        { id: 'report_id', title: 'Report ID' },
        { id: 'message_content', title: 'Message Content' },
        { id: 'media_hashes', title: 'Media Hashes' },
        { id: 'complaint_count', title: 'Complaint Count' },
        { id: 'source', title: 'Source' },
        { id: 'sender', title: 'Sender' },
        { id: 'spam_probability', title: 'Spam Probability' },
        { id: 'has_external_link', title: 'Has External Link' },
        { id: 'has_internal_link', title: 'Has Internal Link' },
        { id: 'mod_flood', title: 'Mod Flood' },
        { id: 'mod_not_spam', title: 'Mod Not Spam' },
        { id: 'is_spam', title: 'Is Spam' },
        { id: 'reason', title: 'Reason' },
        { id: 'created_at', title: 'Created At' }
      ]
    });

    await csvWriter.writeRecords(result.rows);
    DEEP_LOG && log(`CSV file created: ${filename}`);
    return filename;
  } catch (error) {
    logErr('exportCSV', error);
    throw error;
  } finally {
    client.release();
  }
}

async function checkDB() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW()');
    DEEP_LOG && log(`Database connection successful. Current time: ${result.rows[0].now}`);
    return true;
  } catch (error) {
    logErr('checkDB', error);
    return false;
  } finally {
    client.release();
  }
}

async function checkDBSettings() {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Checking database settings...');
    const result = await client.query('SHOW ALL');
    const settings = result.rows.reduce((acc: Record<string, string>, row: { name: string; setting: string }) => {
      acc[row.name] = row.setting;
      return acc;
    }, {});
    DEEP_LOG && log(`Database settings: ${JSON.stringify(settings, null, 2)}`);
    return settings;
  } catch (error) {
    logErr('checkDBSettings', error);
    return null;
  } finally {
    client.release();
  }
}

async function checkDBContent() {
  const client = await pool.connect();
  try {
    DEEP_LOG && log('Checking database content...');
    const result = await client.query('SELECT COUNT(*) FROM reports');
    const count = parseInt(result.rows[0].count);
    DEEP_LOG && log(`Database contains ${count} reports`);
    if (count > 0) {
      const sampleResult = await client.query('SELECT * FROM reports LIMIT 1');
      DEEP_LOG && log(`Sample report: ${JSON.stringify(sampleResult.rows[0], null, 2)}`);
    }
    return count;
  } catch (error) {
    logErr('checkDBContent', error);
    return null;
  } finally {
    client.release();
  }
}

async function sendToBot(message: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    await client.sendMessage(botEntity, { message });
    DEEP_LOG && log(`Message sent to bot: ${message}`);
  } catch (error) {
    logErr('sendToBot', error);
  }
}

async function sendDecision(decision: string) {
  if (!botEntity) throw new Error('Bot entity not initialized');
  try {
    await client.sendMessage(botEntity, { message: decision });
    DEEP_LOG && log(`Decision sent to bot: ${decision}`);
  } catch (error) {
    logErr('sendDecision', error);
  }
}

async function selectGptModel(message: string): Promise<string> {
  const tokenEstimate = message.split(/\s+/).length; // Грубая оценка количества токенов

  if (tokenEstimate <= 100) {
    return "gpt-4o-mini";
  } else if (tokenEstimate <= 500) {
    return "gpt-4o-2024-08-06";
  } else {
    return "gpt-4";
  }
}

async function retryGptRequest<T>(
  requestFn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number,
  maxDelay: number
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries reached');
}

// Обработчики событий
async function handleCheck(event: NewMessageEvent) {
  if (!autoMode) {
    DEEP_LOG && log('Automatic mode is off, skipping message check');
    return;
  }

  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received message for check: ${message.message}`);
    
    if (currentState === ReportProcessingState.WAITING_FOR_NEXT_REPORT) {
      currentState = ReportProcessingState.IDLE;
      return;
    }
    
    if (!currentReport.messageContent) currentReport.messageContent = [];
    if (!currentReport.mediaHashes) currentReport.mediaHashes = [];
    
    let processedMessage = preprocessMessage(message.message || '');
    
    if (message.media instanceof Api.MessageMediaStory) {
      const caption = (message.media as any).caption;
      if (caption) processedMessage += ` [Story Caption: ${caption}]`;
    }
    
    if (message.replyTo) {
      try {
        const repliedMessage = await message.getReplyMessage();
        if (repliedMessage?.message) {
          processedMessage += ` [Quoted: ${repliedMessage.message}]`;
        }
      } catch (error) {
        logErr('handleCheck - getting replied message', error);
      }
    }
    
    if (processedMessage) currentReport.messageContent.push(processedMessage);
    
    if (message.media) {
      try {
        const mediaHash = await getMediaHash(message.media);
        currentReport.mediaHashes.push(mediaHash);
      } catch (error) {
        logErr('handleCheck - getting media hash', error);
      }
    }
    
    DEEP_LOG && log(`Current report: ${JSON.stringify(currentReport, null, 2)}`);
  }
}

async function handleSys(event: NewMessageEvent) {
  const { message } = event;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received system message: ${message.message}`);

    const sysInfo = parseSysMsg(message.message || '');
    DEEP_LOG && log(`Parsed system info: ${JSON.stringify(sysInfo, null, 2)}`);

    if (currentState === ReportProcessingState.WAITING_FOR_MODERATOR_OPINION) {
      currentReport = { ...currentReport, ...sysInfo };
      DEEP_LOG && log(`Current report updated with moderator opinions: ${JSON.stringify(currentReport, null, 2)}`);
      currentState = ReportProcessingState.IDLE;
      return;
    }

    if (sysInfo.reportId) {
      const existingReportIndex = reportQueue.findIndex(report => report.reportId === sysInfo.reportId);
      if (existingReportIndex !== -1) {
        DEEP_LOG && log(`Report ${sysInfo.reportId} already in queue, updating`);
        reportQueue[existingReportIndex] = { ...reportQueue[existingReportIndex], ...sysInfo };
      } else {
        currentReport = { ...sysInfo };
        DEEP_LOG && log(`New report received: ${JSON.stringify(currentReport, null, 2)}`);

        const validationResult = validateReport(currentReport as Report);
        if (validationResult.isValid) {
          if (autoMode) {
            reportQueue.push(currentReport as Report);
            DEEP_LOG && log('Current report added to queue');
            processNextReport();
          } else {
            await saveToCache(currentReport as Report);
            DEEP_LOG && log('Current report saved to cache (auto mode off)');
          }
        } else {
          log(`Report validation failed: ${validationResult.error}`);
          DEEP_LOG && log(`Invalid report data: ${JSON.stringify(currentReport, null, 2)}`);
        }
      }
    } else {
      log('Warning: reportId is missing in the current report');
    }
  }
}

async function handleAddMsg(event: NewMessageEvent) {
  const message = event.message;
  if (
    message instanceof Api.Message &&
    event.isPrivate &&
    botEntity &&
    message.senderId?.toString() === botEntity.userId.toString()
  ) {
    DEEP_LOG && log(`Received additional message: ${message.message}`);

    switch (message.message) {
      case "No Reports Found":
        DEEP_LOG && log('No reports found, sending /undo');
        await sendToBot("/undo");
        break;
      case "Hello there! Send /next to start processing reports.":
        if (autoMode) {
          await sendToBot("/next");
        }
        break;
      case "Please select 😡 BAN or 😌 NO.":
      case "Sorry, an error has occurred during your request. Please try again later.":
        await sendToBot("/undo");
        break;
      default:
        if (message.message.startsWith("Your Fee for this month:")) {
          DEEP_LOG && log(`Earnings info received: ${message.message}`);
          await notify(`Earnings update: ${message.message}`);
        }
    }
  }
}

async function handleAdmin(event: NewMessageEvent) {
  if (!client || !client.connected) {
    DEEP_LOG && log('Telegram client not connected. Attempting to reconnect...');
    try {
      await reconnectClient();
    } catch (error) {
      logErr('handleAdmin - reconnectClient', error);
      return;
    }
  }

  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === ADMIN_ID.toString()) {
    DEEP_LOG && log(`Received admin message: ${message.message}`);
    const command = message.message.toLowerCase();

    switch (true) {
      case command === '/start':
        await startAutoMode();
        await notify('Automatic mode started');
        break;
      case command === '/stop':
        stopAutoMode();
        await notify('Automatic mode stopped');
        break;
      case command === '/db':
        await handleDbExport();
        break;
      case command === '/status':
        await sendStatus();
        break;
      case command.startsWith('/time '):
        const time = parseInt(command.split(' ')[1], 10);
        if (!isNaN(time) && time > 0) {
          PROCESSING_INTERVAL = time;
          await notify(`Processing interval set to ${time} ms`);
        } else {
          await notify('Invalid time value. Please enter a positive number.');
        }
        break;
      case command.startsWith('/delay '):
        const delay = parseInt(command.split(' ')[1], 10);
        if (!isNaN(delay) && delay > 0) {
          COMMAND_DELAY = delay;
          await notify(`Command delay set to ${delay} ms`);
        } else {
          await notify('Invalid delay value. Please enter a positive number.');
        }
        break;
      case command.startsWith('/toggle '):
        const toggles = command.split(' ').slice(1);
        for (const toggle of toggles) {
          switch (toggle) {
            case 'obvs':
              checkConfig.obviousSpam = !checkConfig.obviousSpam;
              break;
            case 'cache':
              checkConfig.cache = !checkConfig.cache;
              break;
            case 'gpt':
              checkConfig.gpt = !checkConfig.gpt;
              break;
            case 'mods':
              checkConfig.moderators = !checkConfig.moderators;
              break;
            default:
              await notify(`Unknown toggle: ${toggle}`);
          }
        }
        await notify(`Check configuration updated:\n${JSON.stringify(checkConfig, null, 2)}`);
        break;
      default:
        DEEP_LOG && log(`Unrecognized admin command: ${command}`);
    }
  }
}

// Основная функция
async function main() {
  try {
    DEEP_LOG && log('Starting application...');

    await initDB();
    DEEP_LOG && log('Database initialized');

    const isConnected = await checkDB();
    if (!isConnected) throw new Error('Failed to connect to the database');
    DEEP_LOG && log('Database connection confirmed');

    const dbSettings = await checkDBSettings();
    if (dbSettings) {
      DEEP_LOG && log('Database settings checked successfully');
    } else {
      logErr('main', 'Failed to check database settings');
    }

    try {
      await redis.ping();
      DEEP_LOG && log('Successfully connected to Redis');
    } catch (error) {
      logErr('main - Redis connection', error);
      throw new Error('Failed to connect to Redis');
    }

    try {
      client = await initClient();
      DEEP_LOG && log('Telegram client initialized');
    } catch (error) {
      logErr('main - initClient', error);
      throw new Error('Failed to initialize Telegram client');
    }

    await initBot();
    DEEP_LOG && log('Bot initialized');

    await setupHandlers();
    DEEP_LOG && log('Event handlers set up');

    app.listen(PORT, () => log(`Server running on port ${PORT}`));

    // Установка периодических проверок
    setInterval(async () => {
      const isStillConnected = await checkDB();
      if (!isStillConnected) {
        logErr('main', 'Lost connection to the database. Attempting to reconnect...');
        await initDB();
      }
    }, DB_CHECK_INTERVAL);

    setInterval(async () => {
      DEEP_LOG && log('Performing periodic health check...');
      await checkDB();
      const reportCount = await checkDBContent();
      DEEP_LOG && log(`Current number of reports in database: ${reportCount}`);

      await checkRedisAndRestore();
    }, HEALTH_CHECK_INTERVAL);

    // Добавляем периодическую проверку соединения с Telegram
    setInterval(async () => {
      if (!client || !client.connected) {
        DEEP_LOG && log('Lost connection to Telegram. Attempting to reconnect...');
        await reconnectClient();
      }
    }, 60000); // Проверяем каждую минуту

    await notify('Application initialized successfully');

    // Обработка ошибок
    process.on('unhandledRejection', (reason, promise) => {
      logErr('UnhandledRejection', `Reason: ${reason}`);
    });

    process.on('uncaughtException', (error) => {
      logErr('UncaughtException', error);
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('SIGINT', async () => {
      log('Shutting down gracefully');
      await gracefulShutdown();
    });

    process.on('SIGTERM', async () => {
      log('Received SIGTERM. Shutting down gracefully');
      await gracefulShutdown();
    });

  } catch (error) {
    logErr('main', error);
    process.exit(1);
  }
}

async function gracefulShutdown() {
  log('Starting graceful shutdown...');

  // Остановка автоматического режима
  stopAutoMode();

  // Закрытие соединения с базой данных
  try {
    await pool.end();
    log('Database connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing database connection', error);
  }

  // Отключение клиента Telegram
  try {
    if (client) {
      await client.disconnect();
      log('Telegram client disconnected');
    }
  } catch (error) {
    logErr('gracefulShutdown - disconnecting Telegram client', error);
  }

  // Закрытие соединения с Redis
  try {
    await redis.quit();
    log('Redis connection closed');
  } catch (error) {
    logErr('gracefulShutdown - closing Redis connection', error);
  }

  log('Graceful shutdown completed');
  process.exit(0);
}

// Инициализация клиента Telegram
async function initClient(): Promise<TelegramClient> {
  if (!API_ID || !API_HASH || !SESSION_STRING) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }

  DEEP_LOG && log('Initializing Telegram client...');
  const stringSession = new StringSession(SESSION_STRING);
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    useWSS: true,
    requestRetries: 5,
  });

  try {
    await client.connect();
    const isAuthorized = await client.checkAuthorization();
    if (!isAuthorized) {
      throw new Error('Client is not authorized. Please check your session string.');
    }
    DEEP_LOG && log('Client connected and authorized successfully');
    return client;
  } catch (error) {
    logErr('initClient', error);
    throw error;
  }
}

// Инициализация базы данных
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    DEEP_LOG && log('Creating reports table if not exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        report_id TEXT UNIQUE,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        spam_probability INTEGER,
        has_external_link BOOLEAN,
        has_internal_link BOOLEAN,
        mod_flood INTEGER DEFAULT 0,
        mod_not_spam INTEGER DEFAULT 0,
        is_spam BOOLEAN,
        reason TEXT,
        decision TEXT,
        created_at TEXT DEFAULT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'DD.MM.YY, HH24:MI:SS')
      );
    `);
    
    DEEP_LOG && log('Altering spam_probability column...');
    await client.query(`
      ALTER TABLE reports
      ALTER COLUMN spam_probability DROP NOT NULL;
    `);
    
    await client.query('COMMIT');
    DEEP_LOG && log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logErr('initDB', error);
    throw error;
  } finally {
    client.release();
  }
}

// Инициализация бота
async function initBot() {
  if (!BOT_ID || !BOT_ACCESS_HASH) {
    throw new Error('BOT_ID and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    DEEP_LOG && log(`BOT_ID: ${BOT_ID}, BOT_ACCESS_HASH: ${BOT_ACCESS_HASH}`);
    botEntity = new Api.InputPeerUser({
      userId: bigInt(BOT_ID),
      accessHash: bigInt(BOT_ACCESS_HASH)
    });
    DEEP_LOG && log('Bot entity initialized successfully');
  } catch (error) {
    logErr('initBot', error);
    throw error;
  }
}

// Настройка обработчиков событий
async function setupHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toJSNumber();

  const handlers = [
    { handler: handleCheck, options: { fromUsers: [botUserId], incoming: true, forwards: true } },
    { handler: handleSys, options: { fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ } },
    { handler: handleAddMsg, options: { fromUsers: [botUserId], incoming: true } },
    { handler: handleAdmin, options: { fromUsers: [ADMIN_ID], incoming: true } }
  ];

  handlers.forEach(({ handler, options }) => {
    try {
      client.addEventHandler(handler, new NewMessage(options));
      DEEP_LOG && log(`Handler ${handler.name} set up successfully`);
    } catch (error) {
      logErr(`setupHandlers - ${handler.name}`, error);
    }
  });

  DEEP_LOG && log('All event handlers set up successfully');
}

// Запуск приложения
main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});