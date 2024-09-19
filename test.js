const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');  
const path = require('path');
const { extractTextFromExcel } = require('./excel-utils'); // Функция для извлечения текста из Excel
const { extractTextFromWord } = require('./word-utils'); // Функция для извлечения текста из Word
const schedule = require('node-schedule');
const xlsx = require('xlsx');
require('dotenv').config();

// Замените YOUR_BOT_TOKEN на токен вашего бота, который вы получили у BotFather
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
// 7507226128:AAFZnECFi1hWenTbFByqNW3niVo1jF1YWCQ
const shopId = process.env.shopId;
const secretKey = process.env.secretKey;
const channelId = '@evolution_projekt';

// Замените YOUR_OPENAI_API_KEY на ваш API-ключ OpenAI
const openai = new OpenAI({
    apiKey: process.env.apiKey,
});

const analyzeText = async (prompt, text) => {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: prompt
            },
            { role: 'user', content: text }
        ]
    });
    return response.choices[0].message.content;
};

let botEnabled = false

// Функция для проверки формата времени (HH:mm)
function isValidTime(time) {
    const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
    return timePattern.test(time);
}

const admins = [1292205718, 1301142907, 1092309039];
// 1092309039
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
  
    const commandHandlers = {
      table: async () => {
        await sendExcelFile(chatId);
      },
      broadcast: () => {
        bot.sendMessage(chatId, 'Введите сообщение для рассылки.');
        bot.once('message', async (msg) => {
          if (admins.includes(msg.chat.id)) {
            await broadcastMessage(msg.text);
            bot.sendMessage(chatId, 'Сообщение разослано.');
          }
        });
      },
      third_button: () => {
        bot.sendMessage(chatId, 'Третья кнопка будет реализована позже.');
      }
    };
  
    const handler = commandHandlers[query.data];
    if (handler) {
      await handler();
    } 
});

// Функция отправки Excel файла с данными пользователей
async function sendExcelFile(chatId) {
    try {
      db.all('SELECT * FROM users', [], (err, rows) => {
        if (err) {
          throw err;
        }
  
        // Преобразуем данные в формат для Excel
        const worksheet = xlsx.utils.json_to_sheet(rows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Users');
        
        // Записываем файл
        const filename = 'users.xlsx';
        xlsx.writeFile(workbook, filename);
        
        // Отправляем файл пользователю
        bot.sendDocument(chatId, filename);
      });
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Произошла ошибка при создании файла.');
    }
  }
  
  // Функция рассылки сообщения всем пользователям
  async function broadcastMessage(text) {
    try {
      db.all('SELECT telegram_id FROM users', [], (err, rows) => {
        if (err) {
          throw err;
        }
  
        rows.forEach((user) => {
          bot.sendMessage(user.telegram_id, text);
        });
      });
    } catch (err) {
      console.error(err);
    }
  }

// Создание и подключение к базе данных
const db = new sqlite3.Database('bot_gpt.db');

// Создание таблицы пользователей, если она не существует
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER UNIQUE,
            subscription BOOLEAN DEFAULT false,
            theme TEXT DEFAULT 'Нету',
            prompt TEXT DEFAULT 'Вы можете использовать этот бот для различных целей. Просто задайте вопрос.',
            query_count INTEGER DEFAULT 0,
            discount INTEGER DEFAULT 0,
            discount_expiry INTEGER DEFAULT 0,
            trial_days INTEGER DEFAULT 0,
            trial_expiry INTEGER DEFAULT 0,
            plan TEXT DEFAULT 'Пробный период',
            amount INTEGER,
            start_date TEXT,
            end_date TEXT,
            requests DEFAULT 5
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER,
            question TEXT,
            FOREIGN KEY (telegram_id) REFERENCES users (telegram_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS user_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            channel_id TEXT,
            topic TEXT,
            post_length TEXT,
            post_time TEXT,
            channel_topic TEXT,
            FOREIGN KEY(user_id) REFERENCES users(telegram_id)
        )
    `);
});

// Функция для сохранения информации о пользователе и его подписке в базу данных
function saveUserSubscription(chatId, plan, amount, requests) {
    const startDate = new Date();

    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // Устанавливаем срок действия подписки на 1 месяц
    
    // Вставляем или обновляем запись о пользователе
    db.run(`INSERT INTO users (chat_id, plan, amount, start_date, end_date, requests) 
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET 
                plan=excluded.plan, 
                amount=excluded.amount, 
                start_date=excluded.start_date, 
                end_date=excluded.end_date, 
                requests=excluded.requests`,
        [chatId, plan, amount, startDate.toISOString(), endDate.toISOString(), requests],
        (err) => {
            if (err) {
                console.error('Ошибка при сохранении подписки:', err.message);
            } else {
                
                console.log(`Подписка ${plan} на сумму ${amount/100} рублей с ${requests} запросами сохранена для пользователя ${chatId}.`);
            }
        });
}

async function createAndSendPost(userId, channelId) {
    db.get('SELECT topic, post_length, channel_topic FROM user_channels WHERE user_id = ? AND channel_id = ?', [userId, channelId], async (err, row) => {
        if (err) {
            console.error(err.message);
            return;
        }

        if (row) {
            const { topic, post_length, channel_topic } = row;

            // Генерация текста поста через GPT
            const prompt = `Ты ${topic} и написать пост на тему ${channel_topic}, длиной ${post_length} но максимум 1500 символов, также добавляй разные смайлики`;
            // const response = await openai.createCompletion({
            //     model: 'gpt-4o-mini',
            //     prompt: prompt,
            //     max_tokens: Math.floor(Number(post_length) / 4), // Примерная длина текста в токенах
            // });
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: prompt
                    },
                    { role: 'user', content: prompt }
                ]
            });
            const postContent = response.choices[0].message.content;

            // Отправка поста в канал
            bot.sendMessage(channelId, postContent);
        }
    });
}

// Планировщик для публикации постов
function schedulePost(userId, channelId, postTime) {
    const [hour, minute] = postTime.split(':');

    // Установка расписания на каждый день в указанное время
    schedule.scheduleJob(`${minute} ${hour} * * *`, () => {
        createAndSendPost(userId, channelId);
    });
}

// Установка планировщика для всех пользователей при старте бота
db.all('SELECT user_id, channel_id, post_time FROM user_channels', [], (err, rows) => {
    if (err) {
        console.error(err.message);
        return;
    }

    rows.forEach((row) => {
        const { user_id, channel_id, post_time } = row;
        schedulePost(user_id, channel_id, post_time);
    });
});

// Функция для создания платежа
function createPayment(amount, chatId, plan, requests) {
    const idempotenceKey = uuidv4();
    const paymentData = {
        amount: {
            value: (amount / 100).toFixed(2), // Сумма в рублях
            currency: "RUB"
        },
        confirmation: {
            type: "redirect",
            return_url: `https://t.me/${bot.username}`
        },
        capture: true,
        description: `Оплата подписки: ${plan}`
    };

    return axios.post('https://api.yookassa.ru/v3/payments', paymentData, {
        auth: {
            username: shopId,
            password: secretKey
        },
        headers: {
            'Idempotence-Key': idempotenceKey
        }
    })
    .then(response => {
        const payment = response.data;
        const paymentUrl = payment.confirmation.confirmation_url;
        const paymentId = payment.id;

        // Сохраняем информацию о платеже
        payments[chatId] = { paymentId, plan, amount, requests };

        console.log(`Платеж создан: ${paymentId}, сумма: ${amount/100} рублей, план: ${plan}`);

        // Начинаем проверку статуса платежа сразу после создания
        checkPaymentStatus(paymentId, chatId, plan, amount, requests);

        return paymentUrl; // Возвращаем ссылку на оплату
    })
    .catch(error => {
        console.error('Ошибка при создании платежа:', error.response.data);
        throw new Error('Ошибка при создании платежа. Повторите попытку позже.');
    });
}

