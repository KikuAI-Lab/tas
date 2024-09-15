import dotenv from 'dotenv';
import pkg from 'pg';
const { Pool } = pkg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

dotenv.config();

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL!;

// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Interface for the report data
interface Report {
  report_id: string;
  message_content: string[];
  complaint_count: number;
  source: string;
  sender: string;
  is_spam: number;
  media_hashes: string[];
}

// Function to clean and prepare the data
async function prepareData(): Promise<Report[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        report_id,
        message_content,
        complaint_count,
        source,
        sender,
        is_spam,
        media_hashes
      FROM reports
      WHERE is_spam IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 10000
    `);

    return result.rows.map((row: any) => ({
      ...row,
      message_content: row.message_content.filter((msg: string) => msg.trim() !== ''),
    }));
  } finally {
    client.release();
  }
}

function createChatFineTuningExample(report: Report): { messages: ChatCompletionMessageParam[] } {
  const systemMessage: ChatCompletionMessageParam = {
    role: "system",
    content: `You are an AI specialized in detecting commercial spam in Telegram groups across any language. Analyze the provided message based on content, context and metadata. Respond with only:
1 for spam
0 for not spam

Spam Indicators:
- Unsolicited commercial content or subtle marketing
- Phishing, fake giveaways, unrealistic financial promises
- Explicit sexual content or coded invitations for sexual services
- Attempts to move conversations to private channels or other platforms
- Sharing personal information without consent
- >500 identical symbols or emojis
- Self-promotion of unrelated channels/groups
- Cryptocurrency/airdrop mentions with urgent calls to action
- Any job offers, vacancies, or job postings
- Multiple links, especially to bots or channels
- Encrypted or coded messages resembling adult content sales
- Requests to write in private messages
- Common spam keywords
- Sender names containing links or solicitations

Not Spam Indicators:
- Normal interactions, casual conversations, jokes
- Legitimate information sharing, news, educational content
- Expressive language, including aggressive profanity
- Cultural content, local slang, region-specific discussions
- Political discussions or criticisms (especially in Russian or Ukrainian)
- Bot commands (starting with "/"), unless misused
- Warnings about scams or spam
- Short messages part of ongoing conversations
- Satirical or ironic content
- Controversial opinions without incitement
- Single-word greetings or short phrases
- Emotional expressions or outbursts

Context Considerations:
- Semantic analysis of meaning and intent
- Conversation flow and group theme
- Cultural and linguistic context, sender's country
- Relevance to ongoing discussions or group activities
- Complaint counts (not solely relied upon)
- 'Source' field used for context, not spam evaluation

REMINDER: Respond ONLY with 1 or 0. No explanations.`
  };

  const userMessage: ChatCompletionMessageParam = {
    role: "user",
    content: `Context:
- Complaint count: ${report.complaint_count}
- Source: ${report.source}
- Sender: ${report.sender}
${report.media_hashes.length > 0 ? `- Media types present: ${report.media_hashes.map(hash => hash.split(':')[0]).join(', ')}` : ''}

Message content:
"""
${report.message_content.join('\n')}
"""

Analyze for spam:`
  };

  const assistantMessage: ChatCompletionMessageParam = {
    role: "assistant",
    content: report.is_spam.toString()
  };

  return { messages: [systemMessage, userMessage, assistantMessage] };
}

// Function to create fine-tuning examples
function createFineTuningExample(report: Report): { prompt: string; completion: string } {
  const systemMessage = `Classify Telegram multilingual messages as spam (1) or not spam (0). Analyze:

1. Message content and context
2. Metadata: complaint count, source, sender, media types ('Source' field used for context, not spam evaluation)

Spam indicators:
- Unsolicited commercial content, phishing, explicit material
- Attempts to move conversations to private channels
- Excessive repetition, multiple links, unsolicited job offers
- Explicit sexual content or coded invitations for sexual services

Non-spam indicators:
- Normal conversations, greetings, legitimate information sharing
- Cultural content, political discussions (especially in Russian or Ukrainian)
- Bot commands, short messages in ongoing chats
- Expressive language, including aggressive profanity

Respond only with 0 (not spam) or 1 (spam).`;

  const userMessage = `Message: ${report.message_content.join('\n')}
Complaint count: ${report.complaint_count}
Source: ${report.source}
Sender: ${report.sender}
Media types: ${report.media_hashes.map(hash => hash.split(':')[0]).join(', ') || 'None'}`;

  return {
    prompt: `${systemMessage}\n\n${userMessage}`,
    completion: report.is_spam.toString()
  };
}

function estimateMessageLength(message: ChatCompletionMessageParam): number {
  if (typeof message.content === 'string') {
    return message.content.length;
  } else if (Array.isArray(message.content)) {
    return message.content.reduce((contentSum, part) => {
      return contentSum + estimateContentPartLength(part);
    }, 0);
  } else if (message.content === null || message.content === undefined) {
    return 0;
  } else {
    console.warn('Unexpected message content type:', typeof message.content);
    return 0;
  }
}

function estimateContentPartLength(part: unknown): number {
  if (typeof part === 'string') {
    return part.length;
  } else if (typeof part === 'object' && part !== null) {
    if ('type' in part && typeof part.type === 'string') {
      switch (part.type) {
        case 'text':
          return 'text' in part && typeof part.text === 'string' ? part.text.length : 0;
        case 'image_url':
          return 100;
        default:
          console.warn('Unexpected content part type:', part.type);
          return 0;
      }
    } else {
      console.warn('Content part object does not have a valid "type" property:', part);
      return 0;
    }
  } else {
    console.warn('Unexpected content part:', part);
    return 0;
  }
}

function splitDataIntoChunks(data: { messages: ChatCompletionMessageParam[] }[]): { messages: ChatCompletionMessageParam[] }[][] {
  console.log(`Starting to split ${data.length} examples into chunks...`);
  const chunks: { messages: ChatCompletionMessageParam[] }[][] = [];
  let currentChunk: { messages: ChatCompletionMessageParam[] }[] = [];
  let currentTokenCount = 0;
  const TARGET_CHUNK_SIZE = 1000000; // 1 million tokens

  for (const example of data) {
    const tokenCount = estimateTokenCount(example);
    if (currentTokenCount + tokenCount > TARGET_CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      console.log(`Chunk created with ${currentChunk.length} examples and approximately ${currentTokenCount} tokens`);
      currentChunk = [];
      currentTokenCount = 0;
    }
    currentChunk.push(example);
    currentTokenCount += tokenCount;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
    console.log(`Final chunk created with ${currentChunk.length} examples and approximately ${currentTokenCount} tokens`);
  }

  console.log(`Splitting completed. Created ${chunks.length} chunks.`);
  return chunks;
}

function estimateTokenCount(example: { messages: ChatCompletionMessageParam[] }): number {
  return example.messages.reduce((sum, message) => sum + estimateMessageLength(message), 0);
}

// Function to export data to JSONL files
function exportDataToJSONL(data: { messages: ChatCompletionMessageParam[] }[][]): string[] {
  const filePaths: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const chunk = data[i];
    const filePath = path.join(tmpdir(), `fine_tuning_data_${i + 1}.jsonl`);
    
    const jsonlContent = chunk.map(example => JSON.stringify({
      messages: example.messages
    })).join('\n');
    
    fs.writeFileSync(filePath, jsonlContent);
    
    filePaths.push(filePath);
  }

  return filePaths;
}

// Main function to handle the /fine command
async function handleFineCommand(): Promise<string[]> {
  try {
    console.log('Starting fine-tuning data preparation...');
    
    console.log('Preparing data...');
    const startPrepare = Date.now();
    const rawData = await prepareData();
    console.log(`Data preparation completed. Time taken: ${(Date.now() - startPrepare) / 1000} seconds. Records retrieved: ${rawData.length}`);
    
    console.log('Creating fine-tuning examples...');
    const startCreate = Date.now();
    const fineTuningData = rawData.map(createChatFineTuningExample);
    console.log(`Fine-tuning examples created. Time taken: ${(Date.now() - startCreate) / 1000} seconds. Examples created: ${fineTuningData.length}`);
    
    console.log('Splitting data into chunks...');
    const startSplit = Date.now();
    const dataChunks = splitDataIntoChunks(fineTuningData);
    console.log(`Data split into chunks. Time taken: ${(Date.now() - startSplit) / 1000} seconds. Number of chunks: ${dataChunks.length}`);
    
    console.log('Exporting data to JSONL files...');
    const startExport = Date.now();
    const filePaths = exportDataToJSONL(dataChunks);
    console.log(`Data export completed. Time taken: ${(Date.now() - startExport) / 1000} seconds. Files created: ${filePaths.length}`);
    
    console.log('Fine-tuning data preparation completed successfully.');
    return filePaths;
  } catch (error) {
    console.error('Error in handleFineCommand:', error);
    throw error;
  }
}

// Export the handleFineCommand function
export { handleFineCommand };

// For testing purposes
if (import.meta.url === fileURLToPath(import.meta.resolve('./finetune.ts'))) {
  handleFineCommand()
    .then(filePaths => {
      console.log('JSONL files created:');
      filePaths.forEach(path => console.log(path));
    })
    .catch(error => {
      console.error('Error:', error);
    });
}