import { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramClient } from 'telegram/index.js';
import { Api } from 'telegram/tl/index.js';
import bigInt from "big-integer";
import express from 'express';
import dotenv from 'dotenv';
import pkg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import { Parser } from 'json2csv';

dotenv.config();

const ENABLE_DEEP_LOGGING = true;
const app = express();
const port = process.env.PORT || 3000;
const adminId = parseInt(process.env.ADMIN_ID!, 10);
const databaseUrl = process.env.DATABASE_URL!;
const { Pool } = pkg;

let client: TelegramClient;
const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }});

let botEntity: Api.InputPeerUser | null = null;

interface Report {
  reportId: string;
  messageContent?: string[];
  mediaHashes?: string[];
  complaintCount: number;
  source: string;
  sender: string;
  spamProbability: number;
  hasExternalLink?: boolean;
  hasInternalLink?: boolean;
  moderatorDecisions?: string[];
  manualClassification?: string;
}

let currentReport: Partial<Report> = {};

async function initClient(): Promise<TelegramClient> {
  const apiId = parseInt(process.env.API_ID!, 10);
  const apiHash = process.env.API_HASH!;
  const sessionString = process.env.SESSION_STRING!;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error('API_ID, API_HASH, and SESSION_STRING must be set in .env file');
  }
  ENABLE_DEEP_LOGGING && console.log('Initializing Telegram client...');
  const stringSession = new StringSession(sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
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
    ENABLE_DEEP_LOGGING && console.log('Client connected and authorized successfully');
    return client;
  } catch (error) {
    await logError('initClient', error);
    throw error;
  }
}

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        report_id TEXT UNIQUE,
        message_content TEXT[],
        media_hashes TEXT[],
        complaint_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        sender TEXT NOT NULL,
        spam_probability FLOAT NOT NULL,
        has_external_link BOOLEAN,
        has_internal_link BOOLEAN,
        moderator_decisions TEXT[],
        manual_classification TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    ENABLE_DEEP_LOGGING && console.log('Database initialized successfully');
  } catch (error) {
    await logError('initDatabase', error);
    throw error;
  } finally {
    client.release();
  }
}

async function initBotEntity() {
  const botId = process.env.BOT_ID;
  const botAccessHash = process.env.BOT_ACCESS_HASH;

  if (!botId || !botAccessHash) {
    throw new Error('BOT_ID and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    ENABLE_DEEP_LOGGING && console.log('BOT_ID:', botId, 'BOT_ACCESS_HASH:', botAccessHash);
    botEntity = new Api.InputPeerUser({
      userId: bigInt(botId),
      accessHash: bigInt(botAccessHash)
    });
    ENABLE_DEEP_LOGGING && console.log('Bot entity initialized successfully', botEntity);
  } catch (error) {
    await logError('initBotEntity', error);
    throw error;
  }
}

async function handleCheckMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    ENABLE_DEEP_LOGGING && console.log('Received message for check:', message.message);
    
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
        if (repliedMessage?.message) processedMessage += ` [Quoted: ${repliedMessage.message}]`;
      } catch (error) {
        await logError('handleCheckMsg - getting replied message', error);
      }
    }
    
    if (processedMessage) currentReport.messageContent.push(processedMessage);
    
    if (message.media) {
      try {
        const mediaHash = await getMediaHash(message.media);
        currentReport.mediaHashes.push(mediaHash);
      } catch (error) {
        await logError('handleCheckMsg - getting media hash', error);
      }
    }
    
    ENABLE_DEEP_LOGGING && console.log('Current report:', JSON.stringify(currentReport, null, 2));
  }
}

function preprocessMessage(message: string): string {
  return message.split('\n').slice(1).join('\n');
}

async function handleSysMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId?.toString() === botEntity.userId.toString()) {
    ENABLE_DEEP_LOGGING && console.log('Received system message:', message.message);
    const sysInfo = parseSysMsg(message.message || '');
    currentReport = { ...currentReport, ...sysInfo };
    ENABLE_DEEP_LOGGING && console.log('Current report:', JSON.stringify(currentReport, null, 2));
    if (isValidReport(currentReport as Report)) {
      await saveReport(currentReport as Report);
      currentReport = {};
    }
  }
}

async function handleManualMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.peerId?.toString() === botEntity.userId.toString()) {
    ENABLE_DEEP_LOGGING && console.log('Sent manual classification:', message.message);
    currentReport.manualClassification = message.message || '';
    if (isValidReport(currentReport as Report)) {
      await saveReport(currentReport as Report);
      currentReport = {};
    }
  }
}

