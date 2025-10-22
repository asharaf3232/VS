// =================================================================
// صياد الدرر: v14.0 (بروتوكول مراقب البلوكتشين)
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
    PROTECTED_RPC_URL: process.env.PROTECTED_RPC_URL, // يُستخدم للمعاملات والفحص
    NODE_URL: process.env.NODE_URL, // يجب أن يكون WSS (WebSocket) للمراقبة
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
    // --- فلتر "مراقب البلوكتشين" v14.0 ---
    MIN_LIQUIDITY_ADD_BNB: parseFloat(process.env.MIN_LIQUIDITY_ADD_BNB || '1.0'), // الحد الأدنى للسيولة المضافة في نفس الكتلة
    
    // --- إعدادات الفحص الأمني (fullCheck) ---
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '1.0'), // (فحص أمني بعد الاكتشاف)
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '85.0'),
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '30.0'),
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '5.0'),
    REQUIRE_OWNERSHIP_RENOUNCED: process.env.REQUIRE_OWNERSHIP_RENOUNCED === 'false',
    
    // --- إعدادات إدارة الصفقة ---
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '20', 10),
    PARTIAL_TP_PERCENT: parseInt(process.env.PARTIAL_TP_PERCENT || '100', 10),
    PARTIAL_TP_SELL_PERCENT: parseInt(process.env.PARTIAL_TP_SELL_PERCENT || '50', 10),
    
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
};

// --- ABIs الكاملة للمحلل v14.0 ---
const ROUTER_ABI = [
    'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'
];
const FACTORY_ABI = [
    'function createPair(address tokenA, address tokenB) external returns (address pair)',
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
];
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- Global Variables ---
let provider, wallet, routerContract, factoryContract, listenerProvider;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const sellingLocks = new Set();
const processedPairs = new Set(); // يُستخدم لمنع إعادة المعالجة في نفس الدورة
let isWiseHawkHunting = false;
const potentialTrades = new Map(); // K: tokenAddress, V: { pairAddress: string, foundAt: number }

// --- واجهات فك التشفير v14.0 ---
const factoryInterface = new ethers.Interface(FACTORY_ABI);
const routerInterface = new ethers.Interface(ROUTER_ABI);
const minLiquidityWei = ethers.parseEther(config.MIN_LIQUIDITY_ADD_BNB.toString());

// --- إعدادات الرسائل (v14.0) ---
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MIN_LIQUIDITY_ADD_BNB": `(فلتر المراقب) يرجى إرسال الحد الأدنى لسيولة BNB المضافة (مثال: 1.0):`,
    "MINIMUM_LIQUIDITY_BNB": "(الفحص الأمني) يرجى إرسال الحد الأدنى لسيولة BNB (مثال: 1.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال نسبة البيع عند جني الأرباح الجزئي (مثال: 50):",
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 85):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إrsal الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 30):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 5):`,
};


// =================================================================
// 1. المدقق (Verifier) - (لا تغيير)
// =================================================================
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function checkTokenSecurity(tokenAddress, retry = true) {
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
async function fullCheck(pairAddress, tokenAddress) {
    try {
        logger.info(`[🛡️ فحص أمني عميق] ${tokenAddress.slice(0,10)}...`);
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));

        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) return { passed: false, reason: `فشل فحص الأمان: سيولة BNB غير كافية (${wbnbLiquidity.toFixed(2)})` };
        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) return { passed: false, reason: `فشل فحص الأمان: ${securityResult.reason}` };

        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        let decimals; try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
        const amountIn = ethers.parseUnits("1", decimals);
        await routerContract.getAmountsOut.staticCall(amountIn, [tokenAddress, config.WBNB_ADDRESS]);
        logger.info(` -> ✅ فحص أمني عميق ناجح.`);
        return { passed: true, reason: "اجتاز الفحص الأمني العميق (v14.0)" };
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
async function snipeToken(pairAddress, tokenAddress) {
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
    } catch (error) { 
        logger.error(`❌ خطأ شراء ${tokenAddress}: ${error.reason || error.message}`); 
        if (error.code === 'INSUFFICIENT_FUNDS') {
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل الشراء: رصيد غير كافٍ!</b>\nحاول البوت شراء <code>${tokenAddress.slice(0,10)}...</code> ولكن الرصيد لا يكفي لتغطية ${config.BUY_AMOUNT_BNB} BNB + الغاز.`, { parse_mode: 'HTML' });
        }
        isWiseHawkHunting = false; 
    }
 }
