// =================================================================
// صياد الدرر: v12.1 (بروتوكول الصقر الحكيم - فحص النبض)
// =================================================================
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import fs from 'fs';
import axios from 'axios';

// --- نظام التسجيل ---
const logger = winston.createLogger({
    level: process.env.DEBUG_MODE === 'true' ? 'info' : 'info',
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
    PANCAKE_FACTORY_ADDRESS: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    BUY_AMOUNT_BNB: parseFloat(process.env.BUY_AMOUNT_BNB || '0.01'),
    GAS_PRIORITY_MULTIPLIER: parseInt(process.env.GAS_PRIORITY_MULTIPLIER || '2', 10),
    SLIPPAGE_LIMIT: parseInt(process.env.SLIPPAGE_LIMIT || '49', 10),
    GAS_LIMIT: BigInt(process.env.GAS_LIMIT || '800000'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'), // فحص السيولة بالـ BNB (في fullCheck)
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
    // Search Filters / Viability Check Filters
    MIN_AGE_MINUTES: parseInt(process.env.MIN_AGE_MINUTES || '30', 10),
    MAX_AGE_HOURS: parseInt(process.env.MAX_AGE_HOURS || '6', 10), // لمنع معالجة عملات قديمة جدًا
    MIN_LIQUIDITY_USD: parseInt(process.env.MIN_LIQUIDITY_USD || '10000', 10), // فحص السيولة بالـ USD (في فحص النبض)
    MIN_VOLUME_H1: parseInt(process.env.MIN_VOLUME_H1 || '5000', 10), // (لم يعد يستخدم مباشرة في فحص النبض)
    MIN_TXNS_H1: parseInt(process.env.MIN_TXNS_H1 || '20', 10),      // (لم يعد يستخدم مباشرة في فحص النبض)
    // --- إعدادات جديدة لفحص النبض (v12.1) ---
    MIN_VOLUME_15M: parseInt(process.env.MIN_VOLUME_15M || '1000', 10), // الحد الأدنى للحجم $ في آخر 15 دقيقة
    MIN_TXNS_15M: parseInt(process.env.MIN_TXNS_15M || '5', 10),       // الحد الأدنى للمعاملات في آخر 15 دقيقة
    // MIN_HOLDERS_AFTER_30MIN: parseInt(process.env.MIN_HOLDERS_AFTER_30MIN || '50', 10), // (مؤجل - يحتاج API إضافي)
};

// --- ABIs ---
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];
const FACTORY_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'];

// --- Global Variables ---
let provider, wallet, routerContract, listenerProvider;
let factoryContract;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const sellingLocks = new Set();
const processedPairs = new Set(); // يُستخدم لمنع إعادة المعالجة في نفس الدورة
let isWiseHawkHunting = false;
const potentialTrades = new Map(); // K: tokenAddress, V: { pairAddress: string, foundAt: number }
let lastPairsFound = 0;

// --- تحديث v12.1: إضافة إعدادات جديدة للرسائل ---
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى لسيولة BNB للفحص الأمني (مثال: 5.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال نسبة البيع عند جني الأرباح الجزئي (مثال: 50):",
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 95):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إرسال الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 20):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 5):`,
    "MIN_AGE_MINUTES": `يرجى إرسال الحد الأدنى للعمر بالدقائق قبل بدء الفحص (مثال: 30):`,
    "MAX_AGE_HOURS": `يرجى إرسال الحد الأقصى للعمر بالساعات لتجاهل العملات القديمة جدًا (مثال: 6):`,
    "MIN_LIQUIDITY_USD": `يرجى إرسال الحد الأدنى للسيولة بالدولار لفحص النبض (مثال: 10000):`,
    "MIN_VOLUME_15M": `يرجى إرسال الحد الأدنى للحجم بالدولار في آخر 15 دقيقة (مثال: 1000):`, // جديد
    "MIN_TXNS_15M": `يرجى إرسال الحد الأدنى للمعاملات في آخر 15 دقيقة (مثال: 5):`,          // جديد
};

// =================================================================
// 1. المدقق (Verifier) - (لا تغيير)
// =================================================================
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function checkTokenSecurity(tokenAddress, retry = true) { /* ... نفس الكود من v11.2 ... */
    if (!config.GOPLUS_API_KEY) { logger.warn('[فحص أمني] مفتاح Go+ API غير موجود.'); return { is_safe: true, reason: "فحص أمني معطل" }; }
    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY }, timeout: 8000 });
        if (!response.data || !response.data.result || !response.data.result[tokenAddress.toLowerCase()]) {
            if (retry) { logger.warn(`[فحص أمني] لم يتم العثور ${tokenAddress.slice(0,10)}، إعادة محاولة...`); await sleep(2000); return checkTokenSecurity(tokenAddress, false); }
            return { is_safe: false, reason: "لم يتم العثور في Go+" };
        }
        const result = response.data.result[tokenAddress.toLowerCase()];

        if (result.is_honeypot === '1') return { is_safe: false, reason: "فخ عسل Go+" };
        const sellTax = parseFloat(result.sell_tax || '0'); if (sellTax > 0.25) return { is_safe: false, reason: `ضريبة بيع ${(sellTax * 100).toFixed(0)}%` };
        if (result.is_proxy === '1') return { is_safe: false, reason: "عقد وكيل (Proxy)" };

        let totalLockedPercent = 0;
        if (result.lp_holders && Array.isArray(result.lp_holders)) { totalLockedPercent = result.lp_holders.filter(h => h.is_locked === 1 || h.address === '0x000000000000000000000000000000000000dead').reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100; }
        if (totalLockedPercent < config.MIN_LOCKED_LIQUIDITY_PERCENT) return { is_safe: false, reason: `قفل سيولة ${totalLockedPercent.toFixed(0)}% فقط` };

        let topHoldersPercent = 0;
        if (result.holders && Array.isArray(result.holders)) { topHoldersPercent = result.holders.slice(0, 10).filter(h => h.address !== result.creator_address && h.address !== tokenAddress.toLowerCase() && h.address !== '0x000000000000000000000000000000000000dead').reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100; }
        else if (config.DEBUG_MODE) { logger.warn(`[⚠️ درع] لا توجد بيانات holders لـ ${tokenAddress.slice(0,10)}.`); }
        if (topHoldersPercent > config.MAX_TOP_HOLDERS_PERCENT) return { is_safe: false, reason: `تركيز حيتان ${topHoldersPercent.toFixed(0)}%` };

        let creatorPercent = parseFloat(result.creator_percent || '0') * 100;
        if (creatorPercent === 0 && result.creator_balance && result.total_supply) { try { const cb = parseFloat(result.creator_balance); const ts = parseFloat(result.total_supply); if (ts > 0) creatorPercent = (cb / ts) * 100; } catch { /* ignore */ } }
        if (creatorPercent > config.MAX_CREATOR_PERCENT) return { is_safe: false, reason: `المطور يملك ${creatorPercent.toFixed(0)}%` };

        if (config.REQUIRE_OWNERSHIP_RENOUNCED) { if (!result.owner_address || (result.owner_address && result.owner_address !== '0x0000000000000000000000000000000000000000')) return { is_safe: false, reason: "لم يتم التخلي عن العقد" }; }

        logger.info(`[✅ درع] ${tokenAddress.slice(0,10)} اجتاز! [ض:${(sellTax * 100).toFixed(1)}%|ق:${totalLockedPercent.toFixed(1)}%|ح:${topHoldersPercent.toFixed(1)}%|م:${creatorPercent.toFixed(1)}%]`);
        return { is_safe: true };
    } catch (error) { logger.error(`[🚨 فحص أمني] خطأ ${tokenAddress.slice(0,10)}: ${error.message}`); return { is_safe: false, reason: "خطأ API الفحص" }; }
 }
async function fullCheck(pairAddress, tokenAddress) { /* ... نفس الكود من v11.2 ... */
    try {
        logger.info(`[🛡️ فحص أمني عميق] ${tokenAddress.slice(0,10)}...`);
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));

        // فحص سيولة BNB
        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) return { passed: false, reason: `فشل فحص الأمان: سيولة BNB غير كافية (${wbnbLiquidity.toFixed(2)})` };

        // فحص GoPlus + الدرع الفولاذي
        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) return { passed: false, reason: `فشل فحص الأمان: ${securityResult.reason}` };

        // محاكاة البيع
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        let decimals; try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
        const amountIn = ethers.parseUnits("1", decimals);
        await routerContract.getAmountsOut.staticCall(amountIn, [tokenAddress, config.WBNB_ADDRESS]);
        logger.info(` -> ✅ فحص أمني عميق ناجح.`);
        return { passed: true, reason: "اجتاز الفحص الأمني العميق (v12.1)" };
    } catch (error) {
        const isHoneypot = error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT') || error.message.includes('TRANSFER_FROM_FAILED') || error.code === 'CALL_EXCEPTION';
        const reason = isHoneypot ? `فخ عسل (محاكاة فشلت)` : `فشل فحص غير متوقع`;
        logger.error(`[🚨 فحص أمني] فشل ${tokenAddress.slice(0,10)}: ${reason} - ${error.reason || error.message}`);
        return { passed: false, reason: reason };
    }
}

// =================================================================
// 2. القناص (Sniper) - (لا تغيير)
// =================================================================
async function snipeToken(pairAddress, tokenAddress) { /* ... نفس الكود من v11.2 ... */
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) { logger.warn(`[شراء] تجاهل ${tokenAddress}, موجود.`); isWiseHawkHunting = false; return; }
    try {
        logger.info(`🚀🚀🚀 شراء ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        const amountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        const minTokens = amountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);

        const feeData = await provider.getFeeData();
        const txOptions = { value: bnbAmountWei, gasLimit: config.GAS_LIMIT };
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { const p = feeData.maxPriorityFeePerGas * BigInt(config.GAS_PRIORITY_MULTIPLIER); txOptions.maxFeePerGas = feeData.maxFeePerGas + (p - feeData.maxPriorityFeePerGas); txOptions.maxPriorityFeePerGas = p; }
        else { txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER); }

        const tx = await routerContract.swapExactETHForTokens(minTokens, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 120, txOptions);
        logger.info(`[شراء] الإرسال.. هاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            logger.info(`💰 نجاح شراء ${tokenAddress}!`);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
            let decimals; try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));
            const msg = `💰 <b>نجاح الشراء!</b>\n<code>${tokenAddress}</code>\n<a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a> | <a href='https://dexscreener.com/bsc/${pairAddress}'>Chart</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            activeTrades.push({ tokenAddress, pairAddress, buyPrice, decimals, initialAmountWei: amountsOut[1], remainingAmountWei: amountsOut[1], currentProfit: 0, highestProfit: 0, partialTpTaken: false });
            saveTradesToFile(); approveMax(tokenAddress);
        } else { logger.error(`🚨 فشل معاملة شراء ${tokenAddress} (الحالة 0).`); isWiseHawkHunting = false; }
    } catch (error) { logger.error(`❌ خطأ شراء ${tokenAddress}: ${error.reason || error.message}`); isWiseHawkHunting = false; }
 }
