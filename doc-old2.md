# TAS - Система антиспама для Telegram

## 1. Обзор системы

TAS (Telegram Anti-Spam) - это автоматизированная система для обнаружения спама в группах Telegram. Система использует комбинацию методов, включая кэширование, быструю комплексную проверку, анализ мнений модераторов и проверку с помощью GPT для принятия решений о спам-сообщениях.

## 2. Архитектура системы

### 2.1 Основные компоненты
- Telegram Client (использует библиотеку telegram gramJS)
- Redis Cache (использует ioredis на Heroku)
- PostgreSQL Database (использует pg на Heroku)
- Express Server (для API и мониторинга)
- OpenAI API Client (для GPT проверок)

### 2.2 Основные модули
- Обработчики сообщений (handleCheck, handleSys, handleMod, handleAdd)
- Процессор отчетов (processReport)
- Проверки (fastCheck, modCheck, gptCheck)
- Кэш-менеджер
- Менеджер базы данных
- Система логирования и уведомлений

## 3. Конфигурация и переменные окружения

```typescript
// env:
const BOT_ID: string; 
const PORT: number = 3000;
const API_HASH: string;
const ADMIN_ID: string;
const REDIS_URL: string;
const DATABASE_URL: string;
const API_ID: number;
const DEEP_LOG: boolean;
const SESSION_STRING: string;
const OPENAI_API_KEY: string;
const BOT_ACCESS_HASH: string;

// обычные переменные:
const COMMAND_DELAY: number = 1000;
const MAX_CACHE_SIZE: number = 10000;
const DB_SCHEMA_VERSION: string = '1.0';
const MEDIA_EXPIRY: number = 600; // 10 minutes
const ENABLE_GPT_MEDIA_ANALYSIS: boolean = true;
const BUFFER_DELAY: number = 100; // 100 ms
const MAX_PROCESSING_TIME: number = 30000; // 30 seconds
```

## 4. Типы данных и интерфейсы

```typescript
interface Report {
  reportId: string;
  messageContent: string[];
  mediaHashes: string[];
  complaintCount: number;
  source: string;
  sender: string;
  isSpam: number;
  reason?: string;
  confidence?: number;
  timestamp: number;
  adminSender?: string;
  isOpen: boolean;
  decisionSent: boolean;
  moderatorsChecked?: boolean;
  gptChecked?: boolean;
}

type SpamDecision = {
  isSpam: number;
  reason: string;
  confidence: number;
  checkType: 'fast' | 'moderator' | 'gpt';
};
```

## 5. Регулярные выражения

```typescript
const sysRegex = {
  reportId: /#r(\d+)/,
  complaintCount: /😱(\d+)/,
  source: /^(?:🗣\s*)?Source:\s*(.+)/m,
  sender: /^Sender:\s*(.+)/m,
  admin: /^Admin:\s*(.+)/m,
  modFlood: /– Flood/,
  modNotSpam: /– Not Spam/
};
```

## 6. Обработка сообщений

### 6.1 Типы сообщений и их обработчики

1. **checkMsg** (сообщения для классификации)
   - Параметры: `incoming: true, forwards: true`
   - Обработчик: `handleCheck()`
   
   Цель: Обработка пересланных сообщений от бота для анализа на предмет спама.
   
   ```typescript
   async function handleCheck(event: NewMessageEvent): Promise<void> {
     // Проверка режима работы
     // Извлечение и предобработка сообщений (удаление первой строки)
     // Добавление сообщения и медиа в буфер
     // Планирование обработки буфера
   }
   ```

2. **sysMsg** (системные сообщения)
   - Параметры: `incoming: true, forwards: false, pattern: /Source:/`
   - Обработчик: `handleSys()`
   
   Цель: Обработка системных сообщений, содержащих метаданные отчета.
   
   ```typescript
   async function handleSys(event: NewMessageEvent): Promise<void> {
     // Извлечение информации об отчете
     // Добавление системного сообщения в буфер
     // Планирование обработки буфера
   }
   ```

3. **modMsg** (сообщения модераторов)
   - Параметры: `incoming: true, forwards: false, pattern: /Admin:/`
   - Обработчик: `handleMod()`
   
   Цель: Обработка сообщений от модераторов с их мнением о спаме.
   
   ```typescript
   async function handleMod(event: NewMessageEvent): Promise<void> {
     // Извлечение мнения модератора "– Flood" и "– Not Spam"
   }
   ```

4. **addMsg** (дополнительные сообщения)
   - Параметры: `incoming: true, forwards: false`
   - Обработчик: `handleAddMsg()`
   
   Цель: Обработка различных служебных сообщений от бота.
   
   ```typescript
   async function handleAddMsg(event: NewMessageEvent): Promise<void> {
  // - Типы сообщений и реакции:
  //  - "Hello there! Send /next to start processing reports." -> "/next 6"
  //  - "No Reports Found" -> выполнение функции undo()
  //  - "Please select 😡 BAN or 😌 NO." -> выполнение функции undo()
  // - "Sorry, an error has occurred during your request. Please try again later." -> выполнение функции undo()
  // - "Total this month:" - используется в проверке модераторов
   }
   ```