async function approveMax(tokenAddress) {
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
async function monitorTrades() {
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
async function executeSell(trade, amountToSellWei, reason = "يدوي") {
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
function replacer(key, value) { if (typeof value === 'bigint') return value.toString(); return value; }
function reviver(key, value) { if (key === 'decimals') return parseInt(value, 10); if (key && (key.endsWith('Wei') || key.endsWith('Amount'))) try { return BigInt(value); } catch(e) {} return value; }
function saveTradesToFile() { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(activeTrades, replacer, 2), 'utf8'); logger.info(`💾 تم حفظ ${activeTrades.length} صفقة.`); } catch (error) { logger.error(`💾 خطأ حفظ: ${error.message}`); } }
function loadTradesFromFile() { try { if (fs.existsSync(TRADES_FILE)) { const d = fs.readFileSync(TRADES_FILE, 'utf8'); const l = JSON.parse(d, reviver); if (Array.isArray(l)) { const v = l.filter(t => t.tokenAddress && t.remainingAmountWei > 0n).map(t => ({ ...t, decimals: t.decimals||18, partialTpTaken: t.partialTpTaken||false })); activeTrades.push(...v); } } } catch (error) { logger.error(`💾 خطأ تحميل: ${error.message}`); activeTrades.length = 0; } }
function removeTrade(tradeToRemove) { const i = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress); if (i > -1) { activeTrades.splice(i, 1); logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress.slice(0,10)}`); saveTradesToFile(); isWiseHawkHunting = false; } }

// =================================================================
// 6. الراصد ونقطة الانطلاق (v14.0 - بروتوكول مراقب البلوكتشين)
// =================================================================

/**
 * [جديد v14.0] معالج الكتلة
 * يتم استدعاؤه لكل كتلة جديدة بواسطة المستمع
 */
async function processBlock(blockNumber) {
    if (config.IS_PAUSED) return;
    
    let block;
    try {
        // جلب الكتلة كاملة مع جميع معاملاتها
        block = await listenerProvider.getBlock(blockNumber, true); // true لـ prefetch transactions
        if (!block || !block.transactions) {
            if (config.DEBUG_MODE) logger.warn(`[مراقب] لم يتم العثور على معاملات في الكتلة ${blockNumber}.`);
            return;
        }
    } catch (error) {
        logger.error(`[مراقب] ❌ فشل جلب الكتلة ${blockNumber}: ${error.message}`);
        return;
    }

    if (config.DEBUG_MODE) logger.info(`[مراقب] ... معالجة الكتلة ${blockNumber} (مع ${block.transactions.length} معاملة)`);

    const createdTokensInBlock = new Set();
    const liquidityAddedInBlock = new Map(); // K: tokenAddress (lower), V: bnbValue (BigInt)
    const wbnbLower = config.WBNB_ADDRESS.toLowerCase();
    const factoryLower = config.PANCAKE_FACTORY_ADDRESS.toLowerCase();
    const routerLower = config.ROUTER_ADDRESS.toLowerCase();

    for (const txHash of block.transactions) {
        // txHash هو مجرد الهاش، نحتاج المعاملة الكاملة
        const tx = txHash; // بما أننا استخدمنا prefetch، tx هو الكائن الكامل
        
        if (!tx.to || !tx.data || tx.data === '0x') continue;

        const txTo = tx.to.toLowerCase();

        try {
            // --- المرحلة 1: البحث عن إنشاء زوج ---
            if (txTo === factoryLower) {
                const parsedTx = factoryInterface.parseTransaction(tx);
                if (parsedTx && parsedTx.name === 'createPair') {
                    const tokenA = parsedTx.args[0].toLowerCase();
                    const tokenB = parsedTx.args[1].toLowerCase();
                    
                    // تحديد العملة (ليست WBNB)
                    if (tokenA === wbnbLower) {
                        createdTokensInBlock.add(tokenB);
                    } else if (tokenB === wbnbLower) {
                        createdTokensInBlock.add(tokenA);
                    }
                }
            }

            // --- المرحلة 2: البحث عن إضافة سيولة ---
            if (txTo === routerLower) {
                const parsedTx = routerInterface.parseTransaction(tx);
                
                // البحث فقط عن addLiquidityETH التي تحمل قيمة BNB
                if (parsedTx && parsedTx.name === 'addLiquidityETH' && tx.value > 0n) {
                    const tokenAddress = parsedTx.args[0].toLowerCase(); // أول وسيط هو عنوان العملة
                    
                    // التحقق من الحد الأدنى للسيولة المضافة
                    if (tx.value >= minLiquidityWei) {
                         if (config.DEBUG_MODE) logger.info(`[مراقب] 💧 إضافة سيولة مكتشفة لـ ${tokenAddress.slice(0,10)} [${ethers.formatEther(tx.value)} BNB]`);
                        liquidityAddedInBlock.set(tokenAddress, tx.value);
                    }
                }
            }
        } catch (e) {
            // تجاهل أخطاء فك التشفير (لمعاملات لا تهمنا)
        }
    }

    // --- المرحلة 3: "الربط الذكي" ---
    if (createdTokensInBlock.size === 0 || liquidityAddedInBlock.size === 0) {
        return; // لا يوجد شيء للربط في هذه الكتلة
    }

    for (const tokenAddress of createdTokensInBlock) {
        if (liquidityAddedInBlock.has(tokenAddress)) {
            // 🎉🎉🎉 وجدنا واحد! 🎉🎉🎉
            // تم إنشاء الزوج وإضافة السيولة له في نفس الكتلة
            
            const liquidityAmount = liquidityAddedInBlock.get(tokenAddress);
            logger.info(`\n\n🎉 [مراقب ذكي] فرصة مؤكدة!`);
            logger.info(`   العملة: ${tokenAddress}`);
            logger.info(`   السيولة المضافة: ${ethers.formatEther(liquidityAmount)} BNB`);

            // الآن نحتاج إلى جلب عنوان الزوج
            try {
                const pairAddress = await factoryContract.getPair(tokenAddress, config.WBNB_ADDRESS);
                if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                    logger.info(`   الزوج: ${pairAddress}`);
                    // تمريرها إلى المعالج
                    handleCorrelatedPair(tokenAddress, pairAddress);
                } else {
                    logger.warn(`[مراقب] ⚠️ تم العثور على ${tokenAddress} ولكن فشل جلب الزوج.`);
                }
            } catch (e) {
                logger.error(`[مراقب] ❌ خطأ جلب الزوج لـ ${tokenAddress}: ${e.message}`);
            }
        }
    }
}


/**
 * [جديد v14.0] المستمع الرئيسي للبلوكتشين
 */
async function monitorBlockchain() {
    logger.info("🚀 [مراقب v14.0] بدء حلقة الاتصال...");
    
    if (!config.NODE_URL || !config.NODE_URL.startsWith('ws')) {
        logger.error(`[خطأ مراقب] NODE_URL يجب أن يكون رابط WebSocket (wss://)`);
        process.exit(1);
    }
    
    let reconnectDelay = 5000;
    const maxDelay = 300000; // 5 دقائق

    while (true) {
        try {
            logger.info(`🔌 [مراقب] محاولة الاتصال بـ WebSocket (${config.NODE_URL})...`);
            // مزود منفصل للاستماع
            listenerProvider = new ethers.WebSocketProvider(config.NODE_URL);
            
            // التأكد من أن المزود الرئيسي (للمعاملات) يعمل أيضاً
            await provider.getNetwork();
            
            // عقد المصنع (لجلب عنوان الزوج)
            factoryContract = new ethers.Contract(config.PANCAKE_FACTORY_ADDRESS, FACTORY_ABI, provider);

            logger.info("✅ [مراقب] تم الاتصال بـ WebSocket. بدء الاستماع للكتل...");
            
            listenerProvider.on('block', processBlock);

            reconnectDelay = 5000; // إعادة ضبط التأخير عند الاتصال الناجح

            // البقاء على قيد الحياة حتى يحدث خطأ
            await new Promise((resolve, reject) => {
                listenerProvider.on('error', (err) => {
                    logger.error(`🔌 [مراقب] خطأ Provider WebSocket! ${err.code}: ${err.message}`);
                    reject(err);
                });
                if (listenerProvider._websocket) {
                    listenerProvider._websocket.onclose = () => {
                        logger.warn("🔌 [مراقب] انقطع اتصال WebSocket!");
                        resolve(); // الخروج من الوعد لإعادة الاتصال
                    };
                }
            });

        } catch (error) {
            logger.error(`🔌 [مراقب] فشل الاتصال أو خطأ فادح: ${error.message}.`);
        } finally {
            // تنظيف المستمعين
            if (listenerProvider) {
                try {
                    listenerProvider.removeAllListeners('block');
                    listenerProvider.removeAllListeners('error');
                    if (listenerProvider.destroy) listenerProvider.destroy();
                    if (listenerProvider._websocket) listenerProvider._websocket.terminate();
                } catch (e) {
                     logger.warn(`[مراقب] خطأ أثناء التنظيف: ${e.message}`);
                }
            }
            listenerProvider = null;
            logger.info(`🔌 [مراقب] المحاولة مرة أخرى بعد ${reconnectDelay / 1000} ثانية...`);
            await sleep(reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
        }
    }
}


/**
 * [معدل v14.0] معالج العثور على الزوج
 * يتم استدعاؤه الآن فقط بواسطة "الربط الذكي"
 */
function handleCorrelatedPair(tokenAddress, pairAddress) {
    if (config.IS_PAUSED) return;

    if (activeTrades.some(t => t.tokenAddress === tokenAddress) || potentialTrades.has(tokenAddress)) {
        if (config.DEBUG_MODE) logger.info(`[مراقب] تجاهل عملة مكررة: ${tokenAddress.slice(0,10)}`);
        return;
    }
    
    logger.info(`   -> تمت الإضافة إلى قائمة الفحص الأمني.\n`);
    potentialTrades.set(tokenAddress, { pairAddress: pairAddress, foundAt: Date.now() });
}


/**
 * [معدل v14.0] معالج قائمة المرشحين
 * الآن يقوم فقط بالفحص الأمني والشراء
 */
async function processPotentialTrades() {
    logger.info(`[معالج v14.0] بدأ. (مراقبة قائمة الفحص الأمني)`);

    while (true) {
        try {
            if (config.IS_PAUSED || potentialTrades.size === 0) {
                await sleep(5 * 1000); // انتظار 5 ثواني إذا كانت القائمة فارغة
                continue;
            }

            for (const [tokenAddress, data] of potentialTrades.entries()) {
                
                if (processedPairs.has(data.pairAddress)) {
                    continue;
                }
                processedPairs.add(data.pairAddress);

                logger.info(`\n\n[معالج] ${tokenAddress.slice(0,10)}. بدء الفحص الأمني العميق...`);
                
                // --- الخطوة 1: الفحص الأمني العميق ---
                const securityCheck = await fullCheck(data.pairAddress, tokenAddress);
                if (!securityCheck.passed) {
                    logger.warn(`[معالج] ❌ ${tokenAddress.slice(0,10)} - ${securityCheck.reason}. إزالة.`);
                    potentialTrades.delete(tokenAddress); 
                     if (config.DEBUG_MODE) await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>❌ مرفوض (فحص أمني)</b>\n<code>${tokenAddress}</code>\n<b>السبب:</b> ${securityCheck.reason}`, { parse_mode: 'HTML' });
                    continue; 
                }
                // (نجح الفحص الأمني)

                // --- الخطوة 2: الانقضاض ---
                logger.info(`[معالج] -> الخطوة 2: الانقضاض...`);
                if (isWiseHawkHunting) {
                    logger.info(`⏳ ${tokenAddress.slice(0,10)} ينتظر (البوت مشغول بشراء آخر).`);
                    processedPairs.delete(data.pairAddress); // السماح بإعادة المحاولة
                    continue;
                }
                isWiseHawkHunting = true; 

                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>🚀 فرصة مؤكدة! (v14.0)</b>\n<code>${tokenAddress}</code>\n✅ اجتاز مراقبة الكتلة والفحص الأمني.\n⏳ شراء...`, { parse_mode: 'HTML' });

                try {
                    await snipeToken(data.pairAddress, tokenAddress);
                } catch (e) {
                    logger.error(`Error during snipeToken call: ${e}`);
                    isWiseHawkHunting = false; 
                } finally {
                     potentialTrades.delete(tokenAddress); 
                }
            } 

        } catch (error) {
            logger.error(`❌ خطأ حلقة المعالج الرئيسية: ${error.message}`, error);
        } finally {
            processedPairs.clear(); 
        }

        await sleep(5 * 1000); // فحص القائمة كل 5 ثواني
    }
}


// =================================================================
// 7. الدالة الرئيسية (Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل (v14.0 - بروتوكول مراقب البلوكتشين) ---`);
    try {
        // المزود الرئيسي (للمعاملات والفحص)
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);

        loadTradesFromFile(); logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة.`);
        const network = await provider.getNetwork(); logger.info(`✅ متصل بـ (RPC: ${network.name}, ID: ${network.chainId})`);

        const welcomeMsg = `✅ <b>مراقب البلوكتشين (v14.0) بدأ!</b>`;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        // --- معالجات التليجرام ---
        telegram.on('message', async (msg) => {
            const chatId = msg.chat.id; if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId]?.awaiting) {
                const settingKey = userState[chatId].awaiting; delete userState[chatId]; const valueStr = msg.text.trim();
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LIQUIDITY_ADD_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                        newValue = parseFloat(valueStr);
                    } else { 
                        newValue = parseInt(valueStr, 10);
                    }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");
                    config[settingKey] = newValue; logger.info(`⚙️ ${settingKey} -> ${newValue}.`);
                    // تحديث قيمة الحد الأدنى للسيولة (Wei) إذا تم تغييرها
                    if (settingKey === 'MIN_LIQUIDITY_ADD_BNB') {
                        minLiquidityWei = ethers.parseEther(newValue.toString());
                    }
                    await telegram.sendMessage(chatId, `✅ <b>${settingKey}</b> -> <code>${newValue}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch { await telegram.sendMessage(chatId, "❌ قيمة غير صالحة.", { reply_markup: getMainMenuKeyboard() }); } return;
            }
            const text = msg.text;
            if (text === '⏸️ إيقاف البحث' || text === '▶️ استئناف البحث') { config.IS_PAUSED = !config.IS_PAUSED; await telegram.sendMessage(chatId, `ℹ️ البحث: <b>${config.IS_PAUSED ? "موقوف⏸️" : "نشط▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '🟢 تفعيل التصحيح' || text === '⚪️ إيقاف التصحيح') { config.DEBUG_MODE = !config.DEBUG_MODE; logger.level = config.DEBUG_MODE ? 'info' : 'info'; await telegram.sendMessage(chatId, `ℹ️ التصحيح: <b>${config.DEBUG_MODE ? "فعّال🟢" : "OFF⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '📊 الحالة') await showStatus(chatId).catch(e => logger.error(`[showStatus] ${e.message}`));
            else if (text === '🔬 التشخيص') showDiagnostics(chatId); else if (text === '⚙️ الإعدادات') showSettingsMenu(chatId);
            else if (text === '💰 بيع يدوي') showManualSellMenu(chatId); else if (text === '🔄 تصفير البيانات') showResetConfirmation(chatId);
        });
        telegram.on('callback_query', async (query) => {
            const chatId = query.message.chat.id; const data = query.data; try { await query.answer(); } catch {}
            if (data === 'confirm_reset') { try { activeTrades.length = 0; if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE); isWiseHawkHunting = false; processedPairs.clear(); potentialTrades.clear(); logger.info("🔄 تم التصفير."); await telegram.editMessageText("✅ تم.", { chat_id: chatId, message_id: query.message.message_id }); } catch (e) { logger.error(`🔄 خطأ: ${e.message}`); await telegram.editMessageText("❌ خطأ.", { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data === 'cancel_reset') await telegram.editMessageText("👍 إلغاء.", { chat_id: chatId, message_id: query.message.message_id });
            else if (data.startsWith('change_')) { const key = data.replace('change_', ''); if (SETTING_PROMPTS[key]) { userState[chatId] = { awaiting: key }; await telegram.editMessageText(SETTING_PROMPTS[key], { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data.startsWith('manual_sell_')) showSellPercentageMenu(chatId, query.message.message_id, data.replace('manual_sell_', ''));
            else if (data.startsWith('partial_sell_')) { const [_, perc, addr] = data.split('_'); if (sellingLocks.has(addr)) { try { await query.answer("⏳ بيع سابق!", { show_alert: true }); } catch {} return; } const trade = activeTrades.find(t => t.tokenAddress === addr); if (trade) { sellingLocks.add(addr); const amount = (trade.remainingAmountWei * BigInt(perc)) / 100n; await telegram.editMessageText(`⏳ بيع ${perc}%...`, { chat_id: chatId, message_id: query.message.message_id }); executeSell(trade, amount, `يدوي ${perc}%`).then(ok => { if (ok) { trade.remainingAmountWei -= amount; saveTradesToFile(); if (perc === '100' || trade.remainingAmountWei <= 0n) removeTrade(trade); } }).finally(() => sellingLocks.delete(addr)); } else { try { await query.answer("غير موجودة!", { show_alert: true }); } catch {} } }
        });

        // --- بدء العمليات الخلفية ---
        monitorBlockchain(); // <<<--- استدعاء المراقب الجديد v14.0
        processPotentialTrades(); 
        setInterval(monitorTrades, 2000); 

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error.message}`, error);
        try { await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح!**\n${error.message}`, { parse_mode: 'HTML' }); } catch {}
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI) - [تحديث v14.0]
// =================================================================
function getMainMenuKeyboard() {
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
async function showStatus(chatId) {
    let statusText = `<b>📊 الحالة (v14.0 - مراقب البلوكتشين):</b>\n\n`; // <-- تحديث الإصدار
    statusText += `<b>البحث:</b> ${config.IS_PAUSED ? 'موقوف⏸️' : 'نشط▶️'} | <b>تصحيح:</b> ${config.DEBUG_MODE ? 'فعّال🟢' : 'OFF⚪️'}\n`;
    statusText += `<b>شراء:</b> ${isWiseHawkHunting ? 'مشغول🦅' : 'جاهز'} | <b>مرشحين:${potentialTrades.size}</b>\n-----------------------------------\n`;
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
    // --- تحديث v14.0: عرض إعدادات المراقب ---
    statusText += `<b>🛰️ فلتر المراقب:</b> (سيولة مضافة > ${config.MIN_LIQUIDITY_ADD_BNB} BNB)\n`;
    // --- نهاية التحديث ---
    statusText += `<b>🛡️ الدرع:</b> قفل:${config.MIN_LOCKED_LIQUIDITY_PERCENT}%|حيتان:${config.MAX_TOP_HOLDERS_PERCENT}%|مطور:${config.MAX_CREATOR_PERCENT}%|تخلي:${config.REQUIRE_OWNERSHIP_RENOUNCED ? '✅' : '❌'}`;
    await telegram.sendMessage(chatId, statusText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
 }
function showResetConfirmation(chatId) {
     const keyboard = [
        [{ text: "❌ نعم، متأكد", callback_data: 'confirm_reset' }],
        [{ text: "✅ إلغاء", callback_data: 'cancel_reset' }]
    ];
    telegram.sendMessage(chatId, "<b>⚠️ تصفير البيانات؟</b>\nسيتم حذف سجل الصفقات النشطة وملف الحفظ وقائمة المرشحين. لا يمكن التراجع.", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
 }
function showDiagnostics(chatId) {
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

// --- تحديث v14.0: واجهة الإعدادات ---
function showSettingsMenu(chatId) {
    const keyboard = [
        // الشراء والغاز
        [{ text: `💵 شراء (${config.BUY_AMOUNT_BNB})`, callback_data: 'change_BUY_AMOUNT_BNB' }, { text: `🚀 غاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }],
        [{ text: `📊 انزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        // إدارة الصفقة
        [{ text: `📈 وقف متحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
        [{ text: `🎯 TP هدف (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }, { text: `💰 TP بيع (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }],
        
        // --- فلاتر المراقب والدرع (v14.0) ---
        [{ text: `🛰️ فلتر سيولة المراقب (${config.MIN_LIQUIDITY_ADD_BNB} BNB)`, callback_data: 'change_MIN_LIQUIDITY_ADD_BNB' }],
        [{ text: `💧 فحص سيولة BNB (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `🔒 قفل سيولة (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: 'change_MIN_LOCKED_LIQUIDITY_PERCENT' }],
        [{ text: `🐳 حيتان (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: 'change_MAX_TOP_HOLDERS_PERCENT' }, { text: `👨‍💻 مطور (${config.MAX_CREATOR_PERCENT}%)`, callback_data: 'change_MAX_CREATOR_PERCENT' }],
    ];
    telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد لتغييره:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}
// --- نهاية التحديث ---

function showManualSellMenu(chatId) {
    if (activeTrades.length === 0) { telegram.sendMessage(chatId, "ℹ️ لا توجد صفقات نشطة."); return; }
    const keyboard = activeTrades.map(trade => ([{ text: `بيع ${trade.tokenAddress.slice(0, 6)}.. (${trade.currentProfit.toFixed(1)}%)`, callback_data: `manual_sell_${trade.tokenAddress}` }]));
    telegram.sendMessage(chatId, "<b>اختر الصفقة للإدارة:</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}
function showSellPercentageMenu(chatId, messageId, tokenAddress) {
    const keyboard = [
        [{ text: "25%", callback_data: `partial_sell_25_${tokenAddress}` }, { text: "50%", callback_data: `partial_sell_50_${tokenAddress}` }],
        [{ text: "100%", callback_data: `partial_sell_100_${tokenAddress}` }]
    ];
    telegram.editMessageText(`<b>اختر نسبة البيع لـ <code>${tokenAddress.slice(0,10)}...</code>:</b>`, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
}

// --- معالجة أخطاء التليجرام العامة ---
telegram.on('polling_error', (error) => {
    if (!error.message.includes('ETIMEDOUT') && !error.message.includes('ECONNRESET')) {
        logger.error(`[خطأ تليجرام] ${error.code}: ${error.message}`);
    }
});

// --- بدء تشغيل البوت ---
main();
