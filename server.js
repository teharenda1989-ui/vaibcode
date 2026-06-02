require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
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
        filename: './database.sqlite',
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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            video_path TEXT,
            status TEXT DEFAULT 'pending',
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

app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await db.run(
            'INSERT INTO users (username, email, password, crystals) VALUES (?, ?, ?, 1)',
            [username, email, hashedPassword]
        );
        
        const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
        await db.run(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, 1, "bonus", "Бесплатная генерация при регистрации")',
            [user.id]
        );
        
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
        
        res.json({ 
            success: true, 
            token, 
            user: { id: user.id, username, email, crystals: 1 }
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
                subscription_end: user.subscription_end
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/user', authMiddleware, async (req, res) => {
    try {
        const user = await db.get(
            'SELECT id, username, email, crystals, subscription_active, subscription_end FROM users WHERE id = ?',
            [req.userId]
        );
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        res.json(user);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

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

app.post('/api/generate', authMiddleware, async (req, res) => {
    const { prompt } = req.body;
    
    if (!prompt || prompt.trim().length < 3) {
        return res.status(400).json({ error: 'Введите описание видео (минимум 3 символа)' });
    }
    
    try {
        const user = await db.get('SELECT crystals, subscription_active FROM users WHERE id = ?', [req.userId]);
        
        let cost = 5;
        let finalStatus = 'processing';
        
        if (user.subscription_active === 1) {
            cost = 0;
            finalStatus = 'processing';
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
        
        setTimeout(async () => {
            const videoId = uuidv4();
            const videoUrl = `/videos/${videoId}.mp4`;
            
            await db.run(
                'UPDATE generations SET status = ?, video_path = ? WHERE id = ?',
                ['completed', videoUrl, generationId]
            );
            
            console.log(`✅ Видео сгенерировано: ${generationId} - ${prompt}`);
        }, 5000 + Math.random() * 10000);
        
        res.json({
            success: true,
            generationId,
            status: 'processing',
            message: 'Генерация видео запущена! Обычно это занимает 10-20 секунд.',
            crystalsLeft: user.subscription_active === 1 ? user.crystals : user.crystals - cost
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

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
            message: 'Подписка оформлена! Теперь генерации бесплатны на месяц.',
            subscription_end: endDate.toISOString()
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/buy-crystals', authMiddleware, async (req, res) => {
    const { amount } = req.body;
    
    const packages = {
        5: 100,
        20: 350,
        50: 790,
        100: 1490
    };
    
    if (!packages[amount]) {
        return res.status(400).json({ error: 'Неверное количество кристаллов' });
    }
    
    try {
        await db.run('UPDATE users SET crystals = crystals + ? WHERE id = ?', [amount, req.userId]);
        await db.run(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, "purchase", ?)',
            [req.userId, amount, `Покупка ${amount} кристаллов за ${packages[amount]}₽`]
        );
        
        const user = await db.get('SELECT crystals FROM users WHERE id = ?', [req.userId]);
        
        res.json({ 
            success: true, 
            crystals: user.crystals,
            message: `${amount} кристаллов добавлено на ваш счёт!`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

async function start() {
    await initDB();
    app.listen(PORT, () => {
        console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    });
}

start();