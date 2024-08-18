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

const app = express();
const port = process.env.PORT || 3000;
const adminId = parseInt(process.env.ADMIN_ID!, 10);
const databaseUrl = process.env.DATABASE_URL!;
const { Pool } = pkg;

let client: TelegramClient;
const pool: pkg.Pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }});

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
  console.log('Initializing Telegram client...');
  const stringSession = new StringSession(sessionString);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    useWSS: true,
    requestRetries: 5,
  });

  try {
    console.log('Connecting to Telegram servers...');
    await client.connect();
    console.log('Connected to Telegram servers');

    console.log('Checking authorization...');
    const isAuthorized = await client.checkAuthorization();
    if (!isAuthorized) {
      throw new Error('Client is not authorized. Please check your session string.');
    }
    console.log('Client is authorized');

    console.log('Client connected successfully');
    return client;
  } catch (error) {
    console.error('Error connecting to Telegram:', error);
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
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    await notifyAdmin('Error initializing database. Check logs.');
    throw error;
  } finally {
    client.release();
  }
}

async function initBotEntity() {
  const botUsername = process.env.BOT_USERNAME;
  const botId = process.env.BOT_ID;
  const botAccessHash = process.env.BOT_ACCESS_HASH;

  if (!botUsername || !botId || !botAccessHash) {
    throw new Error('BOT_USERNAME, BOT_ID, and BOT_ACCESS_HASH must be set in .env file');
  }

  try {
    console.log('Using stored bot credentials');
    botEntity = new Api.InputPeerUser({
      userId: bigInt(botId),
      accessHash: bigInt(botAccessHash)
    });
    console.log('Bot entity initialized successfully');
  } catch (error) {
    console.error('Error initializing bot entity:', error);
    throw error;
  }
}

async function handleCheckMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId && message.senderId.toString() === botEntity.userId.toString()) {
    console.log('Received message for check:', message.message);
    if (!currentReport.messageContent) {
      currentReport.messageContent = [];
    }
    if (!currentReport.mediaHashes) {
      currentReport.mediaHashes = [];
    }
    
    let processedMessage = preprocessMessage(message.message || '');
    
    if (message.media instanceof Api.MessageMediaStory) {
      const caption = (message.media as any).caption;
      if (caption) {
        processedMessage += ` [Story Caption: ${caption}]`;
      }
    }
    
    if (message.replyTo) {
      try {
        const repliedMessage = await message.getReplyMessage();
        if (repliedMessage && repliedMessage.message) {
          processedMessage += ` [Quoted: ${repliedMessage.message}]`;
        }
      } catch (error) {
        console.error('Error getting replied message:', error);
      }
    }
    
    if (processedMessage) {
      currentReport.messageContent.push(processedMessage);
    }
    
    if (message.media) {
      const mediaHash = await getMediaHash(message.media);
      currentReport.mediaHashes.push(mediaHash);
    }
  }
}

function preprocessMessage(message: string): string {
  const lines = message.split('\n');
  return lines.slice(1).join('\n');
}

async function handleSysMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.senderId && message.senderId.toString() === botEntity.userId.toString()) {
    console.log('Received system message:', message.message);
    const sysInfo = parseSysMsg(message.message || '');
    currentReport = { ...currentReport, ...sysInfo };
    if (currentReport.manualClassification) {
      await saveReport(currentReport as Report);
      currentReport = {};
    }
  }
}

async function handleManualMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && event.isPrivate && botEntity && message.peerId && message.peerId.toString() === botEntity.userId.toString()) {
    console.log('Sent manual classification:', message.message);
    currentReport.manualClassification = message.message || '';
    if (isValidReport(currentReport)) {
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
      const parts = line.split(',');
      sysInfo.reportId = parts[0].trim();
      const complaintMatch = parts[1]?.match(/😱(\d+)/);
      if (complaintMatch) { sysInfo.complaintCount = parseInt(complaintMatch[1]); } }
    if (line.startsWith('Source:') || line.startsWith('🗣 Source:')) {
      sysInfo.source = line.replace(/^🗣?\s*Source:/, '').trim(); }
    if (line.startsWith('Sender:')) { sysInfo.sender = line.replace('Sender:', '').trim(); } 
      const spamProbMatch = line.match(/(?:🌕|🌔|🌓|🌒|🌚)\s*(\d+)%/);
    if (spamProbMatch) { sysInfo.spamProbability = parseInt(spamProbMatch[1]) / 100; }
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
  if (media instanceof Api.MessageMediaPhoto && media.photo) {
    return `photo:${media.photo.id.toString()}`;
  } else if (media instanceof Api.MessageMediaDocument && media.document) {
    return `doc:${media.document.id.toString()}`;
  } else if (media instanceof Api.MessageMediaWebPage && media.webpage && 'id' in media.webpage) {
    return `webpage:${media.webpage.id.toString()}`;
  } else if (media instanceof Api.MessageMediaPoll && media.poll) {
    return `poll:${media.poll.id}`;
  } else if (media instanceof Api.MessageMediaGeo && media.geo && 'long' in media.geo && 'lat' in media.geo) {
    return `geo:${media.geo.long},${media.geo.lat}`;
  } else if (media instanceof Api.MessageMediaContact) {
    return `contact:${media.phoneNumber}`;
  } else if (media instanceof Api.MessageMediaGame && media.game) {
    return `game:${media.game.id}`;
  } else if (media instanceof Api.MessageMediaInvoice) {
    return `invoice:${media.title}`;
  } else if (media instanceof Api.MessageMediaGeoLive && media.geo && 'long' in media.geo && 'lat' in media.geo) {
    return `geolive:${media.geo.long},${media.geo.lat}`;
  } else if (media instanceof Api.MessageMediaDice) {
    return `dice:${media.value}`;
  } else if (media instanceof Api.MessageMediaStory) {
    return `story:${media.id}`;
  }
  
  return `unknown:${crypto.createHash('md5').update(JSON.stringify(media)).digest('hex')}`;
}