async function approveMax(tokenAddress) { /* ... نفس الكود من v11.2 ... */
    try {
        logger.info(`[موافقة] ${tokenAddress}...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const feeData = await provider.getFeeData(); const txOptions = {};
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { txOptions.maxFeePerGas = feeData.maxFeePerGas; txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas; }
        else { txOptions.gasPrice = feeData.gasPrice; }
        const tx = await tokenContract.approve(config.ROUTER_ADDRESS, ethers.MaxUint256, txOptions);
        await tx.wait(); logger.info(`[موافقة] ✅ ${tokenAddress}`);
    } catch (error) { logger.error(`❌ فشل موافقة ${tokenAddress}: ${error.message}`); }
 }

// =================================================================
// 3. الحارس (Guardian) - (لا تغيير)
// =================================================================
async function monitorTrades() { /* ... نفس الكود من v11.2 ... */
    if (activeTrades.length === 0 || !routerContract) return;
    const priceChecks = activeTrades.map(trade => { const path = [trade.tokenAddress, config.WBNB_ADDRESS]; const decimals = trade.decimals || 18; const oneToken = ethers.parseUnits("1", decimals); return routerContract.getAmountsOut.staticCall(oneToken, path).catch(() => null); });
    const results = await Promise.allSettled(priceChecks);
    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i]; const result = results[i];
        if (result.status === 'fulfilled' && result.value !== null) {
            try {
                const currentPrice = parseFloat(ethers.formatUnits(result.value[1], 18));
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit; trade.highestProfit = Math.max(trade.highestProfit, profit);
                 if (config.DEBUG_MODE) logger.info(`[مراقبة] ${trade.tokenAddress.slice(0, 10)} | الربح: ${profit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%`);

                if (config.PARTIAL_TP_PERCENT > 0 && profit >= config.PARTIAL_TP_PERCENT && !trade.partialTpTaken) { if (sellingLocks.has(trade.tokenAddress)) continue; logger.info(`🎯 [TP جزئي] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}%`); sellingLocks.add(trade.tokenAddress); trade.partialTpTaken = true; const amount = (trade.remainingAmountWei * BigInt(config.PARTIAL_TP_SELL_PERCENT)) / 100n; executeSell(trade, amount, `TP جزئي ${config.PARTIAL_TP_SELL_PERCENT}%`).then(ok => { if (ok) { trade.remainingAmountWei -= amount; saveTradesToFile(); } else { trade.partialTpTaken = false; } }).finally(() => sellingLocks.delete(trade.tokenAddress)); continue; }
                if (trade.highestProfit > 0 && profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) { if (sellingLocks.has(trade.tokenAddress)) continue; logger.info(`🎯 [وقف متحرك] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}%`); sellingLocks.add(trade.tokenAddress); executeSell(trade, trade.remainingAmountWei, `وقف متحرك`).then(ok => { if (ok) removeTrade(trade); }).finally(() => sellingLocks.delete(trade.tokenAddress)); }
            } catch (e) { logger.error(`[مراقبة] خطأ معالجة ${trade.tokenAddress}: ${e.message}`); }
        } else if (config.DEBUG_MODE && (result.status === 'rejected' || result.value === null)) { logger.error(`[مراقبة] خطأ سعر ${trade.tokenAddress}: ${result.reason?.message || 'فشل staticCall'}`); }
    }
}
async function executeSell(trade, amountToSellWei, reason = "يدوي") { /* ... نفس الكود من v11.2 ... */
    if (amountToSellWei <= 0n) { logger.warn(`[بيع] كمية صفر ${trade.tokenAddress}`); return false; }
    try {
        const decimals = trade.decimals || 18; logger.info(`💸 [بيع] ${reason} ${trade.tokenAddress.slice(0,10)}...`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS]; const feeData = await provider.getFeeData();
        const txOptions = { gasLimit: config.GAS_LIMIT }; const m = BigInt(Math.max(1, Math.floor(config.GAS_PRIORITY_MULTIPLIER / 2)));
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { const p = feeData.maxPriorityFeePerGas * m; txOptions.maxFeePerGas = feeData.maxFeePerGas + (p - feeData.maxPriorityFeePerGas); txOptions.maxPriorityFeePerGas = p; }
        else { txOptions.gasPrice = feeData.gasPrice * m; }
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(amountToSellWei, 0, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 300, txOptions);
        logger.info(` -> الإرسال.. هاش: ${tx.hash}`); const receipt = await tx.wait();
        if (receipt.status === 1) { const msg = `💸 <b>نجاح البيع (${reason})!</b>\n<code>${trade.tokenAddress}</code>\n<a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`; telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' }); logger.info(`💰💰💰 نجاح بيع ${trade.tokenAddress}!`); return true; }
        else { logger.error(`🚨 فشل معاملة بيع ${trade.tokenAddress} (الحالة 0).`); }
    } catch (error) { const r = error.reason || error.message; logger.error(`❌ خطأ بيع ${trade.tokenAddress}: ${r}`); telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل البيع (${reason})</b>\n<code>${trade.tokenAddress}</code>\n<b>السبب:</b> ${r}`, { parse_mode: 'HTML' }); }
    return false;
}

