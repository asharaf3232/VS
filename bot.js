// =================================================================
// صياد الدرر: v9.6 (راصد الزخم الآمن - فلاتر قابلة للتعديل + تصحيح مفصل)
// =================================================================
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import fs from 'fs';
import axios from 'axios';

// --- نظام التسجيل ---
const logger = winston.createLogger({
    level: process.env.DEBUG_MODE === 'true' ? 'info' : 'info', // Keep INFO level for now
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
    WBNB_ADDRESS: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    BUY_AMOUNT_BNB: parseFloat(process.env.BUY_AMOUNT_BNB || '0.01'),
    GAS_PRIORITY_MULTIPLIER: parseInt(process.env.GAS_PRIORITY_MULTIPLIER || '2', 10),
    SLIPPAGE_LIMIT: parseInt(process.env.SLIPPAGE_LIMIT || '49', 10),
    GAS_LIMIT: BigInt(process.env.GAS_LIMIT || '800000'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'), // Used in fullCheck
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '20', 10),
    PARTIAL_TP_PERCENT: parseInt(process.env.PARTIAL_TP_PERCENT || '100', 10),
    PARTIAL_TP_SELL_PERCENT: parseInt(process.env.PARTIAL_TP_SELL_PERCENT || '50', 10),
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
    // Steel Shield Settings
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '95.0'),
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '20.0'),
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '5.0'),
    REQUIRE_OWNERSHIP_RENOUNCED: process.env.REQUIRE_OWNERSHIP_RENOUNCED === 'true',
    // <<< [تطوير v9.6] إضافة فلاتر البحث الأولية >>>
    MIN_AGE_MINUTES: parseInt(process.env.MIN_AGE_MINUTES || '30', 10),
    MAX_AGE_HOURS: parseInt(process.env.MAX_AGE_HOURS || '6', 10),
    MIN_LIQUIDITY_USD: parseInt(process.env.MIN_LIQUIDITY_USD || '10000', 10),
    MIN_VOLUME_H1: parseInt(process.env.MIN_VOLUME_H1 || '5000', 10),
    MIN_TXNS_H1: parseInt(process.env.MIN_TXNS_H1 || '20', 10),
};