function isValidReport(report: Partial<Report>): boolean {
  return !!(report.reportId && report.complaintCount !== undefined && 
            report.source && report.sender && 
            report.spamProbability !== undefined && report.manualClassification);
}

async function saveReport(report: Report) {
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
        manual_classification = EXCLUDED.manual_classification
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
      report.moderatorDecisions,
      report.manualClassification
    ];
    await client.query(query, values);
    console.log('Report saved in database');
  } catch (error) {
    console.error('Error saving report in database:', error);
    await notifyAdmin('Error saving report in database. Check logs.');
  } finally {
    client.release();
  }
}

async function notifyAdmin(message: string) {
  try {
    await client.sendMessage(adminId, { message });
    console.log('Admin notified:', message);
  } catch (error) {
    console.error('Error notifying admin:', error);
  }
}

async function handleAdminMsg(event: NewMessageEvent) {
  const message = event.message;
  if (message instanceof Api.Message && message.senderId && message.senderId.toString() === adminId.toString()) {
    if (message.message === '/db') {
      console.log('Admin requested database export');
      try {
        const filename = await exportDataToCSV();
        const fileStats = fs.statSync(filename);
        await client.sendFile(adminId, {
          file: filename,
          caption: `Database export: ${filename}\nSize: ${fileStats.size} bytes`,
        });
        fs.unlinkSync(filename);
        console.log('Database export sent to admin');
      } catch (error) {
        console.error('Error processing database export:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        await notifyAdmin(`Error exporting database: ${errorMessage}`);
      }
    }
  }
}

async function setupEventHandlers() {
  if (!botEntity) {
    throw new Error('Bot entity not initialized');
  }
  const botUserId = botEntity.userId.toJSNumber();
  client.addEventHandler(handleCheckMsg, new NewMessage({ fromUsers: [botUserId], incoming: true, forwards: true }));
  client.addEventHandler(handleSysMsg, new NewMessage({ fromUsers: [botUserId], incoming: true, pattern: /😱\d+/ }));
  client.addEventHandler(handleManualMsg, new NewMessage({ outgoing: true, chats: [botUserId] }));
  client.addEventHandler(handleAdminMsg, new NewMessage({ fromUsers: [adminId], incoming: true }));
}

async function exportDataToCSV(): Promise<string> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM reports');
    const fields = [
      'id', 'report_id', 'message_content', 'media_hashes', 'complaint_count',
      'source', 'sender', 'spam_probability', 'has_external_link',
      'has_internal_link', 'moderator_decisions', 'manual_classification',
      'created_at'
    ];
    const parser = new Parser({ fields });
    const csv = result.rows.length > 0 ? parser.parse(result.rows) : parser.parse([{}]);
    const filename = `reports_export_${Date.now()}.csv`;
    fs.writeFileSync(filename, csv);
    console.log(`CSV file created: ${filename}`);
    return filename;
  } catch (error) {
    console.error('Error exporting data to CSV:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await initDatabase();
    client = await initClient();
    await initBotEntity();
    await setupEventHandlers();
    console.log('Telegram client initialized successfully');

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });

    if (botEntity) {
      try {
        await client.sendMessage(botEntity, { message: "/next" });
        console.log('Initial message sent to bot');
      } catch (error) {
        console.error('Error sending initial message to bot:', error);
        await notifyAdmin(`Error sending initial message to bot: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new Error('Bot entity not initialized');
    }

    await notifyAdmin('Application initialized successfully');
  } catch (error) {
    console.error('Error initializing application:', error);
    if (client) {
      await notifyAdmin(`Error initializing application: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

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

main().catch(error => {
  console.error('Error in main function:', error);
  process.exit(1);
});