// =================================================================
// 5. تخزين الصفقات النشطة (Persistence) - (لا تغيير)
// =================================================================
function replacer(key, value) { /* ... نفس الكود ... */ if (typeof value === 'bigint') return value.toString(); return value; }
function reviver(key, value) { /* ... نفس الكود ... */ if (key === 'decimals') return parseInt(value, 10); if (key && (key.endsWith('Wei') || key.endsWith('Amount'))) try { return BigInt(value); } catch(e) {} return value; }
function saveTradesToFile() { /* ... نفس الكود ... */ try { fs.writeFileSync(TRADES_FILE, JSON.stringify(activeTrades, replacer, 2), 'utf8'); logger.info(`💾 تم حفظ ${activeTrades.length} صفقة.`); } catch (error) { logger.error(`💾 خطأ حفظ: ${error.message}`); } }
function loadTradesFromFile() { /* ... نفس الكود ... */ try { if (fs.existsSync(TRADES_FILE)) { const d = fs.readFileSync(TRADES_FILE, 'utf8'); const l = JSON.parse(d, reviver); if (Array.isArray(l)) { const v = l.filter(t => t.tokenAddress && t.remainingAmountWei > 0n).map(t => ({ ...t, decimals: t.decimals||18, partialTpTaken: t.partialTpTaken||false })); activeTrades.push(...v); } } } catch (error) { logger.error(`💾 خطأ تحميل: ${error.message}`); activeTrades.length = 0; } }
function removeTrade(tradeToRemove) { /* ... نفس الكود ... */ const i = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress); if (i > -1) { activeTrades.splice(i, 1); logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress.slice(0,10)}`); saveTradesToFile(); isWiseHawkHunting = false; } }

// =================================================================
// 6. الراصد ونقطة الانطلاق (v12.1 - بروتوكول الصقر الحكيم)
// =================================================================

/**
 * [جديد/معدل v12.1] فحص النبض (Viability Check) باستخدام DexScreener
 * يُستخدم لفحص العملات الموجودة في قائمة المراقبة بعد فترة الانتظار
 */
async function checkDexScreenerViability(pairAddress, tokenAddress) {
    try {
        const url = `https://api.dexscreener.com/latest/dex/pairs/bsc/${pairAddress}`;
        const response = await axios.get(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });

        if (!response.data || !response.data.pair) {
            return { passed: false, reason: "لم يتم العثور على الزوج في DexScreener" };
        }

        const pair = response.data.pair;

        // أ) فحص السيولة مجددًا (USD)
        const liquidityUsd = pair.liquidity?.usd || 0;
        if (liquidityUsd < config.MIN_LIQUIDITY_USD) {
            return { passed: false, reason: `فشل فحص النبض: سيولة منخفضة ($${liquidityUsd.toFixed(0)})` };
        }

        // ب) فحص حجم التداول (آخر 15 دقيقة)
        const volumeM15 = pair.volume?.m15 || 0;
        if (volumeM15 < config.MIN_VOLUME_15M) {
            return { passed: false, reason: `فشل فحص النبض: حجم منخفض ($${volumeM15.toFixed(0)}/15د)` };
        }

        // ج) فحص عدد المعاملات (آخر 15 دقيقة)
        const txnsM15 = pair.txns?.m15 || {};
        const totalTxnsM15 = (txnsM15.buys || 0) + (txnsM15.sells || 0);
        if (totalTxnsM15 < config.MIN_TXNS_15M) {
            return { passed: false, reason: `فشل فحص النبض: معاملات قليلة (${totalTxnsM15}/15د)` };
        }

        // د) فحص عدد الحاملين (مؤجل حاليًا)
        // const holders = pair.info?.holders; // افتراضي، قد لا يكون موجودًا بهذا الشكل
        // if (holders < config.MIN_HOLDERS_AFTER_30MIN) {
        //     return { passed: false, reason: `فشل فحص النبض: عدد الحاملين قليل (${holders})` };
        // }

        const logData = `L:$${liquidityUsd.toFixed(0)} V15:${volumeM15.toFixed(0)} T15:${totalTxnsM15}`;
        logger.info(`[💓 فحص النبض] ${tokenAddress.slice(0,10)} اجتاز: ${logData}`);
        return { passed: true, reason: logData, data: pair }; // إعادة البيانات للاستخدام المحتمل

    } catch (error) {
        if (error.response && error.response.status === 404) {
             return { passed: false, reason: "فشل فحص النبض: خطأ 404 DexScreener (الزوج غير موجود؟)" };
        }
        logger.error(`❌ خطأ DexScreener (فحص النبض) ${pairAddress}: ${error.message}`);
        return { passed: false, reason: "فشل فحص النبض: خطأ API DexScreener" };
    }
}