// --- ABIs ---
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- Global Variables ---
let provider, wallet, routerContract;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const sellingLocks = new Set();
const processedPairs = new Set();
let isWiseHawkHunting = false;
let lastPairsFound = 0;
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى لسيولة BNB (فحص أمني) بالـ BNB (مثال: 5.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال نسبة البيع عند جني الأرباح الجزئي (مثال: 50):",
    // Steel Shield
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 95):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إرسال الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 20):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 5):`,
    // <<< [تطوير v9.6] إضافة الفلاتر الأولية >>>
    "MIN_AGE_MINUTES": `يرجى إرسال الحد الأدنى للعمر بالدقائق (مثال: 30):`,
    "MAX_AGE_HOURS": `يرجى إرسال الحد الأقصى للعمر بالساعات (مثال: 6):`,
    "MIN_LIQUIDITY_USD": `يرجى إرسال الحد الأدنى للسيولة بالدولار (مثال: 10000):`,
    "MIN_VOLUME_H1": `يرجى إرسال الحد الأدنى للحجم/ساعة بالدولار (مثال: 5000):`,
    "MIN_TXNS_H1": `يرجى إرسال الحد الأدنى للمعاملات/ساعة (مثال: 20):`,
};

// =================================================================
// 1. المدقق (Verifier) - الدرع الفولاذي v9.6 (لا تغيير)
// =================================================================
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * فحص أمان العملة - الدرع الفولاذي v9.6 (نفس كود v9.5 الفعال)
 */
async function checkTokenSecurity(tokenAddress, retry = true) {
    if (!config.GOPLUS_API_KEY) {
        logger.warn('[فحص أمني] مفتاح Go+ API غير موجود، تخطي الفحص.');
        return { is_safe: false, reason: "فحص أمني معطل - لا يمكن المتابعة" };
    }
    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY }, timeout: 8000 });

        if (!response.data || !response.data.result || !response.data.result[tokenAddress.toLowerCase()]) {
            if (retry) {
                logger.warn(`[فحص أمني] لم يتم العثور ${tokenAddress.slice(0,10)}، إعادة محاولة...`);
                await sleep(2000); return checkTokenSecurity(tokenAddress, false);
            }
            return { is_safe: false, reason: "لم يتم العثور في Go+ بعد إعادة المحاولة" };
        }
        const result = response.data.result[tokenAddress.toLowerCase()];

        // فحوصات أساسية
        if (result.is_honeypot === '1') return { is_safe: false, reason: "فخ عسل حسب Go+" };
        const sellTax = parseFloat(result.sell_tax || '0');
        if (sellTax > 0.25) return { is_safe: false, reason: `ضريبة بيع مرتفعة (${(sellTax * 100).toFixed(0)}%)` };
        if (result.is_proxy === '1') return { is_safe: false, reason: "عقد وكيل (Proxy) - خطر" };

        // قفل السيولة
        let totalLockedPercent = 0;
        if (result.lp_holders && Array.isArray(result.lp_holders)) {
            totalLockedPercent = result.lp_holders
                .filter(h => h.is_locked === 1 || h.address === '0x000000000000000000000000000000000000dead')
                .reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100;
        }
        if (totalLockedPercent < config.MIN_LOCKED_LIQUIDITY_PERCENT) {
            return { is_safe: false, reason: `قفل سيولة ${totalLockedPercent.toFixed(0)}% فقط` };
        }

        // تركيز الحيتان
        let topHoldersPercent = 0;
        if (result.holders && Array.isArray(result.holders)) {
            topHoldersPercent = result.holders.slice(0, 10)
                .filter(h => h.address !== result.creator_address && h.address !== tokenAddress.toLowerCase() && h.address !== '0x000000000000000000000000000000000000dead')
                .reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100;
        } else if (config.DEBUG_MODE) { logger.warn(`[⚠️ درع] لا توجد بيانات holders لـ ${tokenAddress.slice(0,10)}.`); }
        if (topHoldersPercent > config.MAX_TOP_HOLDERS_PERCENT) {
            return { is_safe: false, reason: `تركيز حيتان ${topHoldersPercent.toFixed(0)}%` };
        }

        // حصة المطور
        let creatorPercent = parseFloat(result.creator_percent || '0') * 100;
        if (creatorPercent === 0 && result.creator_balance && result.total_supply) {
            try {
                const creatorBalance = parseFloat(result.creator_balance);
                const totalSupply = parseFloat(result.total_supply);
                if (totalSupply > 0) creatorPercent = (creatorBalance / totalSupply) * 100;
            } catch { /* ignore */ }
        }
        if (creatorPercent > config.MAX_CREATOR_PERCENT) {
            return { is_safe: false, reason: `المطور يملك ${creatorPercent.toFixed(0)}%` };
        }

        // التخلي عن العقد
        if (config.REQUIRE_OWNERSHIP_RENOUNCED) {
            if (!result.owner_address || (result.owner_address && result.owner_address !== '0x0000000000000000000000000000000000000000')) {
                return { is_safe: false, reason: "لم يتم التخلي عن العقد" };
            }
        }

        logger.info(`[✅✅✅ درع] ${tokenAddress.slice(0,10)} اجتاز! [ضريبة:${(sellTax * 100).toFixed(1)}%|قفل:${totalLockedPercent.toFixed(1)}%|حيتان:${topHoldersPercent.toFixed(1)}%|مطور:${creatorPercent.toFixed(1)}%]`);
        return { is_safe: true };

    } catch (error) {
        logger.error(`[🚨 فحص أمني] خطأ لـ ${tokenAddress.slice(0,10)}: ${error.message}`);
        return { is_safe: false, reason: "خطأ فادح API الفحص" };
    }
}


async function fullCheck(pairAddress, tokenAddress) {
    try {
        logger.info(`[فحص شامل] ${tokenAddress}`);
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));
        logger.info(` -> سيولة BNB: ${wbnbLiquidity.toFixed(2)}`);

        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) {
            return { passed: false, reason: `سيولة BNB غير كافية (${wbnbLiquidity.toFixed(2)})` };
        }

        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) {
            return { passed: false, reason: securityResult.reason };
        }

        // محاكاة البيع
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        let decimals;
        try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
        const amountIn = ethers.parseUnits("1", decimals);
        await routerContract.getAmountsOut.staticCall(amountIn, [tokenAddress, config.WBNB_ADDRESS]);
        logger.info(` -> ✅ محاكاة البيع ناجحة.`);
        return { passed: true, reason: "اجتاز الفحص الشامل (v9.6)" };

    } catch (error) {
        const isHoneypot = error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT') || error.message.includes('TRANSFER_FROM_FAILED') || error.code === 'CALL_EXCEPTION';
        const reason = isHoneypot ? `فخ عسل (محاكاة فشلت)` : `فشل فحص غير متوقع`;
        logger.error(`[🚨 فحص] فشل لـ ${tokenAddress}: ${reason} - ${error.reason || error.message}`);
        return { passed: false, reason: reason };
    }
}

// =================================================================
// 2. القناص (Sniper) - (لا تغيير)
// =================================================================
// دوال snipeToken و approveMax تبقى كما هي
async function snipeToken(pairAddress, tokenAddress) {
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) {
        logger.warn(`[شراء] تجاهل ${tokenAddress}, موجود بالفعل.`);
        isWiseHawkHunting = false; return;
    }
    try {
        logger.info(`🚀🚀🚀 بدء شراء ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        const amountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        const minTokens = amountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);

        const feeData = await provider.getFeeData();
        const txOptions = { value: bnbAmountWei, gasLimit: config.GAS_LIMIT };
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            const dynamicPriorityFee = feeData.maxPriorityFeePerGas * BigInt(config.GAS_PRIORITY_MULTIPLIER);
            txOptions.maxFeePerGas = feeData.maxFeePerGas + (dynamicPriorityFee - feeData.maxPriorityFeePerGas);
            txOptions.maxPriorityFeePerGas = dynamicPriorityFee;
        } else { txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER); }

        const tx = await routerContract.swapExactETHForTokens(minTokens, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 120, txOptions);
        logger.info(`[شراء] تم الإرسال. هاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            logger.info(`💰 نجاح شراء ${tokenAddress}!`);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
            let decimals; try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));
            const msg = `💰 <b>نجاح الشراء!</b> 💰\n<code>${tokenAddress}</code>\n<a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a> | <a href='https://dexscreener.com/bsc/${pairAddress}'>Chart</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            activeTrades.push({ tokenAddress, pairAddress, buyPrice, decimals, initialAmountWei: amountsOut[1], remainingAmountWei: amountsOut[1], currentProfit: 0, highestProfit: 0, partialTpTaken: false });
            saveTradesToFile(); approveMax(tokenAddress);
        } else { logger.error(`🚨 فشل معاملة شراء ${tokenAddress} (الحالة 0).`); isWiseHawkHunting = false; }
    } catch (error) { logger.error(`❌ خطأ شراء ${tokenAddress}: ${error.reason || error}`); isWiseHawkHunting = false; }
}
async function approveMax(tokenAddress) {
    try {
        logger.info(`[موافقة] ${tokenAddress}...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const feeData = await provider.getFeeData();
        const txOptions = {};
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             txOptions.maxFeePerGas = feeData.maxFeePerGas; txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else { txOptions.gasPrice = feeData.gasPrice; }
        const tx = await tokenContract.approve(config.ROUTER_ADDRESS, ethers.MaxUint256, txOptions);
        await tx.wait(); logger.info(`[موافقة] ✅ ${tokenAddress}`);
    } catch (error) { logger.error(`❌ فشل موافقة ${tokenAddress}: ${error}`); }
}

// =================================================================
// 3. الحارس (Guardian) - (لا تغيير)
// =================================================================
// دوال monitorTrades و executeSell تبقى كما هي
async function monitorTrades() {
    if (activeTrades.length === 0) return;
    if (!routerContract) { logger.warn("[مراقبة] RouterContract غير جاهز."); return; }

    const priceChecks = activeTrades.map(trade => {
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const decimals = trade.decimals || 18;
        const oneToken = ethers.parseUnits("1", decimals);
        return routerContract.getAmountsOut.staticCall(oneToken, path).catch(err => {
             // logger.warn(`[مراقبة] فشل جلب سعر ${trade.tokenAddress.slice(0,10)}: ${err.reason || err.message}`); // تقليل التسجيل
             return null;
         });
    });
    const results = await Promise.allSettled(priceChecks);

    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value !== null) {
            try {
                const currentPrice = parseFloat(ethers.formatUnits(result.value[1], 18));
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit;
                trade.highestProfit = Math.max(trade.highestProfit, profit);

                // جني الأرباح الجزئي
                if (config.PARTIAL_TP_PERCENT > 0 && profit >= config.PARTIAL_TP_PERCENT && !trade.partialTpTaken) {
                    if (sellingLocks.has(trade.tokenAddress)) continue;
                    logger.info(`🎯 [جني ربح جزئي] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}%`);
                    sellingLocks.add(trade.tokenAddress);
                    trade.partialTpTaken = true;
                    const amountToSell = (trade.remainingAmountWei * BigInt(config.PARTIAL_TP_SELL_PERCENT)) / 100n;
                    executeSell(trade, amountToSell, `TP جزئي ${config.PARTIAL_TP_SELL_PERCENT}%`)
                        .then(success => { if (success) { trade.remainingAmountWei -= amountToSell; saveTradesToFile(); } else { trade.partialTpTaken = false; } })
                        .finally(() => sellingLocks.delete(trade.tokenAddress));
                    continue;
                }
                // وقف الخسارة المتحرك
                if (trade.highestProfit > 0 && profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) {
                    if (sellingLocks.has(trade.tokenAddress)) continue;
                    logger.info(`🎯 [وقف متحرك] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}% (أعلى ${trade.highestProfit.toFixed(1)}%)`);
                    sellingLocks.add(trade.tokenAddress);
                    executeSell(trade, trade.remainingAmountWei, `وقف متحرك`)
                        .then(success => { if (success) removeTrade(trade); })
                        .finally(() => sellingLocks.delete(trade.tokenAddress));
                }
            } catch (processingError) { logger.error(`[مراقبة] خطأ معالجة ${trade.tokenAddress}: ${processingError.message}`); }
        } else if (result.status === 'rejected' || result.value === null) {
             const reason = result.reason ? (result.reason.message || result.reason) : "فشل جلب السعر";
             if (config.DEBUG_MODE) logger.error(`[مراقبة] خطأ سعر ${trade.tokenAddress}: ${reason}`);
        }
    }
}
async function executeSell(trade, amountToSellWei, reason = "يدوي") {
    if (amountToSellWei <= 0n) { logger.warn(`[بيع] كمية صفر ${trade.tokenAddress}`); return false; }
    try {
        const decimals = trade.decimals || 18;
        logger.info(`💸 [بيع] ${reason} ${trade.tokenAddress.slice(0,10)}...`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const txOptions = { gasLimit: config.GAS_LIMIT };
        const sellPriorityMultiplier = BigInt(Math.max(1, config.GAS_PRIORITY_MULTIPLIER / 2));
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             const dynamicPriorityFee = feeData.maxPriorityFeePerGas * sellPriorityMultiplier;
             txOptions.maxFeePerGas = feeData.maxFeePerGas + (dynamicPriorityFee - feeData.maxPriorityFeePerGas);
             txOptions.maxPriorityFeePerGas = dynamicPriorityFee;
        } else { txOptions.gasPrice = feeData.gasPrice * sellPriorityMultiplier; }
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(amountToSellWei, 0, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 300, txOptions);
        logger.info(` -> تم الإرسال. هاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            const msg = `💸 <b>نجاح البيع (${reason})!</b>\n<code>${trade.tokenAddress}</code>\n<a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            logger.info(`💰💰💰 نجاح بيع ${trade.tokenAddress}!`); return true;
        } else { logger.error(`🚨 فشل معاملة بيع ${trade.tokenAddress} (الحالة 0).`); }
    } catch (error) {
         const reasonText = error.reason || error.message;
         logger.error(`❌ خطأ بيع ${trade.tokenAddress}: ${reasonText}`);
         telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل البيع (${reason})</b>\n<code>${trade.tokenAddress}</code>\n<b>السبب:</b> ${reasonText}`, { parse_mode: 'HTML' });
    }
    return false;
}