function saveFileData(telegramId, fileName, filePath, extractedText, callback) {
    db.run(
        `INSERT INTO files (telegram_id, file_name, file_path, extracted_text) VALUES (?, ?, ?, ?)`,
        [telegramId, fileName, filePath, extractedText],
        function (err) {
            if (err) {
                console.error('Ошибка сохранения данных о файле в базу:', err);
                return callback(err);
            }
            console.log('Данные о файле успешно сохранены.');
            callback(null, this.lastID);
        }
    );
}


// Временное хранилище платежей
let payments = {};

// Функция для добавления пользователя
function addUser(telegramId, callback) {
    db.run(`INSERT OR IGNORE INTO users (telegram_id) VALUES (?)`, [telegramId], callback);
}

// Функция для изменения темы пользователя
function changeUserTheme(telegramId, theme, prompt, callback) {
    db.run(`UPDATE users SET theme = ?, prompt = ? WHERE telegram_id = ?`, [theme, prompt, telegramId], callback);
}

// Функция для получения промта пользователя
function getUserPrompt(telegramId, callback) {
    db.get(`SELECT prompt FROM users WHERE telegram_id = ?`, [telegramId], callback);
}

// Функция для увеличения счетчика запросов пользователя
function incrementQueryCount(telegramId, callback) {
    db.run(`UPDATE users SET query_count = query_count + 1 WHERE telegram_id = ?`, [telegramId], callback);
}

// Функция для сохранения вопроса пользователя
function saveUserQuestion(telegramId, question, callback) {
    db.run(`INSERT INTO questions (telegram_id, question) VALUES (?, ?)`, [telegramId, question], callback);
}

// Функция для получения информации о подписке, теме и количестве запросов
function getUserSubscriptionInfo(telegramId, callback) {
    db.get(`SELECT subscription, query_count, theme, discount, discount_expiry, requests, plan  FROM users WHERE telegram_id = ?`, [telegramId], callback);
}