async function handlePairCreated(token0, token1, pairAddress) { /* ... نفس الكود من v11.2 ... */
    if (config.IS_PAUSED) return;
    const wbnbAddressLower = config.WBNB_ADDRESS.toLowerCase();
    let tokenAddress;
    if (token0.toLowerCase() === wbnbAddressLower) { tokenAddress = token1; }
    else if (token1.toLowerCase() === wbnbAddressLower) { tokenAddress = token0; }
    else { if (config.DEBUG_MODE) logger.info(`[مستمع] تجاهل زوج ليس WBNB: ${token0.slice(0,6)}/${token1.slice(0,6)}`); return; }
    if (activeTrades.some(t => t.tokenAddress === tokenAddress) || potentialTrades.has(tokenAddress)) { return; }
    logger.info(`\n\n🎯 [زوج جديد مكتشف!]`);
    logger.info(`   العملة: ${tokenAddress}`);
    logger.info(`   الزوج: ${pairAddress}`);
    logger.info(`   -> تمت الإضافة إلى قائمة المراقبة (انتظار ${config.MIN_AGE_MINUTES} دقيقة).\n`);
    potentialTrades.set(tokenAddress, { pairAddress: pairAddress, foundAt: Date.now() });
    lastPairsFound = potentialTrades.size;
}

