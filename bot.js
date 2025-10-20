// =================================================================
// صياد الدرر: v2.2 (النسخة النهائية الكاملة - BloXroute)
// الميزات: حماية من الساندويتش، فحص أمني، وقف خسارة متحرك، بيع يدوي، رابط شارت
// =================================================================
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import fs from 'fs';
import axios from 'axios';

// --- نظام التسجيل ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'sniper_bot_pro.log' }),
        new winston.transports.Console()
    ]
});

// --- تحميل الإعدادات ---
dotenv.config();
const config = {
    PROTECTED_RPC_URL: process.env.PROTECTED_RPC_URL,
    NODE_URL: process.env.NODE_URL,
    GOPLUS_API_KEY: process.env.GOPLUS_API_KEY,
    WALLET_ADDRESS: process.env.WALLET_ADDRESS,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
    ROUTER_ADDRESS: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    FACTORY_ADDRESS: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    WBNB_ADDRESS: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    BUY_AMOUNT_BNB: parseFloat(process.env.BUY_AMOUNT_BNB || '0.01'),
    GAS_PRICE_TIP_GWEI: BigInt(process.env.GAS_PRICE_TIP_GWEI || '1'),
    SLIPPAGE_LIMIT: parseInt(process.env.SLIPPAGE_LIMIT || '49', 10),
    GAS_LIMIT: BigInt(process.env.GAS_LIMIT || '800000'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'),
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '20', 10),
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
};

// --- واجهات العقود الذكية (ABIs) ---
const FACTORY_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'];
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- تهيئة المتغيرات الرئيسية ---
let provider, wallet, factoryContract, routerContract;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};

// =================================================================
// 1. المدقق (Verifier)
// =================================================================
async function checkTokenSecurity(tokenAddress) {
    if (!config.GOPLUS_API_KEY) {
        logger.warn("[فحص أمني] مفتاح Go+ API غير موجود، تم تخطي الفحص.");
        return { is_safe: true, reason: "فحص أمني معطل" };
    }
    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY } });
        const result = response.data.result[tokenAddress.toLowerCase()];
        if (!result) return { is_safe: false, reason: "لم يتم العثور على العملة في Go+" };
        if (result.is_honeypot === '1') return { is_safe: false, reason: "فخ عسل حسب Go+" };
        if (parseFloat(result.sell_tax) > 0.15) return { is_safe: false, reason: `ضريبة بيع مرتفعة (${(parseFloat(result.sell_tax) * 100).toFixed(0)}%)` };
        if (result.cannot_sell_all === '1') return { is_safe: false, reason: "لا يمكن بيع كل الكمية" };
        logger.info(`[فحص أمني] ✅ العملة تبدو آمنة حسب Go+.`);
        return { is_safe: true };
    } catch (error) {
        logger.error(`[فحص أمني] 🚨 خطأ في التواصل مع Go+ API: ${error.message}`);
        return { is_safe: false, reason: "خطأ في API الفحص الأمني" };
    }
}

async function fullCheck(pairAddress, tokenAddress) {
    try {
        logger.info(`[فحص] بدء الفحص الشامل لـ ${tokenAddress}`);
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));
        logger.info(`[فحص] السيولة المكتشفة: ${wbnbLiquidity.toFixed(2)} BNB`);
        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) {
            return { passed: false, reason: `سيولة غير كافية (${wbnbLiquidity.toFixed(2)} BNB)` };
        }
        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) {
            return { passed: false, reason: securityResult.reason };
        }
        await routerContract.getAmountsOut.staticCall(ethers.parseUnits("1", 0), [tokenAddress, config.WBNB_ADDRESS]);
        logger.info(`[فحص] ✅ نجحت محاكاة البيع. العملة قابلة للبيع.`);
        return { passed: true, reason: "اجتاز كل الفحوصات" };
    } catch (error) {
        logger.error(`[فحص] 🚨 فشلت محاكاة البيع! ${error.reason || error.message}`);
        return { passed: false, reason: `فخ عسل (Honeypot) - ${error.reason || 'فشل استدعاء العقد'}` };
    }
}