// Функция для получения всех доступных тем
const themes = {
    'programming 💻': 'Вы помогаете пользователю с вопросами по программированию. Будьте детализированы и полезны. ',
    'sports 🏀⚽️🏈': 'Вы обсуждаете различные виды спорта. Предоставляйте спортивные новости и обсуждайте результаты матчей.',
    'music 🎶': 'Вы являетесь экспертом в мире музыки. Обсуждайте новые релизы, исполнителей и жанры. ',
    'travel ✈️': 'Вы помогаете пользователю планировать путешествия. Делитесь советами по выбору места, бронированию и т.д. ',
    'cooking 🍳': 'Вы даёте рецепты, советы по приготовлению пищи и рассказываете о кулинарных традициях разных стран. ',
    'history 🏛️': 'Вы эксперт по истории. Рассказывайте интересные факты, делитесь историческими анекдотами и отвечайте на вопросы о прошлом. ',
    'science 🧪': 'Вы делитесь фактами и новостями из мира науки. Объясняйте сложные вещи простым языком. ',
    'philosophy 🤔': 'Вы ведете глубокие философские беседы. Обсуждайте этические вопросы, смыслы жизни и другие фундаментальные темы. ',
    'literature 📚': 'Вы любитель литературы. Обсуждайте книги, авторов, литературные жанры. ',
    'art 🎨': 'Вы разбираетесь в искусстве. Делитесь знаниями о живописи, скульптуре, архитектуре, музыке. ',
    'psychology 🧠': 'Вы помогаете пользователю разобраться в себе. Делитесь советами по саморазвитию и отвечайте на вопросы о психологии человека. ',
    'business 📈': 'Вы обсуждаете бизнес-стратегии, экономику, маркетинг. Делитесь советами по ведению бизнеса. ',
    'fashion 👗': 'Вы помогаете пользователю разбираться в мире моды. Делитесь последними трендами, даёте советы по стилю. ',
    'nature 🌳': 'Вы любитель природы. Рассказываете о животных, растениях, экологии, путешествиях по дикой природе. ',
    'movies 🎬': 'Вы знаток кино. Обсуждайте фильмы, актеров, режиссеров, даёте рекомендации. ',
    'Лингвист': 'Я лингвист, и моя задача — помочь вам освоить любой язык. Я изучаю, как устроены языки, как они работают и чем отличаются друг от друга. С моей помощью вы сможете научиться говорить на новом языке, ведь я предоставлю вам учебные материалы, объясню грамматику, правила и особенности произношения. Я также разработаю для вас эффективные методы обучения, чтобы процесс освоения языка был лёгким и увлекательным.'
};
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    // Отправляем меню с кнопками
    if (admins.includes(chatId)) {
        bot.sendMessage(chatId, 'Админ панель', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Таблица', callback_data: 'table' }],
              [{ text: 'Рассылка', callback_data: 'broadcast' }],
              [{ text: 'Третья кнопка', callback_data: 'third_button' }]
            ]
          }
        })
    }
})
// Обработка команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const chatik = -1002478872141
    try {
        // Проверяем подписан ли пользователь на канал
        const chatMember = await bot.getChatMember(channelId, chatId);
        const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);

        if (isMember) {
            // Если пользователь подписался, удаляем сообщение
            await bot.deleteMessage(chatId, msg.message_id);
        }

        if (!isMember) {
            // Отправляем сообщение с кнопкой "Я подписался"
            bot.sendMessage(chatId, 'Вы не подписаны на наш канал. Пожалуйста, подпишитесь, чтобы продолжить использовать бота.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Подписаться на канал', url: `https://t.me/${channelId.replace('@', '')}` }],
                        [{ text: 'Я подписался', callback_data: 'check_subscription' }]
                    ]
                }
            });

            // Запускаем проверку подписки каждые 30 секунд
            const intervalId = setInterval(async () => {
                try {
                    const chatMember = await bot.getChatMember(channelId, chatId);
                    const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);

                    if (isMember) {
                        clearInterval(intervalId); // Останавливаем проверку, если пользователь подписался
                        
                    }
                } catch (error) {
                    console.error('Ошибка при периодической проверке подписки:', error);
                }
            }, 30000); // Проверка каждые 30 секунд
        } else {
            addUser(chatId, (err) => {
                if (err) {
                    console.error('Ошибка добавления пользователя:', err);
                    bot.sendMessage(chatId, 'Произошла ошибка при добавлении вас в базу данных.');
                    return;
                }})
            
            bot.sendPhoto(chatId, 'photo.jpg', {
            caption: `Выберите действие`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: truncateText('Задать вопрос'), callback_data: 'ask_question' }],
                    [
                        { text: truncateText('Выборать тему'), callback_data: 'change_theme' },
                        { text: truncateText('Выбор тарифа'), callback_data: 'buy_subscription' }
                    ],
                    [
                        { text: truncateText('Кабинет'), callback_data: 'cabinet' },
                        { text: truncateText('Поддержка'), callback_data: 'support' }
                    ]
                ]
            }
        });
            // Если пользователь уже подписан
    }
        // Если пользователь подписан, отправляем приветственное сообщение

    } catch (error) {
        console.error('Ошибка проверки подписки или отправки сообщения:', error);
        bot.sendMessage(chatId, 'Произошла ошибка. Пожалуйста, попробуйте снова.');
    }
})
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    if (data === 'check_subscription') {
        try {
            // Проверяем, подписан ли пользователь на канал
            const chatMember = await bot.getChatMember(channelId, chatId);
            const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);

            if (isMember) {
                await bot.deleteMessage(chatId, msg.message_id);
                // Если пользователь подписался
                    bot.sendPhoto(chatId, 'photo.jpg', {
                caption: `Приветствую тебя 👋
            
Я ZEVS ⚡️- твой универсальный помощник 24/7 
    
Я помогу тебе в любых твоих вопросах и задачах. Независимо от того, с чем ты столкнулся — будь то программирование, учеба, личные вопросы или просто желание поговорить
    
🧑‍💻Помощь с кодом или техническими вопросами?

🧠Советы по личному 
развитию и карьере?

💡Идеи для новых проектов?

📚Поиск информации или 
материалов для учебы?
    
🌎Любой другой вопрос или проблема?
    
Просто задай свой вопрос, и я сделаю всё, чтобы тебе помочь 👇
    
⭐️Обязательно закрепи меня, чтобы я не потерялся и продолжил тебе помогать!`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: 'Начать ✨',
                                callback_data: 'start',
                            }
                        ]
                    ]
                }
            });
    
        
            } else {
                // Если пользователь все еще не подписан
                bot.sendMessage(chatId, 'Вы еще не подписаны. Пожалуйста, подпишитесь на наш канал.', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Подписаться на канал', url: `https://t.me/${channelId.replace('@', '')}` }],
                            [{ text: 'Я подписался', callback_data: 'check_subscription' }]
                        ]
                    }
                });
            }
        } catch (error) {
            console.error('Ошибка при проверке подписки через кнопку:', error);
            bot.sendMessage(chatId, 'Произошла ошибка при проверке подписки. Пожалуйста, попробуйте снова.');
        }
    }
});
// Функция для обрезки текста кнопок до 20 символов
function truncateText(text, maxLength = 20) {
    return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}


// Переменные для хранения состояния ожидания
const awaitingQuestion = new Set();
const awaitingThemeSelection = new Set();
const awaitingPromoCode = new Map(); // Добавляем новый Set для ожидания промокода