async function listenForNewPairs() { /* ... نفس الكود من v11.2 ... */
    let reconnectDelay = 5000;
    const maxDelay = 300000;

    if (!config.NODE_URL || !config.NODE_URL.startsWith('ws')) {
        logger.error(`[خطأ مستمع] NODE_URL يجب أن يكون رابط WebSocket (wss://)`);
        return;
    }
    logger.info("🚀 [المستمع v11.2] بدء حلقة الاتصال..."); // Keep v11.2 here

    while (true) {
        let heartbeatInterval;
        const cleanup = () => {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            if (factoryContract) factoryContract.removeAllListeners('PairCreated');
            if (listenerProvider) {
                listenerProvider.removeAllListeners('error');
                try { listenerProvider.destroy(); } catch (e) { logger.warn(`[مستمع Cleanup] Error destroying provider: ${e.message}`); }
                if (listenerProvider._websocket) {
                     try { listenerProvider._websocket.close(); } catch (e) { logger.warn(`[مستمع Cleanup] Error closing websocket: ${e.message}`); }
                     try { listenerProvider._websocket.terminate(); } catch (e) { logger.warn(`[مستمع Cleanup] Error terminating websocket: ${e.message}`); }
                }
            }
            listenerProvider = null;
            factoryContract = null;
        };

        try {
            logger.info(`🔌 [المستمع] محاولة الاتصال بـ WebSocket (${config.NODE_URL})...`);
            listenerProvider = new ethers.WebSocketProvider(config.NODE_URL);

            await Promise.race([
                listenerProvider.ready,
                sleep(30000).then(() => Promise.reject(new Error("WebSocket connection timeout")))
            ]);
            logger.info("✅ [المستمع] تم الاتصال بـ WebSocket بنجاح!");

            try {
                await listenerProvider.getNetwork();
                logger.info('[المستمع] تم التحقق من الشبكة عبر WebSocket.');
            } catch (networkError) {
                logger.error(`[خطأ مستمع] فشل التحقق من الشبكة بعد الاتصال: ${networkError.message}.`);
                throw networkError;
            }

            reconnectDelay = 5000;

            factoryContract = new ethers.Contract(config.PANCAKE_FACTORY_ADDRESS, FACTORY_ABI, listenerProvider);
            logger.info("🎧 [المستمع] بدء الاستماع لحدث PairCreated...");
            factoryContract.on('PairCreated', handlePairCreated);

            heartbeatInterval = setInterval(async () => {
                try {
                    await listenerProvider.getBlockNumber();
                     if (config.DEBUG_MODE) logger.info("❤️ [الراصد] نبضة WebSocket ناجحة.");
                } catch (heartbeatError) {
                    logger.error("💔 [الراصد] فشل نبضة WebSocket! بدء إعادة الاتصال...", heartbeatError);
                    cleanup();
                    throw new Error("Heartbeat failed");
                }
            }, 60000);

            await new Promise((resolve, reject) => {
                 listenerProvider.on('error', (err) => {
                     logger.error(`🔌 [المستمع] خطأ Provider WebSocket! ${err.code}: ${err.message}`);
                     reject(err);
                 });
                 if (listenerProvider._websocket) {
                     listenerProvider._websocket.onclose = () => {
                         logger.warn("🔌 [المستمع] انقطع اتصال WebSocket!");
                         resolve();
                     };
                     listenerProvider._websocket.onerror = (err) => {
                         logger.error("🔌 [المستمع] خطأ WebSocket داخلي!", err);
                         reject(err);
                     };
                 } else {
                      logger.warn("[المستمع] _websocket internal property not found.");
                      // This might hang if only 'close' occurs without 'error'
                 }
            });

        } catch (error) {
            logger.error(`🔌 [المستمع] فشل الاتصال أو خطأ فادح: ${error.message}.`);
            cleanup();
            logger.info(`🔌 [المستمع] المحاولة مرة أخرى بعد ${reconnectDelay / 1000} ثانية...`);
            await sleep(reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
        } finally {
            cleanup();
        }
    }
}

/**
 * [معدل v12.1] معالج قائمة المراقبة - تطبيق بروتوكول الصقر الحكيم
 */
async function processPotentialTrades() {
    logger.info(`[معالج v12.1] بدأ. (مراقبة ${potentialTrades.size} عملة)`);

    while (true) {
        try {
            if (config.IS_PAUSED || potentialTrades.size === 0) {
                await sleep(60 * 1000);
                continue;
            }

            lastPairsFound = potentialTrades.size;
            const now = Date.now();

            for (const [tokenAddress, data] of potentialTrades.entries()) {
                const ageMinutes = (now - data.foundAt) / (1000 * 60);

                // الانتظار حتى تصل العملة للحد الأدنى للعمر
                if (ageMinutes < config.MIN_AGE_MINUTES) {
                    continue; // ما زالت صغيرة، انتقل للتالية
                }

                // تجاهل العملات القديمة جدًا
                if (ageMinutes > (config.MAX_AGE_HOURS * 60)) {
                    logger.warn(`[معالج] ${tokenAddress.slice(0,10)} قديمة جدًا (${ageMinutes.toFixed(1)} د). إزالة.`);
                    potentialTrades.delete(tokenAddress);
                    continue;
                }

                // منع إعادة المعالجة في نفس الدورة
                if (processedPairs.has(data.pairAddress)) {
                    continue;
                }
                processedPairs.add(data.pairAddress); // ضع علامة "قيد المعالجة لهذه الدورة"

                logger.info(`\n\n[معالج] ${tokenAddress.slice(0,10)} (${ageMinutes.toFixed(1)} د). بدء بروتوكول الصقر الحكيم...`);

                // --- الخطوة 1: فحص النبض (Viability Check) ---
                logger.info(`[معالج] -> الخطوة 1: فحص النبض...`);
                const viabilityCheck = await checkDexScreenerViability(data.pairAddress, tokenAddress);
                if (!viabilityCheck.passed) {
                    logger.warn(`[معالج] ❌ ${tokenAddress.slice(0,10)} - ${viabilityCheck.reason}. إزالة.`);
                    potentialTrades.delete(tokenAddress);
                    processedPairs.delete(data.pairAddress); // إزالة العلامة للسماح بفحص DexScreener مرة أخرى لاحقًا إذا كان خطأ مؤقتًا
                    continue; // انتقل للعملة التالية
                }
                // (نجح فحص النبض)

                // --- الخطوة 2: الفحص الأمني العميق (Deep Security Check) ---
                logger.info(`[معالج] -> الخطوة 2: الفحص الأمني العميق...`);
                const securityCheck = await fullCheck(data.pairAddress, tokenAddress);
                if (!securityCheck.passed) {
                    logger.warn(`[معالج] ❌ ${tokenAddress.slice(0,10)} - ${securityCheck.reason}. إزالة.`);
                    potentialTrades.delete(tokenAddress); // فشل أمني = إزالة نهائية
                     if (config.DEBUG_MODE) await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>❌ مرفوض (فحص أمني)</b>\n<code>${tokenAddress}</code>\n<b>السبب:</b> ${securityCheck.reason}`, { parse_mode: 'HTML' });
                    continue; // انتقل للعملة التالية
                }
                // (نجح الفحص الأمني)

                // --- الخطوة 3: الانقضاض المحسوب (Calculated Strike) ---
                logger.info(`[معالج] -> الخطوة 3: الانقضاض المحسوب...`);
                if (isWiseHawkHunting) {
                    logger.info(`⏳ ${tokenAddress.slice(0,10)} ينتظر (البوت مشغول بشراء آخر).`);
                    processedPairs.delete(data.pairAddress); // السماح بإعادة المحاولة في الدورة التالية
                    continue; // تخطى هذه العملة مؤقتًا
                }
                isWiseHawkHunting = true; // اقفل الصيد

                const viabilityReason = viabilityCheck.reason || ''; // الحصول على تفاصيل فحص النبض للرسالة
                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>🚀 فرصة مؤكدة!</b>\n<code>${tokenAddress}</code>\n(${ageMinutes.toFixed(0)}د | ${viabilityReason})\n✅ اجتاز فحص النبض والدرع.\n⏳ شراء...`, { parse_mode: 'HTML' });

                try {
                    // الخطوة 4 (جزء منها): تنفيذ الشراء وإدارة ما بعد الشراء (داخل snipeToken)
                    await snipeToken(data.pairAddress, tokenAddress);
                    // إذا نجح snipeToken، سيتم تحديث isWiseHawkHunting = false داخله أو بعده
                } catch (e) {
                    logger.error(`Error during snipeToken call: ${e}`);
                    isWiseHawkHunting = false; // تأكد من تحرير القفل عند حدوث خطأ فادح هنا
                } finally {
                     potentialTrades.delete(tokenAddress); // إزالة من قائمة المراقبة بعد محاولة الشراء (سواء نجحت أو فشلت)
                     // لا نزيل processedPairs هنا، لأننا حاولنا بالفعل الشراء
                }
                 // --- نهاية الخطوة 3 و 4 ---

            } // نهاية حلقة for

        } catch (error) {
            logger.error(`❌ خطأ حلقة المعالج الرئيسية: ${error.message}`, error);
        } finally {
            processedPairs.clear(); // مسح علامات "قيد المعالجة" لبدء دورة جديدة نظيفة
        }

        if(potentialTrades.size > 0) logger.info(`[معالج] اكتمل فحص الدورة. (متبقي ${potentialTrades.size} للمراقبة). انتظار 1 دقيقة...`);
        await sleep(60 * 1000); // فحص كل دقيقة
    }
}


// =================================================================
// 7. الدالة الرئيسية (Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل (v12.1 - بروتوكول الصقر الحكيم) ---`); // <-- تحديث هنا
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);

        loadTradesFromFile(); logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة.`);
        const network = await provider.getNetwork(); logger.info(`✅ متصل بـ (RPC: ${network.name}, ID: ${network.chainId})`);

        const welcomeMsg = `✅ <b>راصد (v12.1 - بروتوكول الصقر الحكيم) بدأ!</b>`; // <-- تحديث هنا
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        // --- معالجات التليجرام ---
        telegram.on('message', async (msg) => {
            const chatId = msg.chat.id; if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId]?.awaiting) {
                const settingKey = userState[chatId].awaiting; delete userState[chatId]; const valueStr = msg.text.trim();
                try {
                    let newValue;
                    // تحديد النوع بناءً على المفتاح
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                        newValue = parseFloat(valueStr);
                    } else { // الافتراضي هو عدد صحيح
                        newValue = parseInt(valueStr, 10);
                    }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");
                    config[settingKey] = newValue; logger.info(`⚙️ ${settingKey} -> ${newValue}.`);
                    await telegram.sendMessage(chatId, `✅ <b>${settingKey}</b> -> <code>${newValue}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch { await telegram.sendMessage(chatId, "❌ قيمة غير صالحة.", { reply_markup: getMainMenuKeyboard() }); } return;
            }
            // باقي الأوامر النصية
            const text = msg.text;
            if (text === '⏸️ إيقاف البحث' || text === '▶️ استئناف البحث') { config.IS_PAUSED = !config.IS_PAUSED; await telegram.sendMessage(chatId, `ℹ️ البحث: <b>${config.IS_PAUSED ? "موقوف⏸️" : "نشط▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '🟢 تفعيل التصحيح' || text === '⚪️ إيقاف التصحيح') { config.DEBUG_MODE = !config.DEBUG_MODE; logger.level = config.DEBUG_MODE ? 'info' : 'info'; await telegram.sendMessage(chatId, `ℹ️ التصحيح: <b>${config.DEBUG_MODE ? "فعّال🟢" : "OFF⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '📊 الحالة') await showStatus(chatId).catch(e => logger.error(`[showStatus] ${e.message}`));
            else if (text === '🔬 التشخيص') showDiagnostics(chatId); else if (text === '⚙️ الإعدادات') showSettingsMenu(chatId);
            else if (text === '💰 بيع يدوي') showManualSellMenu(chatId); else if (text === '🔄 تصفير البيانات') showResetConfirmation(chatId);
        });
        telegram.on('callback_query', async (query) => { /* ... نفس الكود من v11.2 ... */
            const chatId = query.message.chat.id; const data = query.data; try { await query.answer(); } catch {}
            if (data === 'confirm_reset') { try { activeTrades.length = 0; if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE); isWiseHawkHunting = false; processedPairs.clear(); potentialTrades.clear(); logger.info("🔄 تم التصفير."); await telegram.editMessageText("✅ تم.", { chat_id: chatId, message_id: query.message.message_id }); } catch (e) { logger.error(`🔄 خطأ: ${e.message}`); await telegram.editMessageText("❌ خطأ.", { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data === 'cancel_reset') await telegram.editMessageText("👍 إلغاء.", { chat_id: chatId, message_id: query.message.message_id });
            else if (data.startsWith('change_')) { const key = data.replace('change_', ''); if (SETTING_PROMPTS[key]) { userState[chatId] = { awaiting: key }; await telegram.editMessageText(SETTING_PROMPTS[key], { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data.startsWith('manual_sell_')) showSellPercentageMenu(chatId, query.message.message_id, data.replace('manual_sell_', ''));
            else if (data.startsWith('partial_sell_')) { const [_, perc, addr] = data.split('_'); if (sellingLocks.has(addr)) { try { await query.answer("⏳ بيع سابق!", { show_alert: true }); } catch {} return; } const trade = activeTrades.find(t => t.tokenAddress === addr); if (trade) { sellingLocks.add(addr); const amount = (trade.remainingAmountWei * BigInt(perc)) / 100n; await telegram.editMessageText(`⏳ بيع ${perc}%...`, { chat_id: chatId, message_id: query.message.message_id }); executeSell(trade, amount, `يدوي ${perc}%`).then(ok => { if (ok) { trade.remainingAmountWei -= amount; saveTradesToFile(); if (perc === '100' || trade.remainingAmountWei <= 0n) removeTrade(trade); } }).finally(() => sellingLocks.delete(addr)); } else { try { await query.answer("غير موجودة!", { show_alert: true }); } catch {} } }
        });

        // --- بدء العمليات الخلفية ---
        listenForNewPairs();
        processPotentialTrades();
        setInterval(monitorTrades, 2000);

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error.message}`, error);
        try { await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح!**\n${error.message}`, { parse_mode: 'HTML' }); } catch {}
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI) - [تحديث v12.1]
// =================================================================
function getMainMenuKeyboard() { /* ... نفس الكود ... */
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف البحث" : "⏸️ إيقاف البحث";
    const debugButtonText = config.DEBUG_MODE ? "⚪️ إيقاف التصحيح" : "🟢 تفعيل التصحيح";
    return {
        keyboard: [
            [{ text: "📊 الحالة" }, { text: pauseButtonText }],
            [{ text: "💰 بيع يدوي" }, { text: "🔬 التشخيص" }],
            [{ text: "⚙️ الإعدادات" }, { text: debugButtonText }],
            [{ text: "🔄 تصفير البيانات" }]
        ],
        resize_keyboard: true
    };
 }
async function showStatus(chatId) { /* ... نفس الكود مع تحديث الإصدار ... */
    let statusText = `<b>📊 الحالة (v12.1 - بروتوكول الصقر):</b>\n\n`; // <-- تحديث هنا
    statusText += `<b>البحث:</b> ${config.IS_PAUSED ? 'موقوف⏸️' : 'نشط▶️'} | <b>تصحيح:</b> ${config.DEBUG_MODE ? 'فعّال🟢' : 'OFF⚪️'}\n`;
    statusText += `<b>شراء:</b> ${isWiseHawkHunting ? 'مشغول🦅' : 'جاهز'} | <b>مراقبة:${potentialTrades.size}</b>\n-----------------------------------\n`;
    let bnbBalance = 0; try { bnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(config.WALLET_ADDRESS))); } catch (e) { logger.error(`[Status] خطأ رصيد BNB: ${e.message}`); }
    statusText += `<b>💰 رصيد:</b> ~${bnbBalance.toFixed(5)} BNB\n<b>📦 صفقات:</b> ${activeTrades.length}\n-----------------------------------\n`;
    if (activeTrades.length === 0) {
        statusText += "ℹ️ لا توجد صفقات نشطة.\n";
    } else {
        statusText += "<b>📈 الصفقات النشطة:</b>\n";
        activeTrades.forEach(trade => {
            statusText += `•<code>${trade.tokenAddress.slice(0, 10)}..</code>(${trade.currentProfit.toFixed(1)}%)${trade.partialTpTaken ? '(✅TP جزئي)' : ''}\n`;
        });
    }
    statusText += "-----------------------------------\n<b>⚙️ الإعدادات الحالية:</b>\n";
    statusText += `- شراء:${config.BUY_AMOUNT_BNB} BNB | وقف:${config.TRAILING_STOP_LOSS_PERCENT}% | TP:${config.PARTIAL_TP_PERCENT}%(${config.PARTIAL_TP_SELL_PERCENT}%)\n`;
    // --- تحديث v12.1: عرض إعدادات النبض ---
    statusText += `- انتظار:${config.MIN_AGE_MINUTES}د | تجاهل بعد:${config.MAX_AGE_HOURS}س\n`;
    statusText += `<b>💓 فحص النبض:</b> سيولة:$${config.MIN_LIQUIDITY_USD} | حجم:$${config.MIN_VOLUME_15M}/15د | معاملات:${config.MIN_TXNS_15M}/15د\n`;
    // --- نهاية التحديث ---
    statusText += `<b>🛡️ الدرع:</b> قفل:${config.MIN_LOCKED_LIQUIDITY_PERCENT}%|حيتان:${config.MAX_TOP_HOLDERS_PERCENT}%|مطور:${config.MAX_CREATOR_PERCENT}%|تخلي:${config.REQUIRE_OWNERSHIP_RENOUNCED ? '✅' : '❌'}`;
    await telegram.sendMessage(chatId, statusText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
 }
function showResetConfirmation(chatId) { /* ... نفس الكود ... */
     const keyboard = [
        [{ text: "❌ نعم، متأكد", callback_data: 'confirm_reset' }],
        [{ text: "✅ إلغاء", callback_data: 'cancel_reset' }]
    ];
    telegram.sendMessage(chatId, "<b>⚠️ تصفير البيانات؟</b>\nسيتم حذف سجل الصفقات النشطة وملف الحفظ وقائمة المراقبة. لا يمكن التراجع.", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
 }
function showDiagnostics(chatId) { /* ... نفس الكود ... */
    fs.readFile('sniper_bot_pro.log', 'utf8', (err, data) => {
        let logData = "لا يمكن قراءة السجل.";
        if (!err && data) {
            const lines = data.trim().split('\n');
            logData = lines.slice(-20).join('\n') || "السجل فارغ.";
        } else if (err) {
            logData = `خطأ قراءة الملف: ${err.message}`;
        }
        telegram.sendMessage(chatId, `<b>🔬 آخر 20 سطرًا من السجل:</b>\n\n<pre>${logData}</pre>`, { parse_mode: 'HTML' });
    });
 }

// --- تحديث v12.1: إضافة أزرار الإعدادات الجديدة ---
function showSettingsMenu(chatId) {
    const keyboard = [
        // الشراء والغاز
        [{ text: `💵 شراء (${config.BUY_AMOUNT_BNB})`, callback_data: 'change_BUY_AMOUNT_BNB' }, { text: `🚀 غاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }],
        // الانزلاق وسيولة BNB (للأمان)
        [{ text: `📊 انزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }, { text: `💧 سيولة BNB (${config.MINIMUM_LIQUIDITY_BNB})`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        // إدارة الصفقة
        [{ text: `📈 وقف متحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
        [{ text: `🎯 TP هدف (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }, { text: `💰 TP بيع (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }],
        // فلاتر العمر
        [{ text: `⏱️ عمر أدنى (${config.MIN_AGE_MINUTES} د)`, callback_data: 'change_MIN_AGE_MINUTES' }, { text: `⏱️ عمر أقصى (${config.MAX_AGE_HOURS} س)`, callback_data: 'change_MAX_AGE_HOURS' }],
        // --- فلاتر فحص النبض (v12.1) ---
        [{ text: `💧 نبض سيولة USD ($${config.MIN_LIQUIDITY_USD})`, callback_data: 'change_MIN_LIQUIDITY_USD' }],
        [{ text: `📊 نبض حجم/15د ($${config.MIN_VOLUME_15M})`, callback_data: 'change_MIN_VOLUME_15M' }, { text: `🔄 نبض معاملات/15د (${config.MIN_TXNS_15M})`, callback_data: 'change_MIN_TXNS_15M' }],
        // --- قسم الدرع الفولاذي ---
        [{ text: `🔒 قفل سيولة (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: 'change_MIN_LOCKED_LIQUIDITY_PERCENT' }],
        [{ text: `🐳 حيتان (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: 'change_MAX_TOP_HOLDERS_PERCENT' }, { text: `👨‍💻 مطور (${config.MAX_CREATOR_PERCENT}%)`, callback_data: 'change_MAX_CREATOR_PERCENT' }],
    ];
    telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد لتغييره:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}
// --- نهاية التحديث ---

function showManualSellMenu(chatId) { /* ... نفس الكود ... */
    if (activeTrades.length === 0) { telegram.sendMessage(chatId, "ℹ️ لا توجد صفقات نشطة."); return; }
    const keyboard = activeTrades.map(trade => ([{ text: `بيع ${trade.tokenAddress.slice(0, 6)}.. (${trade.currentProfit.toFixed(1)}%)`, callback_data: `manual_sell_${trade.tokenAddress}` }]));
    telegram.sendMessage(chatId, "<b>اختر الصفقة للإدارة:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}
function showSellPercentageMenu(chatId, messageId, tokenAddress) { /* ... نفس الكود ... */
    const keyboard = [
        [{ text: "25%", callback_data: `partial_sell_25_${tokenAddress}` }, { text: "50%", callback_data: `partial_sell_50_${tokenAddress}` }],
        [{ text: "100%", callback_data: `partial_sell_100_${tokenAddress}` }]
    ];
    telegram.editMessageText(`<b>اختر نسبة البيع لـ <code>${tokenAddress.slice(0,10)}...</code>:</b>`, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}

// --- معالجة أخطاء التليجرام العامة ---
telegram.on('polling_error', (error) => { /* ... نفس الكود ... */
    if (!error.message.includes('ETIMEDOUT') && !error.message.includes('ECONNRESET')) {
        logger.error(`[خطأ تليجرام] ${error.code}: ${error.message}`);
    }
});

// --- بدء تشغيل البوت ---
main();