### 6.2 Буферизация сообщений

```typescript
let messageBuffer: Array<{type: 'check' | 'sys', content: string, reportId?: string, timestamp?: number}> = [];

function scheduleProcessing(): void {
  // Планирование обработки буфера с задержкой
}

async function processBuffer(currentTimestamp: number): Promise<void> {
  // Группировка сообщений по reportId или временному окну
  // Создание отчетов из сгруппированных сообщений
  // Обработка созданных отчетов
}
```

Цель: Обеспечение корректной группировки и обработки связанных сообщений.

## 7. Процесс обработки отчетов

```typescript
async function processReport(report: Report): Promise<void> {
  // 1. Проверка кэша
  // 2. Быстрая проверка (fastCheck)
  // 3. Проверка модераторов (modCheck)
  // 4. GPT проверка (gptCheck)
  // 5. Применение решения (или выполнение undo через 30 секунд в случае ошибки)
}
```

Цель: Координация процесса и очереди проверки отчета на спам с использованием различных методов.

### 7.1 Быстрая проверка (fastCheck)

```typescript
async function fastCheck(report: Report): Promise<SpamDecision | null> {
  // Проверка на наличие ссылок, контактов, медиа
  // Проверка на наличие инлайн-кнопок, историй, цитат
}
```

Цель: Быстрое определение явных признаков спама без использования сложных алгоритмов.

### 7.2 Проверка модераторов (modCheck)

```typescript
async function modCheck(report: Report): Promise<{ decision: SpamDecision | null, newSysMsg: boolean }> {
  // Отправка "/stats" и ожидание addMsg с помощью функции waitStats
  // Отправка reportId и ожидание adminMsg с помощью функции waitUpdated
  // Анализ мнений модераторов и сохранение решения в кеше
  // Отправка "/next 2" и завершение проверок (выход из processReport)
}

function processMod(sysMsg: string): SpamDecision | null {
  // Анализ количества "– Flood" и "– Not Spam"
  // Принятие решения на основе мнений модераторов
}
```

Цель: Учет мнений модераторов при определении спама.

### 7.3 GPT проверка (gptCheck)

```typescript
async function gptCheck(report: Report): Promise<SpamDecision | null> {
  // Подготовка промпта для GPT (включая контекст и метаданные)
  // Отправка запроса к OpenAI API (включая текст и медиа)
  // Анализ ответа GPT и принятие решения
}
```

Цель: Использование искусственного интеллекта для анализа сложных случаев спама.

## 8. Работа с кэшем и базой данных

### 8.1 Функции кэширования

```typescript
async function saveCache(report: Report): Promise<void>
async function getFromCache(reportId: string): Promise<Report | null>
async function checkCache(reportId: string): Promise<SpamDecision | null>
async function limitCacheSize(): Promise<void>
```

Цель: Оптимизация производительности путем кэширования часто используемых данных.

### 8.2 Функции работы с базой данных

```typescript
async function initDB(): Promise<void>
async function saveRedisToPostgres(): Promise<void>
async function generateCsvReport(): Promise<string>
```

Цель: Долгосрочное хранение данных и создание отчетов.

## 9. Обработка медиа

```typescript
async function getHash(media: Api.TypeMessageMedia): Promise<string> {
  // Определение всех типов медиа Telegram (фото, стикер, gif, видео и т.д.)
  // Возврат строки в формате "тип:идентификатор"
}

async function downloadAndStoreMedia(media: Api.TypeMessageMedia): Promise<string | null>
async function getMediaFromRedis(mediaKey: string): Promise<Buffer | null>
```

Цель: Обработка и хранение медиафайлов для анализа GPT.

## 10. Обработка ошибок и восстановление

```typescript
async function undo(reportId?: string): Promise<void>
async function reconnect(): Promise<void>

async function retry<T>(op: () => Promise<T>, maxRetries: number = 3, delay: number = 1000): Promise<T>
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T>
```

Цель: Обеспечение устойчивости системы к ошибкам и сбоям.

## 11. Команды администратора

```typescript
async function handleAdmin(event: NewMessageEvent): Promise<void> {
  // Обработка команд от adminId:
  // - /start: Активация автоматического режима
  // - /stop: Остановка работы и переход в ручной режим
  // - /status: Получение текущего статуса бота
  // - /time [value]: Установка задержки между командами
  // - /reset: Очистка кэша Redis
  // - /db: Выполнение операций с базой данных и генерация отчета для скачивания в CSV
}
```

Цель: Предоставление администратору инструментов управления системой.

## 12. Мониторинг и логирование

```typescript
const log = (message: string, level: 'info' | 'debug' | 'warn' | 'error' = 'info') => {
  // Логирование с использованием winston
}

async function notify(msg: string): Promise<void> {
  // Отправка уведомлений администратору через Telegram
}

function updateMetrics(processingTime: number): void {
  // Обновление метрик производительности
}

async function checkSystemHealth(): Promise<void> {
  // Проверка состояния Redis, PostgreSQL и Telegram-соединения
}
```

Цель: Обеспечение наблюдаемости системы и оперативное информирование о проблемах.