// Обработка нажатия на кнопку "Начать"
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    const action = callbackQuery.data;

    // const chatMember = await bot.getChatMember(channelId, chatId);
    // const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);

    //     if (!isMember) {
    //         bot.sendMessage(chatId, 'Вы не подписаны на наш канал. Пожалуйста, подпишитесь, чтобы продолжить использовать бота.', {
    //             chat_id: chatId,
    //             reply_markup: {
    //                 inline_keyboard: [
    //                     [{ text: 'Подписаться на канал', url: `https://t.me/${channelId.replace('@', '')}` }]
    //                 ]
    //             }
    //         });
    //         return;
    //     }
    if (data === 'start') {
        bot.editMessageCaption('Выберите действие', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: truncateText('Задать вопрос'), callback_data: 'ask_question' }],
                    [
                        { text: truncateText('Выборать тему'), callback_data: 'change_theme' },
                        { text: truncateText('Выбор тарифа'), callback_data: 'buy_subscription' }
                    ],
                    [
                        { text: truncateText('Кабинет'), callback_data: 'cabinet' },
                        { text: truncateText('Поддержка'), callback_data: 'support' }
                    ]
                ]
            }
        });
    } else if (data === 'ask_question') {
        botEnabled = true;
        awaitingQuestion.add(chatId);
        bot.sendMessage(chatId, 'Задайте свой вопрос.');
    } else if (data === 'change_theme') {
        getUserSubscriptionInfo(chatId, (err, row) => {
            const papa = row.plan
            if (papa != 'профи 👨‍💻' && papa != 'премиум 🌟'){
                bot.sendMessage(chatId, 'Сначала нужно купить подписку профи 👨‍💻 или премиум 🌟')
            } else {
            awaitingThemeSelection.add(chatId);
    
            const themeButtons = Object.keys(themes).map(theme => [
                { text: truncateText(theme.charAt(0).toUpperCase() + theme.slice(1)), callback_data: `select_theme_${theme}` }
            ]);
            const back = [{ text: 'Назад', callback_data: 'start' }]
            bot.editMessageCaption('Выберите тему для общения с GPT:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard:
                    themeButtons
                }
            });
            }
        });
     
    } else if (data === 'buy_subscription') {
        
        const paymentUrl169 = await createPayment(17900, chatId, 'базовый ⚡', 100); // 169 рублей, 100 запросов
        const paymentUrl319 = await createPayment(33900, chatId, 'стандарт 🚀', 250); // 319 рублей, 250 запросов
        const paymentUrl499 = await createPayment(59900, chatId, 'профи 👨‍💻', 500); // 499 рублей, 500 запросов
        const paymentUrl999 = await createPayment(99900, chatId, 'премиум 🌟', 1000); // 999 рублей, 1000 запросов

        bot.editMessageCaption(`*Базовый* 
        
план подписки включает 100 запросов в месяц.,

*Стандарт* 

(250 запросов в месяц) 📚
* Доступ к базовому выбору тем. 
* Возможность сохранять историю запросов 💾
            
*Профи* 

(500 запросов в месяц) 👨‍💻
* Для профессионального использования, подходит для учебы, блогеров, писателей и т.д. 
* Доступ ко всем выбором тем. 
            
            
*Премиум* 

(неограниченные запросы в месяц) 🌟
* Неограниченное количество запросов. 
* Возможность использовать бота для работы с файлами. 📂
* Доступ к эксклюзивным функциям ИИ. 🤖
* Персональный менеджер по работе с ботом. 🦸‍♀️`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
        inline_keyboard: [
            [{ text: '179 RUB базовый ⚡', url: paymentUrl169 }],
            [{ text: '339 RUB стандарт 🚀', url: paymentUrl319 }],
            [{ text: '599 RUB профи 👨‍💻', url: paymentUrl499 }],
            [{ text: '999 RUB премиум 🌟', url: paymentUrl999 }],
            [ {text: 'Свой тариф', callback_data: 'create_tarif'}],
            [ {text: 'Меню', callback_data: 'start'}]
        ]
    }
})
    }else if (data === 'support') {
        bot.editMessageCaption('Вы можете написать в техподдержку', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard:[
                    [{ text: "Техподдержка", url: "https://t.me/lil_mamym"}],
                    [{ text: 'Назад', callback_data: 'start' }]
                ]
            }
        })
    }
        // // // Отправляем сообщение с инлайн-кнопками для оплаты
        // bot.sendMessage(chatId, 'Вы можете купить подписку. Выберите тариф:', {
        //     reply_markup: {
        //         inline_keyboard: [
        //             [{ text: '169 RUB базовый ⚡', url: paymentUrl169 }],
        //             [{ text: '319 RUB стандарт 🚀', url: paymentUrl319 }],
        //             [{ text: '499 RUB профи 👨‍💻', url: paymentUrl499 }],
        //             [{ text: '999 RUB премиум 🌟', url: paymentUrl999 }]
        //         ]
        //     }
        // });

    else if (data === 'create_tarif'){
            botEnabled = false;
            bot.sendMessage(chatId, 'Отпрвьте кольчество нужных вам запросов')
            bot.once('message', async (msg) => {
                console.log(msg.text)
                const numb = msg.text;
                const pp  = Number(numb)
                if (pp < 50) {
                    const nnn = pp*4*100
                    const jjj = pp*4
                        const paymentUrl = await createPayment(nnn, chatId, 'Свой', pp); 
                        bot.sendMessage(chatId, `Можете оплачивать ваши ${pp} запросы`,{
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `${jjj} RUB 'Свой тариф'`, url: paymentUrl }]
                                ]
                            }
                        }
                    )
                }
                if (pp >= 50 && pp < 500) {
                    const nnn = pp*2.5*100
                    const jjj = pp*2.5
                        const paymentUrl = await createPayment(nnn, chatId, 'Свой', pp); 
                        bot.sendMessage(chatId, `Можете оплачивать ваши ${pp} запросы`,{
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `${jjj} RUB 'Свой тариф'`, url: paymentUrl }]
                                ]
                            }
                        }
                    )
                }
                if (pp >= 500 && pp < 5000) {
                    const nnn = pp*2*100
                    const jjj = pp*2
                        const paymentUrl = await createPayment(nnn, chatId, 'Свой', pp); 
                        bot.sendMessage(chatId, `Можете оплачивать ваши ${pp} запросы`,{
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `${jjj} RUB 'Свой тариф'`, url: paymentUrl }]
                                ]
                            }
                        }
                    )
                }
                if (pp > 5000) {
                    bot.sendMessage(chatId, `Слишком много хочешь`)
                }
                // const nnn = pp*4*100
                // const jjj = pp*4
                //     const paymentUrl = await createPayment(nnn, chatId, 'Свой', pp); // 169 рублей, 100 запросов
                //     bot.sendMessage(chatId, `Можете оплачивать ваши ${pp} запросы`,{
                //         reply_markup: {
                //             inline_keyboard: [
                //                 [{ text: `${jjj} RUB 'Свой тариф'`, url: paymentUrl }]
                //             ]
                //         }
                //     }
                // )
})}
    else if (data === 'cabinet') {
        botEnabled = false;
        getUserSubscriptionInfo(chatId, (err, row) => {
            if (err) {
                console.error('Ошибка получения данных пользователя:', err);
                bot.sendMessage(chatId, 'Произошла ошибка при получении данных.');
                return;
            }

            // const subscriptionStatus = row.plan ? row.plan : 'Пробный период';
            const remainingQueries = row.subscription ? 'Неограниченно' : `Осталось ${row.requests} запросов`;
            const currentTheme = row.theme.charAt(0).toUpperCase() + row.theme.slice(1);
            const discount = row.discount && row.discount_expiry > Date.now() ? `Скидка: ${row.discount} рублей` : '';
            
            bot.editMessageCaption( 
                `Ваш статус: ${row.plan}\nВсего запросов: ${row.query_count}\n${remainingQueries}\nТекущая тема: ${currentTheme}\n${discount}`,{
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard:[
                            [{ text: 'Привязать канал', callback_data: 'attach_channel' }, { text: 'Привязанные каналы', callback_data: 'view_channels' }],
                            [{ text: 'Назад', callback_data: 'start' }]
                        ]
                    }
                });
        })}
        else if (data === 'attach_channel') {
            botEnabled = false;
            db.get('SELECT plan FROM users WHERE telegram_id = ?', [userId], (err, row) => {
                if (err) {
                    console.error(err.message);
                    bot.sendMessage(chatId, 'Ошибка базы данных');
                    return;
                }
            if (!row || row.plan !== 'премиум 🌟') {
                bot.sendMessage(chatId, 'Для этой функции вам нужно купить подписку Премиум🌟.');
            } else {
                // Спрашиваем у пользователя ID канала
                bot.sendMessage(chatId, 'Пожалуйста, перешлите сообщение из вашего канала и добавьте в него бота.');

                bot.once('message', (msg) => {
                    const channelId = msg.forward_from_chat.id;

                    // Спрашиваем тему канала
                    bot.sendMessage(chatId, 'Какая тема вашего канала?');

                    bot.once('message', (msg) => {
                        const channelTopic = msg.text;

                        // Спрашиваем у пользователя тему поста с помощью инлайн-кнопок
                        const themeButtons = Object.keys(themes).map(theme => [
                            { text: truncateText(theme.charAt(0).toUpperCase() + theme.slice(1)), callback_data: `select_theme_${theme}` }
                        ]);

                        bot.sendMessage(chatId, 'Выберите тему бота:', {
                            reply_markup: {
                                inline_keyboard: themeButtons
                            }
                        });

                        bot.once('callback_query', (themeQuery) => {
                            const selectedTheme = themeQuery.data.split('_')[2]; // Извлекаем выбранную тему
                            const postTheme = themes[selectedTheme];

                            // Спрашиваем длину поста
                            bot.sendMessage(chatId, 'Какой длины должен быть пост?');

                            bot.once('message', (msg) => {
                                const postLength = msg.text;

                                // Запрашиваем у пользователя время публикации и проверяем формат
                                function askForTime() {
                                    bot.sendMessage(chatId, 'В какое время публиковать пост? Укажите в формате HH:mm (например, 14:00).');

                                    bot.once('message', (msg) => {
                                        const postTime = msg.text;

                                        if (isValidTime(postTime)) {
                                            // Сохраняем данные в базу данных
                                            db.run(`INSERT INTO user_channels (user_id, channel_id, channel_topic, topic, post_length, post_time)
                                                    VALUES (?, ?, ?, ?, ?, ?)`, [userId, channelId, channelTopic, postTheme, postLength, postTime], (err) => {
                                                if (err) {
                                                    console.error(err.message);
                                                    bot.sendMessage(chatId, 'Ошибка при сохранении данных.');
                                                    return;
                                                }

                                                bot.sendMessage(chatId, 'Канал успешно привязан и время публикации настроено!').then((successMessage) => {
                                                    setTimeout(() => {
                                                        bot.deleteMessage(chatId, successMessage.message_id).catch(console.error);
                                                    }, 5000);
                                                });
                                                schedulePost(userId, channelId, postTime);
                                            });
                                        } else {
                                            // Если формат времени неверный, запрашиваем снова
                                            bot.sendMessage(chatId, 'Ошибка: неверный формат времени. Укажите время в формате HH:mm (например, 14:00).');
                                            askForTime();
                                        }
                                    });
                                }

                                askForTime(); // Запрашиваем время публикации
                            });
                            });
                        });
                    });
                }});
            } else if (action === 'view_channels') {
                db.all('SELECT id, channel_id, channel_topic, topic, post_time FROM user_channels WHERE user_id = ?', [userId], (err, rows) => {
                    if (err) {
                        console.error(err.message);
                        bot.sendMessage(chatId, 'Ошибка базы данных');
                        return;
                    }
        
                    if (rows.length === 0) {
                        bot.sendMessage(chatId, 'У вас пока нет привязанных каналов.');
                    } else {
                        rows.forEach((row) => {
                            const opts = {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: 'Удалить', callback_data: `delete_channel_${row.id}` }],
                                        [{ text: 'Исправить', callback_data: `edit_channel_${row.id}` }]
                                    ]
                                }
                            };
        
                            bot.sendMessage(chatId, `Канал: ${row.channel_id}\nТема: ${row.channel_topic}\nТема бота: ${row.topic}\nВремя постинга: ${row.post_time}`, opts);
                        });
                    }
                })
            }if (action.startsWith('delete_channel_')) {
                const channelId = action.split('_')[2];
        
                db.run('DELETE FROM user_channels WHERE id = ? AND user_id = ?', [channelId, userId], (err) => {
                    if (err) {
                        console.error(err.message);
                        bot.sendMessage(chatId, 'Ошибка при удалении канала.');
                        return;
                    }
        
                    // Удаляем сообщение с информацией о канале
                    bot.deleteMessage(chatId, messageId)
                        .then(() => {
                            bot.sendMessage(chatId, 'Канал успешно удален.');
                        })
                        .catch((error) => {
                            console.error('Ошибка при удалении сообщения:', error);
                            bot.sendMessage(chatId, 'Ошибка при удалении сообщения.');
                        });
                });
            }
        
            // Обработка редактирования канала
            else if (action.startsWith('edit_channel_')) {
                const channelId = action.split('_')[2];
        
                bot.sendMessage(chatId, 'Что вы хотите изменить? Напишите новую тему.');
        
                bot.once('message', (msg) => {
                    const newTopic = msg.text;
        
                    db.run('UPDATE user_channels SET topic = ? WHERE id = ? AND user_id = ?', [newTopic, channelId, userId], (err) => {
                        if (err) {
                            console.error(err.message);
                            bot.sendMessage(chatId, 'Ошибка при обновлении канала.');
                            return;
                        }
        
                        bot.sendMessage(chatId, 'Тема канала успешно обновлена.');
                    });
                });
            }
    
    else if (data.startsWith('select_theme_')) {
        const theme = data.split('_')[2];
        const prompt = themes[theme];

        changeUserTheme(chatId, theme, prompt, (err) => {
            if (err) {
                console.error('Ошибка изменения темы пользователя:', err);
                bot.sendMessage(chatId, 'Произошла ошибка при изменении темы.');
                return;
            }

            bot.editMessageCaption(`Тема изменена на "${theme.charAt(0).toUpperCase() + theme.slice(1)}". Вы можете задавать вопросы на эту тему.`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard:[
                    [{text: 'Назад в меню', callback_data: 'start'}]
                    ]
                    
                }
            },
            );
        });

        awaitingThemeSelection.delete(chatId);
    } 
});