// =================================================================
// 5. تخزين الصفقات النشطة (Persistence) - (لا تغيير)
// =================================================================
// دوال replacer, reviver, saveTradesToFile, loadTradesFromFile, removeTrade تبقى كما هي
function replacer(key, value) { if (typeof value === 'bigint') return value.toString(); return value; }
function reviver(key, value) { if (key === 'decimals') return parseInt(value, 10); if (key && (key.endsWith('Wei') || key.endsWith('Amount'))) try { return BigInt(value); } catch(e) {} return value; }
function saveTradesToFile() { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(activeTrades, replacer, 2), 'utf8'); } catch (error) { logger.error(`💾 خطأ حفظ: ${error.message}`); } }
function loadTradesFromFile() { try { if (fs.existsSync(TRADES_FILE)) { const data = fs.readFileSync(TRADES_FILE, 'utf8'); const loaded = JSON.parse(data, reviver); if (Array.isArray(loaded)) { const valid = loaded.filter(t => t.tokenAddress && t.remainingAmountWei > 0n).map(t => ({ ...t, decimals: t.decimals || 18, partialTpTaken: t.partialTpTaken || false })); activeTrades.push(...valid); } } } catch (error) { logger.error(`💾 خطأ تحميل: ${error.message}`); activeTrades.length = 0; } }
function removeTrade(tradeToRemove) { const i = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress); if (i > -1) { activeTrades.splice(i, 1); logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress.slice(0,10)}`); saveTradesToFile(); isWiseHawkHunting = false; } }


// =================================================================
// 6. الراصد ونقطة الانطلاق (v9.6 "راصد الزخم الآمن - فلترة محسنة")
// =================================================================
/**
 * جلب وفلترة العملات الجديدة من DexScreener (v9.6 المصححة)
 */
async function fetchTrendingPairs() {
    if (config.IS_PAUSED) { logger.info('🛑 البوت متوقف. تخطي البحث.'); return []; }
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${config.WBNB_ADDRESS}`; // جلب أزواج WBNB
        logger.info(`📡 جاري جلب أزواج WBNB من DexScreener...`);
        const response = await axios.get(url, { headers: { 'Accept': 'application/json' }, timeout: 10000 });

        if (response.data && response.data.pairs) {
            const allPairs = response.data.pairs;
            // تطبيق الفلاتر الأولية داخل الكود
            const filteredPairs = allPairs.filter(pair => {
                if (!pair || !pair.pairCreatedAt || !pair.chainId || pair.chainId !== 'bsc' || !pair.baseToken || !pair.baseToken.address) return false;
                const ageMs = Date.now() - (pair.pairCreatedAt * 1000);
                const ageMinutes = ageMs / (1000 * 60);
                if (ageMinutes < config.MIN_AGE_MINUTES || ageMinutes > (config.MAX_AGE_HOURS * 60)) {
                    if (config.DEBUG_MODE) logger.info(`[فلتر] رفض ${pair.baseToken.address.slice(0,10)}: عمر ${ageMinutes.toFixed(1)} د`);
                    return false;
                }
                const liquidityUsd = pair.liquidity?.usd || 0;
                if (liquidityUsd < config.MIN_LIQUIDITY_USD) {
                    if (config.DEBUG_MODE) logger.info(`[فلتر] رفض ${pair.baseToken.address.slice(0,10)}: سيولة $${liquidityUsd.toFixed(0)}`);
                    return false;
                }
                const volumeH1 = pair.volume?.h1 || 0;
                if (volumeH1 < config.MIN_VOLUME_H1) {
                    if (config.DEBUG_MODE) logger.info(`[فلتر] رفض ${pair.baseToken.address.slice(0,10)}: حجم $${volumeH1.toFixed(0)}/س`);
                    return false;
                }
                const txnsH1 = pair.txns?.h1 || {};
                const totalTxns = (txnsH1.buys || 0) + (txnsH1.sells || 0);
                if (totalTxns < config.MIN_TXNS_H1) {
                    if (config.DEBUG_MODE) logger.info(`[فلتر] رفض ${pair.baseToken.address.slice(0,10)}: معاملات ${totalTxns}/س`);
                    return false;
                }
                return true;
            });

            filteredPairs.sort((a, b) => a.pairCreatedAt - b.pairCreatedAt); // الأقدم ضمن النطاق أولاً
            lastPairsFound = filteredPairs.length;
            logger.info(`✅ تم العثور على ${lastPairsFound} هدف مطابق للمعايير الأولية (من ${allPairs.length} زوج).`);
            return filteredPairs;
        }
        lastPairsFound = 0; logger.warn(`⚠️ لم يتم العثور على أزواج WBNB.`); return [];
    } catch (error) { logger.error(`❌ خطأ DexScreener: ${error.message}`); lastPairsFound = 0; return []; }
}