## 13. Инициализация и запуск

```typescript
async function initClient(): Promise<TelegramClient>
async function initBot(): Promise<void>
async function checkBotConnection(): Promise<void>

async function main() {
  // Инициализация компонентов системы
  // Настройка обработчиков событий
  // Запуск периодических задач
  // Обработка сигналов завершения работы
}

// Запуск приложения
main().catch(error => {
  logErr('main function', error);
  process.exit(1);
});
```

Цель: Настройка и запуск всех компонентов системы.

## 14. Дополнительные утилиты

```typescript
async function waitStats(timeout: number = 5000): Promise<boolean>
async function waitUpdated(reportId: string, timeout: number = 5000): Promise<string | null>
```

Цель: Обеспечение синхронизации при обработке асинхронных событий.

## 15. Периодические задачи

```typescript
schedule.scheduleJob('0 */2 * * *', saveRedisToPostgres);
schedule.scheduleJob('*/15 * * * *', checkSystemHealth);
schedule.scheduleJob('*/5 * * * *', limitCacheSize);
```

Цель: Автоматизация регулярных операций по обслуживанию системы.

## 16. Безопасность

- Использование переменных окружения для хранения чувствительных данных
- SSL-соединение с базами данных
- Проверка авторизации для административных команд

## 17. Масштабирование

- Горизонтальное масштабирование за счет использования Redis для кэширования
- Оптимизация запросов к базам данных

## 19. Обработка сигналов завершения

```typescript
process.on('SIGINT', async () => {
  // Graceful shutdown logic
});

process.on('SIGTERM', async () => {
  // Graceful shutdown logic
});

async function gracefulShutdown() {
  // Отключение автоматического режима
  // Закрытие соединений с базами данных
  // Отключение Telegram клиента
  // Отправка уведомления администратору
}
```

Цель: Обеспечение корректного завершения работы приложения при получении сигналов остановки.

## 21. Работа с LRU Cache

```typescript
const moderatorOpinionsCache = new LRUCache<string, string>({
  max: 1000,
  ttl: 1000 * 60, // 1 minute
});
```

Цель: Оптимизация хранения и доступа к часто используемым данным о мнениях модераторов.

## 22. Форматы данных

### 22.1 Формат отчета (Report)
```typescript
{
  reportId: string;
  messageContent: string[];
  mediaHashes: string[];
  complaintCount: number;
  source: string;
  sender: string;
  isSpam: number; // -1: не определено, 0: не спам, 1: спам
  reason?: string;
  confidence?: number;
  timestamp: number;
  adminSender?: string;
  isOpen: boolean;
  decisionSent: boolean;
  moderatorsChecked?: boolean;
  gptChecked?: boolean;
}
```

### 22.2 Формат решения о спаме (SpamDecision)
```typescript
{
  isSpam: number; // 0: не спам, 1: спам
  reason: string;
  confidence: number; // от 0 до 100
  checkType: 'fast' | 'moderator' | 'gpt';
}
```

## 23. Алгоритмы принятия решений

### 23.1 Быстрая проверка (fastCheck)
1. Проверка на наличие ссылок, @юзернеймов, контактов при количестве жалоб (> 2)
2. Проверка на наличие инлайн-кнопок, историй, цитат

### 23.2 Проверка модераторов (modCheck)
1. Анализ количества мнений "Flood" и "Not Spam"
2. Принятие решения на основе следующих правил:
   - 2 или более "Flood" -> Спам (100% уверенность)
   - 2 или более "Not Spam" -> Не спам (100% уверенность)
   - 1 "Flood" и 0 "Not Spam" -> Спам (90% уверенность)
   - 1 "Not Spam" и 0 "Flood" -> Не спам (90% уверенность)
   - Другие комбинации -> null

### 23.3 GPT проверка (gptCheck)
1. Подготовка промпта с контекстом отчета
2. Отправка запроса к OpenAI API
3. Анализ ответа GPT и преобразование в формат SpamDecision

## 24. Оптимизация производительности

1. Использование буфера сообщений для группировки связанных данных
2. Кэширование отчетов и решений в Redis
3. Асинхронная обработка отчетов
4. Периодическая очистка устаревших данных из кэша
5. Использование индексов в базе данных PostgreSQL

## 25. Обработка краевых случаев

1. Таймауты при ожидании ответов от внешних сервисов
2. Повторные попытки при временных сбоях сети
3. Обработка неполных или некорректных данных в отчетах
4. Защита от зацикливания при обработке отчетов

## 26. Мониторинг и метрики

1. Среднее время обработки отчета
2. Количество обработанных отчетов
3. Распределение решений (спам/не спам)
4. Частота использования различных типов проверок
5. Статистика использования кэша
6. Мониторинг состояния соединений с внешними сервисами

## 27. Заключение

Данная документация предоставляет полное описание системы TAS, включая её архитектуру, основные компоненты, алгоритмы работы и рекомендации по развертыванию и обслуживанию. При реализации проекта следует придерживаться описанных здесь принципов и структур, но также быть готовым к возможным изменениям и улучшениям в процессе разработки и эксплуатации системы.