// Функция для обработки файлов и изображений
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;
    const filePath = path.join(__dirname, fileName);
    
    const fileStream = fs.createWriteStream(filePath);
    fileStream.on('finish', async () => {
        try {
            let extractedText = '';
            if (fileName.endsWith('.pdf')) {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                extractedText = pdfData.text;
            } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
                extractedText = extractTextFromExcel(filePath);
            } else if (fileName.endsWith('.docx')) {
                extractedText = await extractTextFromWord(filePath);
            } else {
                extractedText = await Tesseract.recognize(filePath, 'eng');
            }

            // Сохраняем данные в базу данных
            saveFileData(chatId, fileName, filePath, extractedText.data.text, (err, fileId) => {
                if (err) {
                    bot.sendMessage(chatId, 'Произошла ошибка при сохранении данных о файле.');
                    return;
                }

                bot.sendMessage(chatId, 'Файл успешно обработан и данные сохранены в базе.');
            });
        } catch (error) {
            console.error('Ошибка обработки файла:', error);
            bot.sendMessage(chatId, 'Произошла ошибка при обработке файла.');
        } finally {
            fs.unlinkSync(filePath); // Удаление временного файла после обработки
        }
    });

    fileStream.on('error', (error) => {
        console.error('Ошибка загрузки файла:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при загрузке файла.');
    });

    bot.downloadFile(fileId, __dirname).then(() => {
        fileStream.end();
    });
});