// =================================================================
// 2. القناص (Sniper)
// =================================================================
async function snipeToken(pairAddress, tokenAddress) {
    try {
        logger.info(`🚀🚀🚀 بدء عملية قنص وشراء العملة: ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        const amountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        const minTokens = amountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);
        const feeData = await provider.getFeeData();
        const tip = ethers.parseUnits(config.GAS_PRICE_TIP_GWEI.toString(), 'gwei');
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.add(tip);
        const tx = await routerContract.swapExactETHForTokens(
            minTokens,
            path,
            config.WALLET_ADDRESS,
            Math.floor(Date.now() / 1000) + 120,
            {
                value: bnbAmountWei,
                gasLimit: config.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas
            }
        );
        logger.info(`[شراء] تم إرسال المعاملة المحمية. الهاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            logger.info(`💰 نجحت عملية الشراء! تم قنص ${tokenAddress}.`);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
            const decimals = await tokenContract.decimals();
            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));
            const msg = `💰 <b>نجحت عملية الشراء!</b> 💰\n\n<b>العملة:</b> <code>${tokenAddress}</code>\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>\n<b>📊 رابط الشارت:</b> <a href='https://dexscreener.com/bsc/${pairAddress}'>DexScreener</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            activeTrades.push({ tokenAddress, pairAddress, buyPrice, initialAmountWei: amountsOut[1], remainingAmountWei: amountsOut[1], decimals, currentProfit: 0, highestProfit: 0 });
            approveMax(tokenAddress);
        } else {
            logger.error(`🚨 فشلت معاملة الشراء (الحالة 0).`);
        }
    } catch (error) {
        logger.error(`❌ خطأ فادح في تنفيذ الشراء: ${error.reason || error}`);
    }
}

async function approveMax(tokenAddress) {
    try {
        logger.info(`[موافقة] جاري عمل Approve لـ ${tokenAddress}...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const feeData = await provider.getFeeData();
        const tx = await tokenContract.approve(config.ROUTER_ADDRESS, ethers.MaxUint256, { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas });
        await tx.wait();
        logger.info(`[موافقة] ✅ تمت الموافقة بنجاح لـ ${tokenAddress}`);
    } catch (error) {
        logger.error(`❌ فشلت عملية الموافقة: ${error}`);
    }
}

// =================================================================
// 3. الحارس (Guardian)
// =================================================================
async function monitorTrades() {
    if (activeTrades.length === 0) return;
    for (const trade of [...activeTrades]) {
        try {
            const path = [trade.tokenAddress, config.WBNB_ADDRESS];
            const oneToken = ethers.parseUnits("1", trade.decimals);
            const amountsOut = await routerContract.getAmountsOut.staticCall(oneToken, path);
            const currentPrice = parseFloat(ethers.formatUnits(amountsOut[1], 18));
            const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
            trade.currentProfit = profit;
            trade.highestProfit = Math.max(trade.highestProfit, profit);
            logger.info(`[مراقبة] ${trade.tokenAddress.slice(0, 10)}... | الربح الحالي: ${profit.toFixed(2)}% | أعلى ربح: ${trade.highestProfit.toFixed(2)}%`);
            if (profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) {
                logger.info(`🎯 [الحارس] تفعيل وقف الخسارة المتحرك لـ ${trade.tokenAddress} عند ربح ${profit.toFixed(2)}%`);
                executeSell(trade, trade.remainingAmountWei, `وقف خسارة متحرك`).then(success => { if (success) removeTrade(trade); });
            }
        } catch (error) {
            logger.error(`[مراقبة] خطأ في مراقبة ${trade.tokenAddress}: ${error}`);
        }
    }
}

async function executeSell(trade, amountToSellWei, reason = "يدوي") {
    if (amountToSellWei.toString() === '0') return false;
    try {
        logger.info(`💸 [بيع] بدء عملية بيع ${reason} لـ ${trade.tokenAddress}...`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountToSellWei, 0, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 300,
            { gasLimit: config.GAS_LIMIT, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
        );
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            const msg = `💸 <b>نجحت عملية البيع (${reason})!</b> 💸\n\n<b>العملة:</b> <code>${trade.tokenAddress}</code>\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            logger.info(`💰💰💰 نجحت عملية البيع لـ ${trade.tokenAddress}!`);
            return true;
        }
    } catch (error) {
        logger.error(`❌ خطأ فادح في عملية البيع: ${error.reason || error}`);
    }
    return false;
}

function removeTrade(tradeToRemove) {
    const index = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress);
    if (index > -1) {
        activeTrades.splice(index, 1);
        logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress} من قائمة المراقبة.`);
    }
}

