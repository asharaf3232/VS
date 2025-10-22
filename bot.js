// ============================================================================
// صياد الدرر: v9.3.1 Lite Debug (Birdeye Edition) - مراقبة فقط
// 🔹 يستخدم Birdeye API كمصدر نشط وسريع
// 🔹 يرسل تنبيهات لأي عملة جديدة تمر الفلتر
// 🔹 لا ينفذ أي شراء (REAL_MODE=false)
// ============================================================================

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import axios from 'axios';

dotenv.config();

// إعدادات عامة
const config = {
  PROTECTED_RPC_URL: process.env.PROTECTED_RPC_URL,
  WALLET_ADDRESS: process.env.WALLET_ADDRESS,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
  REAL_MODE: false, // 🚫 مراقبة فقط
  DEBUG_MODE: true,
  MIN_LIQUIDITY_USD: 1000, // حد أدنى للسيولة
  MIN_VOLUME_5M: 500, // حد أدنى لحجم التداول خلال 5 دقائق
  MAX_TOKEN_AGE_MIN: 45, // عمر التوكن بالحد الأقصى (دقائق)
  IS_PAUSED: false,
};

// تسجيل السجلات
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'sniper_bot_lite_birdeye.log' }),
    new winston.transports.Console(),
  ],
});

// تليجرام
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// دالة مساعدة
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function sendTelegram(title, body) {
  try {
    const msg = `🦅 <b>${title}</b>\n\n${body}`;
    await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
  } catch (e) {
    logger.warn(`[Telegram] فشل الإرسال: ${e.message}`);
  }
}

// جلب البيانات من Birdeye
async function fetchBirdeyeTokens(limit = 50) {
  const url = `https://public-api.birdeye.so/public/tokenlist?chain=bsc&limit=${limit}`;
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'x-chain': 'bsc' } });
    return res.data?.data?.tokens || [];
  } catch (err) {
    logger.error(`[Birdeye] خطأ في الجلب: ${err.message}`);
    return [];
  }
}

// فحص أولي للتوكن
function filterToken(token) {
  const symbol = token.symbol || 'N/A';
  const address = token.address?.toLowerCase() || 'N/A';
  const liquidityUsd = parseFloat(token.liquidity || 0);
  const volume5m = parseFloat(token.volume_5m_usd || 0);
  const ageMin = (Date.now() - (token.creationTime * 1000 || Date.now())) / 60000;

  if (ageMin > config.MAX_TOKEN_AGE_MIN) return { passed: false, reason: `عمر ${ageMin.toFixed(1)} دقيقة > ${config.MAX_TOKEN_AGE_MIN}` };
  if (liquidityUsd < config.MIN_LIQUIDITY_USD) return { passed: false, reason: `سيولة منخفضة (${liquidityUsd}$)` };
  if (volume5m < config.MIN_VOLUME_5M) return { passed: false, reason: `حجم تداول ضعيف (${volume5m}$)` };

  return { passed: true, info: { symbol, address, liquidityUsd, volume5m, ageMin } };
}

// المعالجة الرئيسية
let processed = new Set();

async function processToken(token) {
  const check = filterToken(token);
  const symbol = token.symbol || 'N/A';
  const address = token.address || 'N/A';

  if (check.passed) {
    const info = check.info;
    logger.info(`[✅] ${info.symbol} (${info.address}) اجتاز الفلتر.`);
    await sendTelegram(
      `عملة جديدة تحت المراقبة ✅`,
      `رمز: <b>${info.symbol}</b>\nالعنوان: <code>${info.address}</code>\nالسيولة: ${info.liquidityUsd.toFixed(0)}$\nحجم (5د): ${info.volume5m.toFixed(0)}$\nالعمر: ${info.ageMin.toFixed(1)} دقيقة`
    );
  } else {
    logger.info(`[❌] ${symbol} (${address}) تم تجاهله: ${check.reason}`);
  }
}

// الحلقة الرئيسية
async function pollLoop() {
  logger.info('🚀 بدء نسخة Lite Debug (Birdeye Edition) - مراقبة فقط.');
  await sendTelegram('تم تشغيل البوت', 'النسخة: v9.3.1 Lite Debug (Birdeye Edition)\nالوضع: مراقبة فقط (لا يوجد شراء).');

  while (true) {
    try {
      if (config.IS_PAUSED) {
        logger.info('[⏸️] البوت موقوف مؤقتاً.');
        await sleep(60000);
        continue;
      }

      const tokens = await fetchBirdeyeTokens(50);
      if (!tokens.length) {
        logger.warn('[Birdeye] لم يتم العثور على توكنات جديدة.');
        await sleep(60000);
        continue;
      }

      for (const token of tokens) {
        if (!token.address || processed.has(token.address)) continue;
        processed.add(token.address);
        await processToken(token);
        await sleep(500); // تقليل الضغط
      }

      logger.info(`[دورة مكتملة ✅] تمت معالجة ${tokens.length} توكن.`);
    } catch (err) {
      logger.error(`[Loop] ${err.message}`);
    }

    await sleep(90000); // كل دقيقة ونصف
  }
}

// أوامر بسيطة في تليجرام
telegram.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== (config.TELEGRAM_ADMIN_CHAT_ID || '').toString()) return;
  const text = (msg.text || '').trim().toLowerCase();

  if (text === '/status') {
    const m = `<b>📊 الحالة الحالية:</b>\nالوضع: مراقبة فقط\nREAL_MODE: ${config.REAL_MODE}\nالسيولة الأدنى: ${config.MIN_LIQUIDITY_USD}$\nالحجم الأدنى: ${config.MIN_VOLUME_5M}$ (5د)\n`;
    telegram.sendMessage(chatId, m, { parse_mode: 'HTML' });
  } else if (text === '/pause') {
    config.IS_PAUSED = true;
    telegram.sendMessage(chatId, '⏸️ تم إيقاف البوت مؤقتًا.');
  } else if (text === '/resume') {
    config.IS_PAUSED = false;
    telegram.sendMessage(chatId, '▶️ تم استئناف البوت.');
  }
});

pollLoop();