// // Обработка изображений и выполнение OCR
// bot.on('photo', async (msg) => {
//     const chatId = msg.chat.id;
// // Проверяем количество оставшихся запросов у пользователя
// try {
//     // Проверяем количество оставшихся запросов у пользователя
//     db.get(`SELECT requests FROM users WHERE telegram_id = ?`, [chatId], async (err, row) => {
//         if (err) {
//             console.error('Ошибка при проверке запросов пользователя:', err);
//             bot.sendMessage(chatId, 'Произошла ошибка при проверке вашего статуса. Попробуйте снова.');
//             return;
//         }

//         if (row && row.requests > 0) {
//             // Если запросы есть, обрабатываем вопрос

//     try {

//         // Уменьшаем количество оставшихся запросов в транзакции
//         db.serialize(() => {
//             db.run('BEGIN TRANSACTION');

//             db.run(`UPDATE users SET requests = requests - 1 WHERE telegram_id = ?`, [chatId], (err) => {
//                 if (err) {
//                     console.error('Ошибка при обновлении количества запросов:', err);
//                     db.run('ROLLBACK');
//                     bot.sendMessage(chatId, 'Произошла ошибка при обновлении вашего статуса.');
//                     return;
//                 }
                
//             const fileId = msg.photo[msg.photo.length - 1].file_id; // Берем изображение с наибольшим разрешением
//             const filePath = path.join(__dirname, `${fileId}.jpg`);

//             const fileStream = fs.createWriteStream(filePath);
//             fileStream.on('finish', async () => {
//         try {
//             // Выполнение OCR для извлечения текста с изображения
//             const result = await Tesseract.recognize(filePath, 'eng');
//             const extractedText = result.data.text;

//             // Сохраняем данные в базу данных
//             saveFileData(chatId, `${fileId}.jpg`, filePath, extractedText, (err, fileId) => {
//                 if (err) {
//                     bot.sendMessage(chatId, 'Произошла ошибка при сохранении данных о файле.');
//                     return;
//                 }

//                 bot.sendMessage(chatId, 'Текст с изображения успешно извлечён и сохранён в базе.');
//             });
//         } catch (error) {
//             console.error('Ошибка обработки изображения:', error);
//             bot.sendMessage(chatId, 'Произошла ошибка при обработке изображения.');
//         } finally {
//             fs.unlinkSync(filePath); // Удаление временного файла после обработки
//         }
//     });

//     fileStream.on('error', (error) => {
//         console.error('Ошибка загрузки изображения:', error);
//         bot.sendMessage(chatId, 'Произошла ошибка при загрузке изображения.');
//     });

//     bot.downloadFile(fileId, __dirname).then(() => {
//         fileStream.end();
//     });
//             });
            
                
//             // Сохраняем вопрос пользователя
            