// =================================================================
// 4. الراصد ونقطة الانطلاق (Watcher & Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل بوت صياد الدرر (v2.2 JS) ---`);
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        const wssProvider = new ethers.WebSocketProvider(config.NODE_URL);
        factoryContract = new ethers.Contract(config.FACTORY_ADDRESS, FACTORY_ABI, wssProvider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        const network = await provider.getNetwork();
        logger.info(`✅ تم الاتصال بالشبكة بنجاح! (${network.name}, ChainID: ${network.chainId})`);
        
        const welcomeMsg = `✅ <b>تم تشغيل بوت صياد الدرر (v2.2 JS) بنجاح!</b>`;
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        telegram.on('message', (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting;
                const newValueStr = msg.text;
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB'].includes(settingKey)) { newValue = parseFloat(newValueStr); } 
                    else if (settingKey === 'GAS_PRICE_TIP_GWEI') { newValue = BigInt(newValueStr); } 
                    else { newValue = parseInt(newValueStr, 10); }
                    if (isNaN(newValue) && typeof newValue !== 'bigint') throw new Error("قيمة غير صالحة");
                    config[settingKey] = newValue;
                    logger.info(`⚙️ تم تغيير ${settingKey} ديناميكياً إلى ${newValue}.`);
                    telegram.sendMessage(chatId, `✅ تم تحديث <b>${settingKey}</b> إلى: <code>${newValue.toString()}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch (error) {
                    telegram.sendMessage(chatId, "❌ قيمة غير صالحة. يرجى إدخال رقم صحيح.", { reply_markup: getMainMenuKeyboard() });
                } finally {
                    delete userState[chatId];
                }
                return;
            }
            switch (msg.text) {
                case '⏸️ إيقاف القنص': case '▶️ استئناف القنص':
                    config.IS_PAUSED = !config.IS_PAUSED;
                    telegram.sendMessage(chatId, `ℹ️ حالة القنص الآن: <b>${config.IS_PAUSED ? "موقوف ⏸️" : "نشط ▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                    break;
                case '🟢 تفعيل التصحيح': case '⚪️ إيقاف التصحيح':
                    config.DEBUG_MODE = !config.DEBUG_MODE;
                    telegram.sendMessage(chatId, `ℹ️ وضع التصحيح الآن: <b>${config.DEBUG_MODE ? "فعّال 🟢" : "غير فعّال ⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                    break;
                case '📊 الحالة': showStatus(chatId); break;
                case '🔬 التشخيص': showDiagnostics(chatId); break;
                case '⚙️ الإعدادات': showSettingsMenu(chatId); break;
                case '💰 بيع يدوي': showManualSellMenu(chatId); break;
            }
        });

        telegram.on('callback_query', (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;
            if (data.startsWith('change_')) {
                const settingKey = data.replace('change_', '');
                userState[chatId] = { awaiting: settingKey };
                telegram.editMessageText(SETTING_PROMPTS[settingKey], { chat_id: chatId, message_id: query.message.message_id });
            } else if (data.startsWith('manual_sell_')) {
                const tokenAddress = data.replace('manual_sell_', '');
                showSellPercentageMenu(chatId, query.message.message_id, tokenAddress);
            } else if (data.startsWith('partial_sell_')) {
                const [_, percentage, tokenAddress] = data.split('_');
                const trade = activeTrades.find(t => t.tokenAddress === tokenAddress);
                if (trade) {
                    const amount = (trade.remainingAmountWei * BigInt(percentage)) / BigInt(100);
                    telegram.editMessageText(`⏳ جاري بيع ${percentage}% من ${tokenAddress.slice(0,10)}...`, { chat_id: chatId, message_id: query.message.message_id });
                    executeSell(trade, amount, `بيع يدوي ${percentage}%`).then(success => {
                        if (success) {
                            trade.remainingAmountWei = trade.remainingAmountWei.sub(amount);
                            if (percentage === '100') removeTrade(trade);
                        }
                    });
                }
            }
        });
        
        logger.info("🎧 [الراصد] بدء الاستماع لحدث PairCreated...");
        factoryContract.on('PairCreated', async (token0, token1, pairAddress) => {
            if (config.IS_PAUSED) return;
            logger.info(`\n👀 [الراصد] تم رصد مجمع جديد: ${pairAddress}`);
            const targetToken = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? token1 : token0;
            const checkResult = await fullCheck(pairAddress, targetToken);
            if (checkResult.passed) {
                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `✅ <b>عملة اجتازت الفحص!</b>\n\n<code>${targetToken}</code>\n\n🚀 جاري محاولة القنص...`, { parse_mode: 'HTML' });
                snipeToken(pairAddress, targetToken);
            } else {
                logger.warn(`🔻 [مهمة منتهية] تم تجاهل ${targetToken} (السبب: ${checkResult.reason}).`);
                if (config.DEBUG_MODE) {
                    await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة</b>\n\n<code>${targetToken}</code>\n\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' });
                }
            }
        });
        setInterval(monitorTrades, 10000);
    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error}`);
        process.exit(1);
    }
}

// --- دوال واجهة التليجرام الكاملة ---
function getMainMenuKeyboard() {
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف القنص" : "⏸️ إيقاف القنص";
    const debugButtonText = config.DEBUG_MODE ? "⚪️ إيقاف التصحيح" : "🟢 تفعيل التصحيح";
    return {
        keyboard: [
            [{ text: "📊 الحالة" }, { text: pauseButtonText }],
            [{ text: "💰 بيع يدوي" }, { text: "🔬 التشخيص" }],
            [{ text: "⚙️ الإعدادات" }, { text: debugButtonText }]
        ],
        resize_keyboard: true
    };
}

function showStatus(chatId) {
    let statusText = "<b>📊 الحالة الحالية للبوت:</b>\n\n";
    statusText += `<b>الحالة:</b> ${config.IS_PAUSED ? 'موقوف مؤقتاً ⏸️' : 'نشط ▶️'}\n`;
    statusText += `<b>وضع التصحيح:</b> ${config.DEBUG_MODE ? 'فعّال 🟢' : 'غير فعّال ⚪️'}\n`;
    statusText += "-----------------------------------\n";
    if (activeTrades.length === 0) {
        statusText += "ℹ️ لا توجد صفقات نشطة حالياً.\n";
    } else {
        statusText += "<b>📈 الصفقات النشطة:</b>\n";
        activeTrades.forEach(trade => {
            statusText += `<b>- <code>${trade.tokenAddress.slice(0, 10)}...</code>:</b> ${trade.currentProfit.toFixed(2)}%\n`;
        });
    }
    statusText += "-----------------------------------\n";
    statusText += "<b>⚙️ إعدادات التداول:</b>\n";
    statusText += `- مبلغ الشراء: ${config.BUY_AMOUNT_BNB} BNB\n`;
    statusText += `- وقف الخسارة المتحرك: ${config.TRAILING_STOP_LOSS_PERCENT}%\n`;
    telegram.sendMessage(chatId, statusText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
}

function showDiagnostics(chatId) {
    fs.readFile('sniper_bot_pro.log', 'utf8', (err, data) => {
        let logData;
        if (err) { logData = "ملف السجل لم يتم إنشاؤه بعد."; } 
        else {
            const lines = data.trim().split('\n');
            logData = lines.slice(-20).join('\n');
            if (!logData) logData = "ملف السجل فارغ.";
        }
        telegram.sendMessage(chatId, `<b>🔬 آخر 20 سطراً من سجل التشخيص:</b>\n\n<pre>${logData}</pre>`, { parse_mode: 'HTML' });
    });
}

function showSettingsMenu(chatId) {
    const keyboard = [
        [{ text: `💵 مبلغ الشراء (${config.BUY_AMOUNT_BNB} BNB)`, callback_data: 'change_BUY_AMOUNT_BNB' }],
        [{ text: `🚀 إكرامية الغاز (${config.GAS_PRICE_TIP_GWEI} Gwei)`, callback_data: 'change_GAS_PRICE_TIP_GWEI' }],
        [{ text: `📊 الانزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        [{ text: `💧 حد السيولة (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `📈 وقف الخسارة المتحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
    ];
    telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد الذي تريد تغييره:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showManualSellMenu(chatId) {
    if (activeTrades.length === 0) {
        telegram.sendMessage(chatId, "ℹ️ لا توجد صفقات نشطة لبيعها.");
        return;
    }
    const keyboard = activeTrades.map(trade => ([{
        text: `بيع ${trade.tokenAddress.slice(0, 6)}...${trade.tokenAddress.slice(-4)} (${trade.currentProfit.toFixed(2)}%)`,
        callback_data: `manual_sell_${trade.tokenAddress}`
    }]));
    telegram.sendMessage(chatId, "<b>اختر الصفقة التي تريد إدارتها:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
}

function showSellPercentageMenu(chatId, messageId, tokenAddress) {
    const keyboard = [
        [{ text: "بيع 25%", callback_data: `partial_sell_25_${tokenAddress}` }, { text: "بيع 50%", callback_data: `partial_sell_50_${tokenAddress}` }],
        [{ text: "بيع 100% (الكل)", callback_data: `partial_sell_100_${tokenAddress}` }]
    ];
    telegram.editMessageText(`<b>اختر نسبة البيع للعملة <code>${tokenAddress.slice(0,10)}...</code>:</b>`, {
        chat_id: chatId, message_id: messageId, parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
}

main();