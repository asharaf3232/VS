// =================================================================
// صياد الدرر: v9.3 Lite Debug (مراقبة فقط) - الصقر الحكيم (Light)
// - يستخدم DexGuru كمصدر أسرع
// - فلاتر أخف و verbose debug
// - REAL_MODE=false => لا ينفذ شراء أبداً (يبلغ فقط)
// =================================================================

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import fs from 'fs';
import axios from 'axios';

dotenv.config();

// ---------- CONFIG ----------
const config = {
    // اجعل ملف .env الحالي كاف لإعداد المتغيرات (PROTECTED_RPC_URL, PRIVATE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID,...)
    PROTECTED_RPC_URL: process.env.PROTECTED_RPC_URL,
    NODE_URL: process.env.NODE_URL,
    GOPLUS_API_KEY: process.env.GOPLUS_API_KEY,
    WALLET_ADDRESS: process.env.WALLET_ADDRESS,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
    ROUTER_ADDRESS: process.env.ROUTER_ADDRESS || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    FACTORY_ADDRESS: process.env.FACTORY_ADDRESS || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    WBNB_ADDRESS: process.env.WBNB_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    // فلاتر مخففة للمراقبة
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '60.0'),
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '50.0'),
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '10.0'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '1.5'),
    MAX_TOKEN_AGE_MIN: parseInt(process.env.MAX_TOKEN_AGE_MIN || '30', 10), // بالـ دقائق
    MIN_BUYS_FOR_ALERT: parseInt(process.env.MIN_BUYS_FOR_ALERT || '2', 10),
    DEBUG_MODE: true,
    REAL_MODE: process.env.REAL_MODE === 'true' ? true : false, // مهم: افتراضي false — لا يشتري
    IS_PAUSED: false
};

// ---------- LOGGER ----------
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'sniper_bot_lite_debug.log' }),
        new winston.transports.Console()
    ]
});

// ---------- TELEGRAM ----------
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// ---------- ETHERS ----------
let provider;
try {
    provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL || config.NODE_URL);
} catch (e) {
    logger.warn('[INIT] لم يتم تهيئة مزوّد RPC بشكل صحيح: ' + e.message);
}

// ---------- HELPER ----------
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function sendTelegramDebug(title, body) {
    try {
        const msg = `🔎 <b>${title}</b>\n\n${body}`;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
    } catch (e) {
        logger.warn('[TG] فشل إرسال رسالة تليجرام: ' + e.message);
    }
}

// ---------- DATA SOURCE: DexGuru ----------
async function fetchLatestTokensFromDexGuru(limit = 50) {
    try {
        // DexGuru endpoint (غير موثوق به 100% لكل البيانات لكل منطقة؛ لكن أسرع من بعض البدائل)
        const url = `https://api.dex.guru/v1/tokens?chain=bsc&sort=listed_at:desc&limit=${limit}`;
        const res = await axios.get(url, { timeout: 10000 });
        // هنا نتوقع مصفوفة كائنات؛ كل كائن يحتوي على token.address, token.symbol, liquidity, listed_at, txCounts...
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
        logger.error('[Source] خطأ في جلب البيانات من DexGuru: ' + (e.message || e));
        return [];
    }
}