//         });
//     } catch (error) {
//         console.error('Ошибка при запросе к OpenAI:', error);
//         // bot.sendMessage(chatId, 'Произошла ошибка при получении ответа от AI.');
//     }
            
//     } else {
//         // Если запросов нет, предлагаем докупить подписку
//         bot.sendMessage(chatId, 'У вас закончились запросы. Вы можете докупить подписку:', {
//             reply_markup: {
//                 inline_keyboard: [
//                     [{ text: '169 RUB базовый ⚡', url: paymentUrl169 }],
//                     [{ text: '319 RUB стандарт 🚀', url: paymentUrl319 }],
//                     [{ text: '599 RUB профи 👨‍💻', url: paymentUrl499 }],
//                     [{ text: '999 RUB премиум 🌟', url: paymentUrl999 }]
//                 ]
//             }
//         });
//     }
// });
// } catch (error) {

// console.error('Ошибка обработки сообщения:', error);
// // bot.sendMessage(chatId, 'Произошла ошибка при обработке вашего сообщения.');
// }})

// Функция для проверки количества запросов у пользователя
const checkOrAddUser = (telegramId, callback) => {
    db.get('SELECT requests FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
      if (err) {
        console.error('Ошибка чтения из БД:', err);
        return;
      }
      if (!row) {
        // Если пользователя нет в базе, добавляем его с 5 запросами
        db.run('INSERT INTO users (telegram_id, requests) VALUES (?, ?)', [telegramId, 5], function (err) {
          if (err) {
            console.error('Ошибка добавления пользователя в БД:', err);
          }
          callback(5);
        });
      } else {
        callback(row.requests);
      }
    });
  };
  
  // Функция для уменьшения количества запросов
  const decrementRequests = (telegramId, callback) => {
    db.run('UPDATE users SET requests = requests - 1 WHERE telegram_id = ?', [telegramId], function (err) {
      if (err) {
        console.error('Ошибка обновления запросов:', err);
      }
      callback();
    });
  };
  
  // Функция для распознавания текста с фотографии с помощью Tesseract.js
  const recognizeTextFromImage = async (filePath) => {
    try {
      const result = await Tesseract.recognize(filePath, 'eng', {
        logger: (m) => console.log(m), // Логирование процесса распознавания
      });
      return result.data.text;
    } catch (error) {
      console.error('Ошибка распознавания текста:', error);
      return null;
    }
  };
  
  // Функция для отправки текста на GPT API для дальнейшей обработки
  const sendTextToGPT = async (text) => {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: text }
            ]
        });
        return response.choices[0].message.content;
    } catch (error) {
      console.error('Ошибка при отправке текста на GPT:', error);
      return null;
    }
  };


// bot.on('message', async (msg) => {
//     const chatId = msg.chat.id;
//     const text = msg.text;

//     if (awaitingQuestion.has(chatId)) {
//         try {
//             db.get(`SELECT prompt FROM users WHERE telegram_id = ?`, [chatId], async (err, row) => {
//                 if (err) {
//                     console.error('Ошибка получения данных пользователя:', err);
//                     bot.sendMessage(chatId, 'Произошла ошибка при получении данных.');
//                     return;
//                 }

//                 const userPrompt = row ? row.prompt : 'Вы можете использовать этот бот для различных целей. Просто задайте вопрос.';
//                 const aiResponse = await analyzeText(userPrompt, text);

//                 incrementQueryCount(chatId, (err) => {
//                     if (err) {
//                         console.error('Ошибка увеличения счетчика запросов:', err);
//                     }
//                 });

//                 saveUserQuestion(chatId, text, (err) => {
//                     if (err) {
//                         console.error('Ошибка сохранения вопроса пользователя:', err);
//                     }
//                 });

//                 bot.sendMessage(chatId, aiResponse);
//             });
//         } catch (error) {
//             console.error('Ошибка при запросе к OpenAI:', error);
//             bot.sendMessage(chatId, 'Произошла ошибка при получении ответа от AI.');
//         } finally {
//             awaitingQuestion.delete(chatId);
//         }
//     } else if (awaitingPromoCode.has(chatId)) {
//         const price = awaitingPromoCode.get(chatId);

//         applyPromoCode(chatId, text, (err, success) => {
//             if (success) {
//                 const newPrice = Math.max(0, price - PROMOCODES[text].discount);
//                 bot.sendMessage(chatId, `Новая цена после применения промокода: ${newPrice} рублей. Вы хотите продолжить покупку?`, {
//                     reply_markup: {
//                         inline_keyboard: [
//                             [{ text: 'Купить', callback_data: `buy_${newPrice}` }]
//                         ]
//                     }
//                 });
//             } else {
//                 bot.sendMessage(chatId, 'Промокод недействителен. Попробуйте другой промокод или купите подписку без него.');
//             }
//             awaitingPromoCode.delete(chatId);
//         });
//     }
// });