/**
 * معالجة العملة المرشحة (v9.6)
 */
async function processNewTarget(pair) {
    if (!pair || !pair.pairAddress || !pair.baseToken || !pair.baseToken.address) return;
    const pairAddress = pair.pairAddress;
    const tokenAddress = pair.baseToken.address;
    if (processedPairs.has(pairAddress)) return;
    processedPairs.add(pairAddress);

    const liquidityUsd = pair.liquidity?.usd || 0;
    const volumeH1 = pair.volume?.h1 || 0;
    const txnsH1 = pair.txns?.h1 || {};
    const totalTxns = (txnsH1.buys || 0) + (txnsH1.sells || 0);
    const ageMinutes = (Date.now() - (pair.pairCreatedAt * 1000)) / (1000 * 60);

    logger.info(`\n🎯 عملة مرشحة! ${pair.baseToken.symbol} (${tokenAddress.slice(0, 10)}...)`);
    logger.info(`   ${ageMinutes.toFixed(1)}د | $${liquidityUsd.toFixed(0)} | ${volumeH1.toFixed(0)}/س | ${totalTxns}/س`);
    logger.info(`   🔗 https://dexscreener.com/bsc/${pairAddress}`);

    // الفحص الأمني الكامل
    const checkResult = await fullCheck(pairAddress, tokenAddress);

    if (checkResult.passed) {
        if (isWiseHawkHunting) {
            logger.info(`⏳ ${tokenAddress.slice(0,10)} ينتظر - شراء سابق نشط.`);
            processedPairs.delete(pairAddress); // السماح بإعادة المعالجة لاحقًا
            return;
        }
        isWiseHawkHunting = true;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID,
            `<b>🚀 فرصة استثمار آمنة!</b>\n` +
            `<b>${pair.baseToken.symbol}</b> | <code>${tokenAddress}</code>\n` +
            `(${ageMinutes.toFixed(0)}د | $${liquidityUsd.toFixed(0)} | ${volumeH1.toFixed(0)}/س | ${totalTxns}/س)\n` +
            `✅ اجتاز الدرع.\n⏳ جاري الشراء...`, { parse_mode: 'HTML' }
        );
        try { await snipeToken(pairAddress, tokenAddress); }
        catch (e) { logger.error(`Error during snipeToken call: ${e}`); isWiseHawkHunting = false; } // تحرير القفل عند خطأ فادح داخل snipeToken
    } else {
        logger.warn(`❌ ${tokenAddress.slice(0,10)} - ${checkResult.reason}.`);
        if (config.DEBUG_MODE) {
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID,
                `<b>❌ مرفوض</b>\n<code>${tokenAddress}</code>\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' }
            );
        }
    }
}

async function pollForMomentum() {
    logger.info("🚀 [راصد الزخم الآمن] بدأ (v9.6).");
    while (true) {
        try {
            const pairs = await fetchTrendingPairs();
            for (const pair of pairs) {
                try { await processNewTarget(pair); await sleep(500); }
                catch (e) { logger.error(`❌ خطأ معالجة ${pair.pairAddress}: ${e.message}`, e); }
            }
        } catch (error) { logger.error(`❌ خطأ حلقة الراصد: ${error.message}`, error); }
        logger.info(`[راصد] اكتمل البحث (${lastPairsFound} هدف أولي). انتظار 10 دقائق...`);
        await sleep(10 * 60 * 1000);
    }
}

// =================================================================
// 7. الدالة الرئيسية (Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل (v9.6 - فلترة محسنة) ---`);
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        loadTradesFromFile();
        logger.info(`💾 ${activeTrades.length} صفقة نشطة محملة.`);
        const network = await provider.getNetwork();
        logger.info(`✅ متصل بـ (${network.name}, ID: ${network.chainId})`);
        const welcomeMsg = `✅ <b>راصد الزخم الآمن (v9.6) بدأ!</b>`;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        // معالجة رسائل تليجرام
        telegram.on('message', async (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting; delete userState[chatId];
                const newValueStr = msg.text;
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                         newValue = parseFloat(newValueStr);
                    } else { newValue = parseInt(newValueStr, 10); }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");
                    config[settingKey] = newValue; logger.info(`⚙️ ${settingKey} -> ${newValue}.`);
                    await telegram.sendMessage(chatId, `✅ <b>${settingKey}</b> -> <code>${newValue}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch (error) { await telegram.sendMessage(chatId, "❌ قيمة غير صالحة.", { reply_markup: getMainMenuKeyboard() }); }
                return;
            }
            // معالجة الأوامر النصية
            const text = msg.text;
            if (text === '⏸️ إيقاف البحث' || text === '▶️ استئناف البحث') {
                 config.IS_PAUSED = !config.IS_PAUSED;
                 await telegram.sendMessage(chatId, `ℹ️ البحث الآن: <b>${config.IS_PAUSED ? "موقوف ⏸️" : "نشط ▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            } else if (text === '🟢 تفعيل التصحيح' || text === '⚪️ إيقاف التصحيح') {
                 config.DEBUG_MODE = !config.DEBUG_MODE; logger.level = config.DEBUG_MODE ? 'info' : 'info'; // Update logger level if needed
                 await telegram.sendMessage(chatId, `ℹ️ التصحيح: <b>${config.DEBUG_MODE ? "فعّال 🟢" : "غير فعّال ⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            } else if (text === '📊 الحالة') await showStatus(chatId).catch(e => logger.error(`[showStatus] ${e.message}`));
            else if (text === '🔬 التشخيص') showDiagnostics(chatId);
            else if (text === '⚙️ الإعدادات') showSettingsMenu(chatId);
            else if (text === '💰 بيع يدوي') showManualSellMenu(chatId);
            else if (text === '🔄 تصفير البيانات') showResetConfirmation(chatId);
        });

        // معالجة أزرار Inline Keyboard
        telegram.on('callback_query', async (query) => {
            const chatId = query.message.chat.id; const data = query.data;
            try { await query.answer(); } catch {}
            if (data === 'confirm_reset') {
                try { activeTrades.length = 0; if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE); isWiseHawkHunting = false; processedPairs.clear(); logger.info("🔄 تم التصفير."); await telegram.editMessageText("✅ تم.", { chat_id: chatId, message_id: query.message.message_id }); }
                catch (error) { logger.error(`🔄 خطأ تصفير: ${error.message}`); await telegram.editMessageText("❌ خطأ.", { chat_id: chatId, message_id: query.message.message_id }); }
            } else if (data === 'cancel_reset') await telegram.editMessageText("👍 تم الإلغاء.", { chat_id: chatId, message_id: query.message.message_id });
            else if (data.startsWith('change_')) { const key = data.replace('change_', ''); if (SETTING_PROMPTS[key]) { userState[chatId] = { awaiting: key }; await telegram.editMessageText(SETTING_PROMPTS[key], { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data.startsWith('manual_sell_')) showSellPercentageMenu(chatId, query.message.message_id, data.replace('manual_sell_', ''));
            else if (data.startsWith('partial_sell_')) { const [_, perc, addr] = data.split('_'); if (sellingLocks.has(addr)) { try { await query.answer("⏳ بيع سابق!", { show_alert: true }); } catch {} return; } const trade = activeTrades.find(t => t.tokenAddress === addr); if (trade) { sellingLocks.add(addr); const amount = (trade.remainingAmountWei * BigInt(perc)) / 100n; await telegram.editMessageText(`⏳ بيع ${perc}%...`, { chat_id: chatId, message_id: query.message.message_id }); executeSell(trade, amount, `يدوي ${perc}%`).then(ok => { if (ok) { trade.remainingAmountWei -= amount; saveTradesToFile(); if (perc === '100' || trade.remainingAmountWei <= 0n) removeTrade(trade); } }).finally(() => sellingLocks.delete(addr)); } else { try { await query.answer("غير موجودة!", { show_alert: true }); } catch {} } }
        });

        // بدء العمليات الرئيسية
        pollForMomentum();
        setInterval(monitorTrades, 2000);

    } catch (error) {
        logger.error(`❌ فشل فادح: ${error.message}`, error);
        try { await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح أوقف البوت!**\n${error.message}`, { parse_mode: 'HTML' }); } catch {}
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI)
// =================================================================
function getMainMenuKeyboard() { const p = config.IS_PAUSED ? "▶️ استئناف البحث" : "⏸️ إيقاف البحث"; const d = config.DEBUG_MODE ? "⚪️ إيقاف التصحيح" : "🟢 تفعيل التصحيح"; return { keyboard: [[{ text: "📊 الحالة" }, { text: p }], [{ text: "💰 بيع يدوي" }, { text: "🔬 التشخيص" }], [{ text: "⚙️ الإعدادات" }, { text: d }], [{ text: "🔄 تصفير البيانات" }]], resize_keyboard: true }; }
async function showStatus(chatId) { let s = `<b>📊 الحالة (v9.6):</b>\n\n`; s += `<b>البحث:</b> ${config.IS_PAUSED ? 'موقوف⏸️' : 'نشط▶️'} | <b>التصحيح:</b> ${config.DEBUG_MODE ? 'فعّال🟢' : 'OFF⚪️'}\n`; s += `<b>الشراء:</b> ${isWiseHawkHunting ? 'مشغول🦅' : 'جاهز'} | <b>أهداف:${lastPairsFound}</b>\n-----------------------------------\n`; let bnb = 0; try { bnb = parseFloat(ethers.formatEther(await provider.getBalance(config.WALLET_ADDRESS))); } catch {} s += `<b>💰 رصيد:</b> ~${bnb.toFixed(5)} BNB\n<b>📦 صفقات:</b> ${activeTrades.length}\n-----------------------------------\n`; if (activeTrades.length > 0) { s += "<b>📈 الصفقات النشطة:</b>\n"; activeTrades.forEach(t => { s += `•<code>${t.tokenAddress.slice(0, 10)}..</code>(${t.currentProfit.toFixed(1)}%)${t.partialTpTaken ? '(✅TP جزئي)' : ''}\n`; }); } else s += "ℹ️ لا توجد صفقات.\n"; s += "-----------------------------------\n<b>⚙️ الإعدادات:</b>\n- شراء:${config.BUY_AMOUNT_BNB} BNB | وقف:${config.TRAILING_STOP_LOSS_PERCENT}% | TP:${config.PARTIAL_TP_PERCENT}%(${config.PARTIAL_TP_SELL_PERCENT}%)\n<b>🛡️ الدرع:</b> قفل:${config.MIN_LOCKED_LIQUIDITY_PERCENT}%|حيتان:${config.MAX_TOP_HOLDERS_PERCENT}%|مطور:${config.MAX_CREATOR_PERCENT}%|تخلي:${config.REQUIRE_OWNERSHIP_RENOUNCED ? '✅' : '❌'}`; await telegram.sendMessage(chatId, s, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
function showResetConfirmation(chatId) { const k = [[{ text: "❌ نعم", callback_data: 'confirm_reset' }], [{ text: "✅ إلغاء", callback_data: 'cancel_reset' }]]; telegram.sendMessage(chatId, "<b>⚠️ تصفير؟</b> حذف الصفقات والملف؟", { parse_mode: "HTML", reply_markup: { inline_keyboard: k } }); }
function showDiagnostics(chatId) { fs.readFile('sniper_bot_pro.log', 'utf8', (err, data) => { let l = err ? "لا يوجد سجل." : (lines => lines.slice(-20).join('\n') || "السجل فارغ.")(data.trim().split('\n')); telegram.sendMessage(chatId, `<b>🔬 آخر 20 سطرًا:</b>\n<pre>${l}</pre>`, { parse_mode: 'HTML' }); }); }
function showSettingsMenu(chatId) { const k = [ [{ text: `💵 شراء (${config.BUY_AMOUNT_BNB})`, callback_data: 'change_BUY_AMOUNT_BNB' }, { text: `🚀 غاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }], [{ text: `📊 انزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }, { text: `💧 سيولة BNB (${config.MINIMUM_LIQUIDITY_BNB})`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }], [{ text: `📈 وقف (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }], [{ text: `🎯 TP هدف (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }, { text: `💰 TP بيع (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }], [{ text: `🔒 قفل (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: 'change_MIN_LOCKED_LIQUIDITY_PERCENT' }], [{ text: `🐳 حيتان (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: 'change_MAX_TOP_HOLDERS_PERCENT' }, { text: `👨‍💻 مطور (${config.MAX_CREATOR_PERCENT}%)`, callback_data: 'change_MAX_CREATOR_PERCENT' }], ]; telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: k } }); }
function showManualSellMenu(chatId) { if (activeTrades.length === 0) { telegram.sendMessage(chatId, "ℹ️ لا صفقات."); return; } const k = activeTrades.map(t => ([{ text: `بيع ${t.tokenAddress.slice(0, 6)}..(${t.currentProfit.toFixed(1)}%)`, callback_data: `manual_sell_${t.tokenAddress}` }])); telegram.sendMessage(chatId, "<b>اختر صفقة:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: k } }); }
function showSellPercentageMenu(chatId, messageId, tokenAddress) { const k = [[{ text: "25%", callback_data: `partial_sell_25_${tokenAddress}` }, { text: "50%", callback_data: `partial_sell_50_${tokenAddress}` }], [{ text: "100%", callback_data: `partial_sell_100_${tokenAddress}` }]]; telegram.editMessageText(`<b>نسبة بيع <code>${tokenAddress.slice(0,10)}...</code>:</b>`, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: k } }); }

// معالجة أخطاء تليجرام العامة
telegram.on('polling_error', (error) => { logger.error(`[خطأ تليجرام] ${error.code}: ${error.message}`); });

// بدء تشغيل البوت
main();