function parseSysMsg(message: string): Partial<Report> {
  const sysInfo: Partial<Report> = {};
  const lines = message.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('#r')) {
      const [reportId, complaintCount] = line.split(',');
      sysInfo.reportId = reportId.trim();
      const match = complaintCount?.match(/😱(\d+)/);
      if (match) sysInfo.complaintCount = parseInt(match[1]);
    }
    if (line.startsWith('Source:') || line.startsWith('🗣 Source:'))
      sysInfo.source = line.replace(/^🗣?\s*Source:/, '').trim();
    if (line.startsWith('Sender:'))
      sysInfo.sender = line.replace('Sender:', '').trim();
    const spamProbMatch = line.match(/(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/);
    if (spamProbMatch) sysInfo.spamProbability = parseInt(spamProbMatch[1]) / 100;
    if (line.includes('🔴')) sysInfo.hasExternalLink = true;
    if (line.includes('🔶')) sysInfo.hasInternalLink = true;
    if (line.includes('– Flood') || line.includes('– Not Spam')) {
      if (!sysInfo.moderatorDecisions) sysInfo.moderatorDecisions = [];
      sysInfo.moderatorDecisions.push(line.trim());
    }
  }
  return sysInfo;
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

function isValidReport(report: Partial<Report>): boolean {
  return !!(report.reportId && report.complaintCount !== undefined && 
            report.source && report.sender && 
            report.spamProbability !== undefined);
}