// Обработка текстовых сообщений от пользователей
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (text == '/start') {
        console.log("Нажали старт")
    }else if (!botEnabled){
        return
    } else {
    const paymentUrl169 = await createPayment(16900, chatId, 'базовый ⚡', 100); // 169 рублей, 100 запросов
    const paymentUrl319 = await createPayment(31900, chatId, 'стандарт 🚀', 250); // 319 рублей, 250 запросов
    const paymentUrl499 = await createPayment(59900, chatId, 'профи 👨‍💻', 500); // 499 рублей, 500 запросов
    const paymentUrl999 = await createPayment(99900, chatId, 'премиум 🌟', 1000); // 999 рублей, 1000 запросов

    // Проверяем количество оставшихся запросов у пользователя
    try {
        // Проверяем количество оставшихся запросов у пользователя
        db.get(`SELECT requests FROM users WHERE telegram_id = ?`, [chatId], async (err, row) => {
            if (err) {
                console.error('Ошибка при проверке запросов пользователя:', err);
                bot.sendMessage(chatId, 'Произошла ошибка при проверке вашего статуса. Попробуйте снова.');
                return;
            }

            if (row && row.requests > 0) {
                // Если запросы есть, обрабатываем вопрос
                db.get(`SELECT prompt FROM users WHERE telegram_id = ?`, [chatId], async (err, userRow) => {
                    if (err) {
                        console.error('Ошибка получения данных пользователя:', err);
                        bot.sendMessage(chatId, 'Произошла ошибка при получении данных.');
                        return;
                    }

                    const userPrompt = userRow ? userRow.prompt : 'Вы можете использовать этот бот для различных целей. Просто задайте вопрос.';

                    try {
                        const aiResponse = await analyzeText(userPrompt, text);

                        // Уменьшаем количество оставшихся запросов в транзакции
                        db.serialize(() => {
                            db.run('BEGIN TRANSACTION');

                            db.run(`UPDATE users SET requests = requests - 1 WHERE telegram_id = ?`, [chatId], (err) => {
                                if (err) {
                                    console.error('Ошибка при обновлении количества запросов:', err);
                                    db.run('ROLLBACK');
                                    bot.sendMessage(chatId, 'Произошла ошибка при обновлении вашего статуса.');
                                    return;
                                }
                            });
                            incrementQueryCount(chatId, (err) => {
                                if (err) {
                                    console.error('Ошибка увеличения счетчика запросов:', err);
                                }
                            });
                                
                            // Сохраняем вопрос пользователя
                            saveUserQuestion(chatId, text, (err) => {
                                if (err) {
                                    console.error('Ошибка сохранения вопроса пользователя:', err);
                                    db.run('ROLLBACK');
                                    bot.sendMessage(chatId, 'Произошла ошибка при сохранении вашего вопроса.');
                                    return;
                                }

                                db.run('COMMIT');
                                bot.sendMessage(chatId, aiResponse);
                            });
                        });
                    } catch (error) {
                        console.error('Ошибка при запросе к OpenAI:', error);
                        // bot.sendMessage(chatId, 'Произошла ошибка при получении ответа от AI.');
                    }
                });
        } else {
            // Если запросов нет, предлагаем докупить подписку
            bot.sendMessage(chatId, 'У вас закончились запросы. Вы можете докупить подписку:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '169 RUB базовый ⚡', url: paymentUrl169 }],
                        [{ text: '319 RUB стандарт 🚀', url: paymentUrl319 }],
                        [{ text: '599 RUB профи 👨‍💻', url: paymentUrl499 }],
                        [{ text: '999 RUB премиум 🌟', url: paymentUrl999 }]
                    ]
                }
            });
        }
    });
} catch (error) {
    console.error('Ошибка обработки сообщения:', error);
    bot.sendMessage(chatId, 'Произошла ошибка при обработке вашего сообщения.');
}}
});

// Функция для проверки статуса платежа
function checkPaymentStatus(paymentId, chatId, plan, amount, requests) {

    axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
        auth: {
            username: shopId,
            password: secretKey
        }
    })
    .then(response => {
        const payment = response.data;

        if (payment.status === 'succeeded') {
            bot.sendMessage(chatId, `Вы успешно оплатили подписку: ${plan} с ${requests} запросами!`);
            const chatik = -1002478872141
            bot.sendMessage(chatik, `Какой то долбоеб купил подписку: ${plan}\n\nНа сумму ${amount/100} рублей`)
            // Проверка существования пользователя и сохранение подписки
            db.get(`SELECT * FROM users WHERE telegram_id = ?`, [chatId], (err, row) => {
                if (err) {
                    console.error('Ошибка при проверке пользователя в базе:', err);
                    bot.sendMessage(chatId, 'Произошла ошибка при проверке вашего статуса.');
                    return;
                }

                if (!row) {
                    // Если пользователя нет, добавляем его
                    db.run(`INSERT INTO users (telegram_id, plan, amount, start_date, end_date, requests) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [chatId, plan, amount, new Date().toISOString(), new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(), requests],
                        (err) => {
                            if (err) {
                                console.error('Ошибка при добавлении пользователя:', err.message);
                                bot.sendMessage(chatId, 'Произошла ошибка при добавлении пользователя.');
                            } else {
                                console.log(`Подписка ${plan} на сумму ${amount/100} рублей с ${requests} запросами сохранена для нового пользователя ${chatId}.`);
                            }
                        }
                    );
                } else {
                    // Если пользователь существует, обновляем данные о подписке
                    db.run(`UPDATE users SET plan = ?, amount = ?, start_date = ?, end_date = ?, requests = ? WHERE telegram_id = ?`,
                        [plan, amount, new Date().toISOString(), new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(), requests, chatId],
                        (err) => {
                            if (err) {
                                console.error('Ошибка при обновлении подписки:', err.message);
                                bot.sendMessage(chatId, 'Произошла ошибка при обновлении подписки.');
                            } else {
                                console.log(`Подписка ${plan} на сумму ${amount/100} рублей с ${requests} запросами обновлена для пользователя ${chatId}.`);
                            }
                        }
                    );
                }
            });

            delete payments[chatId]; // Удаляем информацию о платеже, так как он завершен
        } else if (payment.status === 'pending') {
            setTimeout(() => checkPaymentStatus(paymentId, chatId, plan, amount, requests), 30000);
        } else {
            console.log(`Платеж завершен с другим статусом: ${payment.status}`);
            bot.sendMessage(chatId, `Платеж завершен с другим статусом: ${payment.status}.`);
        }
    })
    .catch(error => {
        console.error('Ошибка при проверке статуса платежа:', error.response?.data || error.message);
        bot.sendMessage(chatId, 'Произошла ошибка при проверке статуса платежа.');
    });
}


// Периодическая проверка для удаления просроченных подписок
function removeExpiredSubscriptions() {
    const now = new Date().toISOString();
    db.run(`DELETE FROM users WHERE end_date < ?`, [now], (err) => {
        if (err) {
            console.error('Ошибка при удалении просроченных подписок:', err.message);
        } else {
            console.log('Проверка на просроченные подписки завершена.');
        }
    });
}

// Запускаем проверку просроченных подписок каждые 24 часа
setInterval(removeExpiredSubscriptions, 24 * 60 * 60 * 1000); // 24 час