require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let db;

async function initDB() {
    db = await open({
        filename: '/tmp/database.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            crystals INTEGER DEFAULT 1,
            subscription_end TEXT,
            subscription_active INTEGER DEFAULT 0,
            referral_code TEXT UNIQUE,
            invited_by INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (invited_by) REFERENCES users (id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            video_url TEXT,
            status TEXT DEFAULT 'processing',
            crystals_spent INTEGER DEFAULT 5,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS referrals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referrer_id INTEGER NOT NULL,
            referred_id INTEGER NOT NULL,
            crystals_awarded INTEGER DEFAULT 15,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (referrer_id) REFERENCES users (id),
            FOREIGN KEY (referred_id) REFERENCES users (id)
        )
    `);

    console.log('✅ База данных инициализирована');
}

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Неверный токен' });
    }
}

function generateReferralCode() {
    return 'REF' + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Функция для генерации JWT токена для Kling API
function generateKlingToken(accessKey, secretKey) {
    const payload = {
        iss: accessKey,
        exp: Math.floor(Date.now() / 1000) + 1800,
        nbf: Math.floor(Date.now() / 1000) - 5
    };
    return jwt.sign(payload, secretKey, { algorithm: 'HS256' });
}

// ============= РЕГИСТРАЦИЯ =============
app.post('/api/register', async (req, res) => {
    const { username, email, password, referralCode } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newReferralCode = generateReferralCode();
        
        let invitedBy = null;
        if (referralCode) {
            const referrer = await db.get('SELECT id FROM users WHERE referral_code = ?', [referralCode]);
            if (referrer) {
                invitedBy = referrer.id;
            }
        }
        
        await db.run(
            'INSERT INTO users (username, email, password, crystals, referral_code, invited_by) VALUES (?, ?, ?, 1, ?, ?)',
            [username, email, hashedPassword, newReferralCode, invitedBy]
        );
        
        const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
        
        if (invitedBy) {
            await db.run('UPDATE users SET crystals = crystals + 15 WHERE id = ?', [invitedBy]);
            await db.run(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, 15, "referral", "Начисление за приглашение")',
                [invitedBy]
            );
            await db.run(
                'INSERT INTO referrals (referrer_id, referred_id, crystals_awarded) VALUES (?, ?, 15)',
                [invitedBy, user.id]
            );
        }
        
        await db.run(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, 1, "bonus", "Бесплатная генерация при регистрации")',
            [user.id]
        );
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                username, 
                email, 
                crystals: invitedBy ? 16 : 1,
                referral_code: newReferralCode
            }
        });
    } catch (error) {
        if (error.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Пользователь с таким email или именем уже существует' });
        } else {
            console.error(error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    }
});

// ============= ЛОГИН =============
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
        
        if (!user) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                crystals: user.crystals,
                subscription_active: user.subscription_active,
                subscription_end: user.subscription_end,
                referral_code: user.referral_code
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user', authMiddleware, async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, username, email, crystals, subscription_active, subscription_end, referral_code FROM users WHERE id = ?',
            [req.userId]
        );
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const referrals = await db.get(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?',
            [req.userId]
        );
        
        res.json({ ...user, invited_count: referrals?.count || 0 });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ИСТОРИЯ =============
app.get('/api/generations', authMiddleware, async (req, res) => {
    try {
        const generations = await db.all(
            'SELECT * FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
            [req.userId]
        );
        res.json(generations);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ГЕНЕРАЦИЯ ВИДЕО =============
app.post('/api/generate', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    
    console.log(`📥 Запрос на генерацию: ${prompt}`);
    
    if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Введите описание видео (минимум 3 символа)' });
    }
    
    try {
        const user = await db.get('SELECT crystals, subscription_active FROM users WHERE id = ?', [req.userId]);
        
        let cost = 5;
        
        if (user.subscription_active === 1) {
            cost = 0;
        } else if (user.crystals >= cost) {
            await db.run('UPDATE users SET crystals = crystals - ? WHERE id = ?', [cost, req.userId]);
            await db.run(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, -?, "generation", ?)',
                [req.userId, cost, `Генерация видео: ${prompt.substring(0, 50)}`]
            );
        } else {
            return res.status(402).json({ 
                error: 'Недостаточно кристаллов', 
                needCrystals: cost,
                currentCrystals: user.crystals,
                showSubscriptionPopup: true 
            });
        }
        
        const result = await db.run(
            'INSERT INTO generations (user_id, prompt, status, crystals_spent) VALUES (?, ?, ?, ?)',
            [req.userId, prompt, 'processing', cost]
        );
        
        const generationId = result.lastID;
        
        res.json({
            success: true,
            generationId,
            status: 'processing',
            message: 'Генерация видео запущена! Обычно это занимает 1-3 минуты.',
            crystalsLeft: user.subscription_active === 1 ? user.crystals : user.crystals - cost
        });
        
        // ============= РЕАЛЬНАЯ ГЕНЕРАЦИЯ =============
        (async () => {
            try {
                console.log(`🔑 Проверка API ключей...`);
                const accessKey = process.env.KLING_ACCESS_KEY;
                const secretKey = process.env.KLING_SECRET_KEY;
                
                console.log(`Access Key: ${accessKey ? '✅ Найден' : '❌ ОТСУТСТВУЕТ'}`);
                console.log(`Secret Key: ${secretKey ? '✅ Найден' : '❌ ОТСУТСТВУЕТ'}`);
                
                // Если нет ключей — используем имитацию
                if (!accessKey || !secretKey) {
                    console.log(`⚠️ Ключи не найдены, использую демо-режим`);
                    await new Promise(resolve => setTimeout(resolve, 8000));
                    const mockUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
                    await db.run(
                        'UPDATE generations SET status = ?, video_url = ? WHERE id = ?',
                        ['completed', mockUrl, generationId]
                    );
                    console.log(`✅ ДЕМО-видео готово`);
                    return;
                }
                
                const token = generateKlingToken(accessKey, secretKey);
                console.log(`🔐 JWT токен сгенерирован`);
                
                console.log(`🎬 Отправка запроса в Kling API...`);
                console.log(`Промпт: ${prompt}`);
                
                const createResponse = await fetch('https://api.klingai.com/v1/videos/text2video', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model_name: 'kling-v1-6',
                        prompt: prompt,
                        duration: '5',
                        mode: 'std',
                        aspect_ratio: '16:9'
                    })
                });
                
                const createData = await createResponse.json();
                console.log(`📡 Ответ Kling API (создание):`, JSON.stringify(createData, null, 2));
                
                if (createData.code !== 0) {
                    throw new Error(`Kling API ошибка: ${createData.message} (код: ${createData.code})`);
                }
                
                const taskId = createData.data.task_id;
                console.log(`✅ Задача создана, ID: ${taskId}`);
                
                let videoUrl = null;
                let attempts = 0;
                const maxAttempts = 36;
                
                while (attempts < maxAttempts && !videoUrl) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    attempts++;
                    
                    console.log(`⏳ Проверка статуса... попытка ${attempts}/${maxAttempts}`);
                    
                    const statusResponse = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    
                    const statusData = await statusResponse.json();
                    
                    if (statusData.code === 0) {
                        const taskStatus = statusData.data.task_status;
                        console.log(`📊 Статус: ${taskStatus}`);
                        
                        if (taskStatus === 'succeeded') {
                            videoUrl = statusData.data.videos[0].url;
                            console.log(`✅ Видео готово: ${videoUrl}`);
                            break;
                        } else if (taskStatus === 'failed') {
                            throw new Error(`Генерация не удалась`);
                        }
                    }
                }
                
                if (!videoUrl) {
                    throw new Error('Превышено время ожидания');
                }
                
                await db.run(
                    'UPDATE generations SET status = ?, video_url = ? WHERE id = ?',
                    ['completed', videoUrl, generationId]
                );
                
                console.log(`🎉 Генерация завершена успешно!`);
                
            } catch (error) {
                console.error(`❌ ОШИБКА:`, error.message);
                await db.run(
                    'UPDATE generations SET status = ? WHERE id = ?',
                    ['failed', generationId]
                );
            }
        })();
        
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= СТАТУС ГЕНЕРАЦИИ =============
app.get('/api/generation/:id', authMiddleware, async (req, res) => {
    try {
        const generation = await db.get(
            'SELECT * FROM generations WHERE id = ? AND user_id = ?',
            [req.params.id, req.userId]
        );
        
        if (!generation) {
            return res.status(404).json({ error: 'Генерация не найдена' });
        }
        
        res.json(generation);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ПОДПИСКА =============
app.post('/api/subscribe', authMiddleware, async (req, res) => {
    try {
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);
        
        await db.run(
            'UPDATE users SET subscription_active = 1, subscription_end = ? WHERE id = ?',
            [endDate.toISOString(), req.userId]
        );
        
        await db.run(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, 0, "subscription", "Подписка на месяц 990₽")',
            [req.userId]
        );
        
        await db.run('UPDATE users SET crystals = crystals + 100 WHERE id = ?', [req.userId]);
        
        res.json({ 
            success: true, 
            message: 'Подписка оформлена!',
            subscription_end: endDate.toISOString()
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ПОКУПКА КРИСТАЛЛОВ =============
app.post('/api/buy-crystals', authMiddleware, async (req, res) => {
    const { amount } = req.body;
    
    const packages = { 5: 100, 20: 350, 50: 790, 100: 1490 };
    
    if (!packages[amount]) {
        return res.status(400).json({ error: 'Неверное количество' });
    }
    
    try {
        await db.run('UPDATE users SET crystals = crystals + ? WHERE id = ?', [amount, req.userId]);
        await db.run(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, "purchase", ?)',
            [req.userId, amount, `Покупка ${amount} кристаллов за ${packages[amount]}₽`]
        );
        
        const user = await db.get('SELECT crystals FROM users WHERE id = ?', [req.userId]);
        
        res.json({ success: true, crystals: user.crystals });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ============= ЗАПУСК =============
async function start() {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Сервер запущен на порту ${PORT}`);
    });
}

start();