// ---------- LIGHTWEIGHT SECURITY CHECK (مبسّط) ----------
async function quickTokenCheck(candidate) {
    // candidate: object returned by DexGuru (قد يختلف الحقل حسب الإصدار) — افتراضات بسيطة
    try {
        // احصل على أساسيات (حاول قراءة بتسامح لعدم توقف البوت)
        const address = (candidate.address || candidate.contractAddress || candidate.token?.address || '').toLowerCase();
        const symbol = candidate.symbol || candidate.token?.symbol || 'N/A';
        const listedAt = candidate.listed_at || candidate.token?.listed_at || null;
        const liquidityUsd = candidate.liquidity?.usd || candidate.liquidity_usd || candidate.liquidity || 0;
        const buys = candidate.txCounts?.buys_5m || candidate.tx_counts?.buys || candidate.buyCount || 0;

        // العمر
        const ageMin = listedAt ? (Math.abs(Date.now() - new Date(listedAt).getTime()) / 60000) : 99999;

        // فلترة مبسطة
        if (ageMin > config.MAX_TOKEN_AGE_MIN) {
            return { passed: false, reason: `عمر التوكن ${ageMin.toFixed(1)} دقيقة > ${config.MAX_TOKEN_AGE_MIN} دقيقة` };
        }

        // تحويل السيولة BNB -> USD إن لزم (لو المعطى BNB، نفترض سعر تقريبي أو نقبل القيمة كما هي)
        // لاحقًا يمكن تحسين قراءة السيولة من الداتا
        if (liquidityUsd < (config.MINIMUM_LIQUIDITY_BNB * 300)) { // تقريب سعر BNB ~ 300$
            // إذا كانت القيمة صغيرة جداً، لكن لا نريد إقصاء كل شيء — فقط نبلغ
            return { passed: false, reason: `السيولة منخفضة (${liquidityUsd} USD)` };
        }

        if (buys < config.MIN_BUYS_FOR_ALERT) {
            return { passed: false, reason: `نشاط ضعيف: ${buys} عمليات شراء (<${config.MIN_BUYS_FOR_ALERT})` };
        }

        // GoPlus check اختياري — إذا كان مفتاح API موجود نعمل طلب، وإلا نتخطاه
        if (config.GOPLUS_API_KEY) {
            // نرسل طلب مبسّط إلى GoPlus (غير معتمد على حقل معين)
            try {
                const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${address}`;
                const res = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY }, timeout: 8000 });
                const r = res.data?.result?.[address];
                if (r) {
                    if (r.is_honeypot === '1') return { passed: false, reason: 'GoPlus: احتمال Honeypot' };
                    // يمكن إضافة شروط أخرى لو أردت
                }
            } catch (e) {
                logger.warn('[GoPlus] خطأ أو حد استدعاءات — تم التجاوز (غير حرج).');
            }
        }

        // فحص بسيط على الحقول التي تشير لتركيز الحيتان أو المطور إن كانت متاحة
        // (نستخدم قيم افتراضية متحفظة لأن DexGuru لا يعطي كل شيء دائماً)
        const topHoldersPercent = candidate.holdersTop10Percent || candidate.top_holders_percent || 0;
        const creatorPercent = candidate.creator_percent || candidate.owner_percent || 0;

        if (topHoldersPercent > config.MAX_TOP_HOLDERS_PERCENT) {
            return { passed: false, reason: `تركيز حيتان عالي (${topHoldersPercent}%)` };
        }
        if (creatorPercent > config.MAX_CREATOR_PERCENT) {
            return { passed: false, reason: `نسبة المطور عالي (${creatorPercent}%)` };
        }

        return { passed: true, info: { address, symbol, ageMin, liquidityUsd, buys } };
    } catch (e) {
        return { passed: false, reason: 'خطأ أثناء quickTokenCheck: ' + e.message };
    }
}

// ---------- PROCESS TARGET ----------
async function processCandidate(candidate) {
    try {
        const basic = {
            address: candidate.address || candidate.contractAddress || candidate.token?.address || 'N/A',
            symbol: candidate.symbol || candidate.token?.symbol || 'N/A',
            listed_at: candidate.listed_at || candidate.token?.listed_at || null
        };

        const check = await quickTokenCheck(candidate);

        if (check.passed) {
            const info = check.info;
            const body = `رمز: <b>${info.symbol}</b>\nالعنوان: <code>${info.address}</code>\nالعمر: ${info.ageMin.toFixed(1)} دقيقة\nالسيولة تقريباً: ${info.liquidityUsd} USD\nالشراءات الأولية: ${info.buys}\n\n🔵 النتيجة: اجتاز الفلاتر (DEBUG)` ;
            logger.info(`[ALERT] هدف مُرَصَد: ${info.symbol} | ${info.address}`);
            await sendTelegramDebug('تم رصد عملة جديدة (DEBUG)', body);

            // هنا: لا ننفذ الشراء لأن النسخة debug. لو أردت شراء حقيقي، وضع REAL_MODE يجب أن يكون true
            if (config.REAL_MODE) {
                logger.info('[REAL_MODE] مفعل — سيتم محاولة الشراء (لكن أنت اخترت مراقبة فقط).');
                // هنا ننادي snipeToken أو منطق الشراء — لم يتم إضافته في هذه النسخة لأمانك.
            } else {
                logger.info('[REAL_MODE] غير مفعل — لا يتم تنفيذ أي معاملة. رسالة فقط.');
            }
        } else {
            const reason = check.reason || 'مرفوض دون سبب محدد';
            logger.info(`[FILTERED] ${basic.symbol} (${basic.address.slice(0,10)}) => ${reason}`);
            if (config.DEBUG_MODE) {
                await sendTelegramDebug('تم تجاهل عملة (DEBUG)', `رمز: <b>${basic.symbol}</b>\nالعنوان: <code>${basic.address}</code>\nالسبب: ${reason}`);
            }
        }
    } catch (e) {
        logger.error('[processCandidate] ' + e.message);
    }
}

// ---------- POLLING LOOP ----------
let lastSeen = new Set();

async function pollLoop() {
    logger.info('🚀 بدء نسخة Lite Debug (مراقبة فقط).');
    await sendTelegramDebug('بوت Lite Debug بدأ', 'البوت الآن في وضع المراقبة فقط. لن يقوم بعمليات شراء.');

    while (true) {
        try {
            if (config.IS_PAUSED) {
                logger.info('[Lite] البوت موقوف مؤقتاً. تخطي دورة الفحص.');
                await sleep(60 * 1000);
                continue;
            }

            const tokens = await fetchLatestTokensFromDexGuru(50);

            if (!tokens || tokens.length === 0) {
                logger.info('[Source] لا توجد بيانات جديدة من مصدر DexGuru هذه الدورة.');
                await sleep(60 * 1000);
                continue;
            }

            for (const t of tokens) {
                const address = (t.address || t.contractAddress || t.token?.address || '').toLowerCase();
                if (!address) continue;

                // تقييد التكرار: إذا تمت معالجته مؤخرًا نتجاوزه
                if (lastSeen.has(address)) continue;

                // أضفه لمجموعة lastSeen (سيتم تنظيفها بمرور الوقت)
                lastSeen.add(address);

                // تشغيل المعالجة
                await processCandidate(t);

                // عدم الضغط على الـ API
                await sleep(500);
            }

            // تنظيف lastSeen كل ساعة للحفاظ على معالجة التوكنات المتكررة بعد فترة
            setTimeout(() => {
                lastSeen.clear();
                logger.info('[Housekeeping] تم تفريغ قائمة العناوين المعالجة (lastSeen).');
            }, 60 * 60 * 1000);

        } catch (e) {
            logger.error('[pollLoop] ' + (e.message || e));
        }

        // انتظار قصير قبل الدورة التالية: نظرًا لأن DexGuru يتحدث بسرعة، نستخدم 45-90 ثانية بين دورات
        await sleep(75 * 1000);
    }
}

// ---------- TELEGRAM COMMANDS بسيطة ----------
telegram.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    if (chatId !== (config.TELEGRAM_ADMIN_CHAT_ID || '').toString()) return;

    const text = (msg.text || '').trim().toLowerCase();

    if (text === '/status' || text === 'الحالة' || text === '📊 الحالة') {
        const networkStatus = provider ? 'RPC متصل' : 'RPC غير متصل';
        const m = `<b>حالة Lite Debug</b>\n- ${networkStatus}\n- REAL_MODE: ${config.REAL_MODE}\n- DEBUG_MODE: ${config.DEBUG_MODE}\n- فلترة: عمر <= ${config.MAX_TOKEN_AGE_MIN} دقيقة, سيولة >= ${config.MINIMUM_LIQUIDITY_BNB} BNB (تقريبياً)\n`;
        telegram.sendMessage(chatId, m, { parse_mode: 'HTML' });
    } else if (text === '/pause') {
        config.IS_PAUSED = true;
        telegram.sendMessage(chatId, '⏸️ تم إيقاف عملية الصيد مؤقتًا.');
    } else if (text === '/resume') {
        config.IS_PAUSED = false;
        telegram.sendMessage(chatId, '▶️ تم استئناف عملية الصيد.');
    } else if (text === '/help') {
        telegram.sendMessage(chatId, 'أوامر: /status, /pause, /resume, /help');
    }
});

// ---------- START ----------
pollLoop().catch(e => {
    logger.error('فشل في بدء حلقة Poll: ' + (e.message || e));
});