async function saveReport(report: Report) {
  if (!report || !report.reportId) {
    console.error('Invalid report object:', JSON.stringify(report, null, 2));
    return;
  }
  
  ENABLE_DEEP_LOGGING && console.log('Saving report:', JSON.stringify(report, null, 2));
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO reports (
        report_id, message_content, media_hashes, complaint_count, source, sender,
        spam_probability, has_external_link, has_internal_link,
        moderator_decisions, manual_classification
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (report_id) 
      DO UPDATE SET
        manual_classification = EXCLUDED.manual_classification,
        message_content = EXCLUDED.message_content,
        media_hashes = EXCLUDED.media_hashes,
        complaint_count = EXCLUDED.complaint_count,
        source = EXCLUDED.source,
        sender = EXCLUDED.sender,
        spam_probability = EXCLUDED.spam_probability,
        has_external_link = EXCLUDED.has_external_link,
        has_internal_link = EXCLUDED.has_internal_link,
        moderator_decisions = EXCLUDED.moderator_decisions
    `;
    const values = [
      report.reportId, report.messageContent, report.mediaHashes, report.complaintCount,
      report.source, report.sender, report.spamProbability, report.hasExternalLink,
      report.hasInternalLink, report.moderatorDecisions, report.manualClassification
    ];
    const result = await client.query(query, values);
    ENABLE_DEEP_LOGGING && console.log('Report saved:', report.reportId, 'Result:', result.rowCount);
  } catch (error) {
    await logError('saveReport', error);
  } finally {
    client.release();
  }
}

async function notifyAdmin(message: string) {
  try {
    await client.sendMessage(adminId, { message });
    ENABLE_DEEP_LOGGING && console.log('Admin notified:', message);
  } catch (error) {
    console.error('Error notifying admin:', error);
  }
}

async function handleAdminMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && message.senderId?.toString() === adminId.toString()) {
    if (message.message === '/db') {
      ENABLE_DEEP_LOGGING && console.log('Admin requested database export');
      try {
        const filename = await exportDataToCSV();
        const fileStats = fs.statSync(filename);
        await client.sendFile(adminId, {
          file: filename,
          caption: `Database export: ${filename}\nSize: ${fileStats.size} bytes`,
        });
        fs.unlinkSync(filename);
        ENABLE_DEEP_LOGGING && console.log('Database export sent to admin');
      } catch (error) {
        await logError('handleAdminMsg - database export', error);
      }
    }
  }
}

async function setupEventHandlers() {
  if (!botEntity) throw new Error('Bot entity not initialized');
  const botUserId = botEntity.userId.toJSNumber();
  client.addEventHandler(handleCheckMsg, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: true }));
  client.addEventHandler(handleSysMsg, new NewMessage({ fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ }));
  client.addEventHandler(handleManualMsg, new NewMessage({ outgoing: true, chats: [botUserId] }));
  client.addEventHandler(handleAdminMsg, new NewMessage({ fromUsers: [adminId], incoming: true }));
  ENABLE_DEEP_LOGGING && console.log('Event handlers set up successfully');
}

async function exportDataToCSV(): Promise<string> {
  const client = await pool.connect();
  try {
    ENABLE_DEEP_LOGGING && console.log('Executing database query for export...');
    const result = await client.query('SELECT * FROM reports');
    ENABLE_DEEP_LOGGING && console.log(`Query executed. Found ${result.rows.length} rows.`);

    const fields = [
      'id', 'report_id', 'message_content', 'media_hashes', 'complaint_count',
      'source', 'sender', 'spam_probability', 'has_external_link',
      'has_internal_link', 'moderator_decisions', 'manual_classification',
      'created_at'
    ];
    const parser = new Parser({ fields });
    
    let csv = result.rows.length > 0 ? parser.parse(result.rows) : 'No data found in the database.';
    ENABLE_DEEP_LOGGING && console.log(result.rows.length > 0 ? 'Data parsed to CSV format' : 'No data found in the database');

    const filename = `reports_export_${Date.now()}.csv`;
    fs.writeFileSync(filename, csv);
    ENABLE_DEEP_LOGGING && console.log(`CSV file created: ${filename}`);
    return filename;
  } catch (error) {
    await logError('exportDataToCSV', error);
    throw error;
  } finally {
    client.release();
  }
}

async function checkDatabaseConnection() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT NOW()');
    ENABLE_DEEP_LOGGING && console.log('Database connection successful. Current time:', result.rows[0].now);
    return true;
  } catch (error) {
    await logError('checkDatabaseConnection', error);
    return false;
  } finally {
    client.release();
  }
}

async function checkDatabaseSettings() {
  const client = await pool.connect();
  try {
    ENABLE_DEEP_LOGGING && console.log('Checking database settings...');
    const result = await client.query('SHOW ALL');
    const settings = result.rows.reduce((acc: Record<string, string>, row: { name: string; setting: string }) => {
      acc[row.name] = row.setting;
      return acc;
    }, {});
    ENABLE_DEEP_LOGGING && console.log('Database settings:', JSON.stringify(settings, null, 2));
    return settings;
  } catch (error) {
    await logError('checkDatabaseSettings', error);
    return null;
  } finally {
    client.release();
  }
}

async function checkDatabaseContent() {
  const client = await pool.connect();
  try {
    ENABLE_DEEP_LOGGING && console.log('Checking database content...');
    const result = await client.query('SELECT COUNT(*) FROM reports');
    const count = parseInt(result.rows[0].count);
    ENABLE_DEEP_LOGGING && console.log(`Database contains ${count} reports`);
    if (count > 0) {
      const sampleResult = await client.query('SELECT * FROM reports LIMIT 1');
      ENABLE_DEEP_LOGGING && console.log('Sample report:', JSON.stringify(sampleResult.rows[0], null, 2));
    }
    return count;
  } catch (error) {
    await logError('checkDatabaseContent', error);
    return null;
  } finally {
    client.release();
  }
}

async function logError(context: string, error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`Error in ${context}:`, errorMessage);
  await notifyAdmin(`Error in ${context}: ${errorMessage}`);
}

async function main() {
  try {
    await initDatabase();
    const isConnected = await checkDatabaseConnection();
    if (!isConnected) throw new Error('Failed to connect to the database');

    const dbSettings = await checkDatabaseSettings();
    if (dbSettings) {
      ENABLE_DEEP_LOGGING && console.log('Database settings checked successfully');
    } else {
      console.error('Failed to check database settings');
    }

    client = await initClient();
    await initBotEntity();
    await setupEventHandlers();
    console.log('Telegram client initialized successfully');

    app.listen(port, () => console.log(`Server running on port ${port}`));

    if (botEntity) {
      try {
        await client.sendMessage(botEntity, { message: "/next" });
        console.log('Initial message sent to bot');
      } catch (error) {
        await logError('main - sending initial message to bot', error);
      }
    } else {
      throw new Error('Bot entity not initialized');
    }

    setInterval(async () => {
      const isStillConnected = await checkDatabaseConnection();
      if (!isStillConnected) {
        console.error('Lost connection to the database. Attempting to reconnect...');
        await initDatabase();
      }
    }, 60000);

    setInterval(async () => {
      ENABLE_DEEP_LOGGING && console.log('Performing periodic health check...');
      await checkDatabaseConnection();
      const reportCount = await checkDatabaseContent();
      ENABLE_DEEP_LOGGING && console.log(`Current number of reports in database: ${reportCount}`);
    }, 300000);

    await notifyAdmin('Application initialized successfully');

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      notifyAdmin(`Unhandled Rejection: ${reason}`).catch(console.error);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      notifyAdmin(`Uncaught Exception: ${error instanceof Error ? error.message : String(error)}`).catch(console.error);
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('SIGINT', async () => {
      console.log('Shutting down gracefully');
      await pool.end();
      await client.disconnect();
      process.exit(0);
    });

  } catch (error) {
    await logError('main', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Error in main function:', error);
  process.exit(1);
});