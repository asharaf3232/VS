// =================================================================
// صياد الدرر: v15.3 (المتتبع الذكي - المحاكي الآمن)
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

    // --- <<< [جديد v15.3] إعدادات المحاكي الآمن >>> ---
    DRY_RUN_MODE: true, // (الوضع التجريبي) افتراضي: true. شغّل فقط بفلوس وهمية
    
    // --- [v15.2] قائمة المحافظ (تُدار الآن من ملف) ---
    TRACKED_WALLETS: [], // سيتم ملؤها من ملف json
    
    // --- إعدادات الفحص الأمني (fullCheck) ---
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '1.0'),
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '85.0'),
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '30.0'),
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '5.0'),
    REQUIRE_OWNERSHIP_RENOUNCED: process.env.REQUIRE_OWNERSHIP_RENOUNCED === 'false',
    
    // --- إعدادات إدارة الصفقة ---
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '20', 10),
    PARTIAL_TP_PERCENT: parseInt(process.env.PARTIAL_TP_PERCENT || '100', 10),
    PARTIAL_TP_SELL_PERCENT: parseInt(process.env.PARTIAL_TP_SELL_PERCENT || '50', 10),
    
    // --- إعدادات التقييم (v15.2) ---
    SCORE_PROFIT_THRESHOLD: 5.0, // نسبة الربح لزيادة النقطة
    SCORE_LOSS_THRESHOLD: -15.0, // نسبة الخسارة لنقص النقطة
    
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
};

// --- ABIs الكاملة للمحلل v15.3 ---
const ROUTER_ABI = [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'
];
const FACTORY_ABI = ['function getPair(address tokenA, address tokenB) external view returns (address pair)'];
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- Global Variables ---
let provider, wallet, routerContract, factoryContract, listenerProvider;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const WALLETS_FILE = 'tracked_wallets.json'; // [جديد v15.1]
const sellingLocks = new Set();
const processedTxs = new Set(); // [جديد v15.3] لمنع معالجة نفس المعاملة المعلقة
let isWiseHawkHunting = false;
const potentialTrades = new Map();

// --- واجهات فك التشفير v15.3 ---
const routerInterface = new ethers.Interface(ROUTER_ABI);

// --- إعدادات الرسائل (v15.3) ---
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "(الفحص الأمني) يرجى إرسال الحد الأدنى لسيولة BNB (مثال: 1.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال نسبة البيع عند جني الأرباح الجزئي (مثال: 50):",
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 85):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إرسال الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 30):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 5):`,
};


// =================================================================
// 1. المدقق (Verifier) - (لا تغيير)
// (الدوال: sleep, checkTokenSecurity, fullCheck)
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
        // فحص وجود الزوج
        if (!pairAddress || pairAddress === ethers.ZeroAddress) {
             return { passed: false, reason: `فشل فحص الأمان: عنوان الزوج غير صالح.` };
        }
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
        return { passed: true, reason: "اجتاز الفحص الأمني العميق (v15.3)" };
    } catch (error) {
        const isHoneypot = error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT') || error.message.includes('TRANSFER_FROM_FAILED') || error.code === 'CALL_EXCEPTION';
        const reason = isHoneypot ? `فخ عسل (محاكاة فشلت)` : `فشل فحص غير متوقع`;
        logger.error(`[🚨 فحص أمني] فشل ${tokenAddress.slice(0,10)}: ${reason} - ${error.reason || error.message}`);
        return { passed: false, reason: reason };
    }
}

// =================================================================
// 2. القناص (Sniper) - [تعديل v15.3 للمحاكاة]
// (الدوال: snipeToken, approveMax)
// =================================================================
async function snipeToken(pairAddress, tokenAddress, triggeredByWallet) {
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) { logger.warn(`[شراء] تجاهل ${tokenAddress}, موجود.`); isWiseHawkHunting = false; return; }
    
    let simulatedAmountsOut; // [جديد v15.3] لتخزين الكميات المحاكاة

    try {
        logger.info(`🚀🚀🚀 ${config.DRY_RUN_MODE ? '[محاكاة 🟢]' : ''} شراء ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        
        // --- [تعديل v15.3] خطوة 1: جلب الكميات (ضروري لكلا الوضعين) ---
        try {
            simulatedAmountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        } catch (e) {
             logger.error(`❌ خطأ فادح (getAmountsOut) قبل الشراء لـ ${tokenAddress}: ${e.reason || e.message}`);
             isWiseHawkHunting = false;
             return; // لا يمكن المتابعة إذا فشل هذا
        }
        
        const minTokens = simulatedAmountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);

        // --- [تعديل v15.3] خطوة 2: تحديد وضع التشغيل (تجريبي أم حقيقي) ---
        
        let txHash = "DRY_RUN_SUCCESS"; // افتراضي للوضع التجريبي
        
        if (config.DRY_RUN_MODE === true) {
            // --- [الوضع التجريبي] ---
            logger.info(`[محاكاة 🟢] محاكاة الشراء (staticCall) لـ ${tokenAddress}...`);
            const feeData = await provider.getFeeData();
            const txOptions = { value: bnbAmountWei, gasLimit: config.GAS_LIMIT };
            // حساب الغاز بنفس الطريقة
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { const p = feeData.maxPriorityFeePerGas * BigInt(config.GAS_PRIORITY_MULTIPLIER); txOptions.maxFeePerGas = feeData.maxFeePerGas + (p - feeData.maxPriorityFeePerGas); txOptions.maxPriorityFeePerGas = p; }
            else { txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER); }

            // *** هذه هي المحاكاة الحقيقية ***
            // نستخدم staticCall لتنفيذ المعاملة بدون حفظها
            await routerContract.swapExactETHForTokens.staticCall(
                minTokens, path, config.WALLET_ADDRESS, 
                Math.floor(Date.now() / 1000) + 120, 
                txOptions
            );
            
            logger.info(`[محاكاة 🟢] نجحت محاكاة المعاملة (staticCall).`);
            
        } else {
            // --- [الوضع الحقيقي] ---
            const feeData = await provider.getFeeData();
            const txOptions = { value: bnbAmountWei, gasLimit: config.GAS_LIMIT };
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) { const p = feeData.maxPriorityFeePerGas * BigInt(config.GAS_PRIORITY_MULTIPLIER); txOptions.maxFeePerGas = feeData.maxFeePerGas + (p - feeData.maxPriorityFeePerGas); txOptions.maxPriorityFeePerGas = p; }
            else { txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER); }

            const tx = await routerContract.swapExactETHForTokens(minTokens, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 120, txOptions);
            logger.info(`[شراء] الإرسال.. هاش: ${tx.hash}`);
            txHash = tx.hash;
            
            const receipt = await tx.wait();
            if (receipt.status === 0) {
                 logger.error(`🚨 فشل معاملة شراء ${tokenAddress} (الحالة 0).`); 
                 isWiseHawkHunting = false;
                 return; // فشلت المعاملة الحقيقية
            }
             // الموافقة فقط في الوضع الحقيقي
             approveMax(tokenAddress);
        }

        // --- [خطوة 3: تسجيل الصفقة (لكلا الوضعين)] ---
        logger.info(`💰 نجاح ${config.DRY_RUN_MODE ? '[محاكاة 🟢]' : ''} شراء ${tokenAddress}!`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        let decimals; try { decimals = Number(await tokenContract.decimals()); } catch (e) { decimals = 18; }
        
        // نستخدم الكميات المحاكاة (simulatedAmountsOut) كسجل دقيق
        const boughtAmountWei = simulatedAmountsOut[1];
        const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(boughtAmountWei, decimals));
        
        let msg = `💰 <b>نجاح الشراء ${config.DRY_RUN_MODE ? '(تجريبي 🟢)' : '(حقيقي 🔴)'}!</b>\n<code>${tokenAddress}</code>\n`;
        if (config.DRY_RUN_MODE) {
            msg += `<b>المبلغ:</b> ~${ethers.formatUnits(boughtAmountWei, decimals).slice(0, 10)}\n<b>السعر:</b> ${buyPrice.toExponential(4)}\n`;
        } else {
             msg += `<a href='https://bscscan.com/tx/${txHash}'>BscScan</a>`;
        }
        
        if (pairAddress && pairAddress !== ethers.ZeroAddress) {
            msg += ` | <a href='https://dexscreener.com/bsc/${pairAddress}'>Chart</a>`;
        }

        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
        
        activeTrades.push({
            tokenAddress,
            pairAddress: pairAddress || '',
            buyPrice,
            decimals,
            initialAmountWei: boughtAmountWei,
            remainingAmountWei: boughtAmountWei,
            currentProfit: 0,
            highestProfit: 0,
            partialTpTaken: false,
            triggeredBy: triggeredByWallet || 'unknown' // [جديد v15.2] تسجيل مصدر الصفقة
        });
        saveTradesToFile();
        
    } catch (error) { 
        // [تعديل v15.3] التعامل مع أخطاء المحاكاة
        if (config.DRY_RUN_MODE && error.code === 'CALL_EXCEPTION') {
            logger.error(`[محاكاة 🔴] فشلت محاكاة المعاملة (staticCall)! السبب: ${error.reason || error.message}`);
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل الشراء (تجريبي 🔴)</b>\n<code>${tokenAddress}</code>\n<b>السبب:</b> ${error.reason || 'CALL_EXCEPTION'}`, { parse_mode: 'HTML' });
        } else {
            logger.error(`❌ خطأ شراء ${tokenAddress}: ${error.reason || error.message}`); 
            if (error.code === 'INSUFFICIENT_FUNDS') {
                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل الشراء: رصيد غير كافٍ!</b>`, { parse_mode: 'HTML' });
            }
        }
    } finally {
         isWiseHawkHunting = false; // تحرير القفل دائماً
    }
 }
 
async function approveMax(tokenAddress) {
    // [تعديل v15.3] لا تقم بالموافقة في الوضع التجريبي
    if (config.DRY_RUN_MODE) return; 
    
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
// 3. الحارس (Guardian) - [تعديل v15.3 للمحاكاة]
// (الدوال: monitorTrades, executeSell)
// =================================================================
async function monitorTrades() {
    if (activeTrades.length === 0 || !routerContract) return;
    
    // دالة جلب الأسعار تعمل كما هي (قراءة فقط)
    const priceChecks = activeTrades.map(trade => { const path = [trade.tokenAddress, config.WBNB_ADDRESS]; const decimals = trade.decimals || 18; const oneToken = ethers.parseUnits("1", decimals); return routerContract.getAmountsOut.staticCall(oneToken, path).catch(() => null); });
    
    const results = await Promise.allSettled(priceChecks);
    
    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i]; const result = results[i];
        if (result.status === 'fulfilled' && result.value !== null) {
            try {
                // حساب الربح يعمل كما هو
                const currentPrice = parseFloat(ethers.formatUnits(result.value[1], 18));
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit; trade.highestProfit = Math.max(trade.highestProfit, profit);
                 if (config.DEBUG_MODE) logger.info(`[مراقبة ${config.DRY_RUN_MODE ? '(تجريبي)' : ''}] ${trade.tokenAddress.slice(0, 10)} | الربح: ${profit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%`);

                // منطق جني الأرباح الجزئي
                if (config.PARTIAL_TP_PERCENT > 0 && profit >= config.PARTIAL_TP_PERCENT && !trade.partialTpTaken) { 
                    if (sellingLocks.has(trade.tokenAddress)) continue; 
                    logger.info(`🎯 [TP جزئي ${config.DRY_RUN_MODE ? '(تجريبي)' : ''}] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}%`); 
                    sellingLocks.add(trade.tokenAddress); 
                    trade.partialTpTaken = true; 
                    const amount = (trade.remainingAmountWei * BigInt(config.PARTIAL_TP_SELL_PERCENT)) / 100n; 
                    
                    executeSell(trade, amount, `TP جزئي ${config.PARTIAL_TP_SELL_PERCENT}%`).then(ok => { 
                        if (ok) { 
                            trade.remainingAmountWei -= amount; 
                            saveTradesToFile(); 
                            // [جديد v15.2] تقييم المحفظة عند جني الربح
                            updateWalletScore(trade.triggeredBy, profit);
                        } else { 
                            trade.partialTpTaken = false; // إعادة المحاولة إذا فشل البيع
                        } 
                    }).finally(() => sellingLocks.delete(trade.tokenAddress)); 
                    continue; 
                }
                
                // منطق وقف الخسارة المتحرك
                if (trade.highestProfit > 0 && profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) { 
                    if (sellingLocks.has(trade.tokenAddress)) continue; 
                    logger.info(`🎯 [وقف متحرك ${config.DRY_RUN_MODE ? '(تجريبي)' : ''}] ${trade.tokenAddress.slice(0,10)} @ ${profit.toFixed(1)}%`); 
                    sellingLocks.add(trade.tokenAddress); 
                    
                    executeSell(trade, trade.remainingAmountWei, `وقف متحرك`).then(ok => { 
                        if (ok) {
                             // [جديد v15.2] تقييم المحفظة عند وقف الخسارة
                             updateWalletScore(trade.triggeredBy, profit);
                             removeTrade(trade); 
                        }
                    }).finally(() => sellingLocks.delete(trade.tokenAddress)); 
                }
            } catch (e) { logger.error(`[مراقبة] خطأ معالجة ${trade.tokenAddress}: ${e.message}`); }
        } else if (config.DEBUG_MODE && (result.status === 'rejected' || result.value === null)) { logger.error(`[مراقبة] خطأ سعر ${trade.tokenAddress}: ${result.reason?.message || 'فشل staticCall'}`); }
    }
}

async function executeSell(trade, amountToSellWei, reason = "يدوي") {
    if (amountToSellWei <= 0n) { logger.warn(`[بيع] كمية صفر ${trade.tokenAddress}`); return false; }
    
    // [تعديل v15.3] وضع المحاكاة للبيع
    if (config.DRY_RUN_MODE === true) {
        // في الوضع التجريبي، البيع ينجح دائماً لتسجيل النتيجة
        logger.info(`💸 [محاكاة 🟢] بيع (${reason}) لـ ${trade.tokenAddress.slice(0,10)}...`);
        const msg = `💸 <b>نجاح البيع (تجريبي 🟢)</b>\n<b>العملة:</b> <code>${trade.tokenAddress}</code>\n<b>السبب:</b> ${reason}\n<b>الربح:</b> ${trade.currentProfit.toFixed(2)}%`;
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
        return true; // إرجاع نجاح وهمي
    }

    // --- [الوضع الحقيقي] ---
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
// 5. تخزين الصفقات النشطة (Persistence) - [تعديل v15.2 للتقييم]
// =================================================================
function replacer(key, value) { if (typeof value === 'bigint') return value.toString(); return value; }
function reviver(key, value) { if (key === 'decimals') return parseInt(value, 10); if (key && (key.endsWith('Wei') || key.endsWith('Amount'))) try { return BigInt(value); } catch(e) {} return value; }
function saveTradesToFile() { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(activeTrades, replacer, 2), 'utf8'); logger.info(`💾 تم حفظ ${activeTrades.length} صفقة نشطة.`); } catch (error) { logger.error(`💾 خطأ حفظ الصفقات: ${error.message}`); } }
function loadTradesFromFile() { 
    try { 
        if (fs.existsSync(TRADES_FILE)) { 
            const d = fs.readFileSync(TRADES_FILE, 'utf8'); 
            const l = JSON.parse(d, reviver); 
            if (Array.isArray(l)) { 
                const v = l.filter(t => t.tokenAddress && t.remainingAmountWei > 0n).map(t => ({ 
                    ...t, 
                    decimals: t.decimals||18, 
                    partialTpTaken: t.partialTpTaken||false,
                    triggeredBy: t.triggeredBy || 'unknown' // [جديد v15.2] تحميل المصدر
                })); 
                activeTrades.push(...v); 
            } 
        } else {
             logger.info("💾 ملف الصفقات النشطة غير موجود، بدء بقائمة فارغة.");
        }
    } catch (error) { 
        logger.error(`💾 خطأ تحميل الصفقات: ${error.message}`); activeTrades.length = 0; 
    } 
}
function removeTrade(tradeToRemove) { const i = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress); if (i > -1) { activeTrades.splice(i, 1); logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress.slice(0,10)}`); saveTradesToFile(); isWiseHawkHunting = false; } }

// --- [جديد v15.1 + v15.2] دوال إدارة المحافظ ---
function loadTrackedWallets() {
    try {
        if (fs.existsSync(WALLETS_FILE)) {
            const data = fs.readFileSync(WALLETS_FILE, 'utf8');
            const wallets = JSON.parse(data);
            if (Array.isArray(wallets)) {
                config.TRACKED_WALLETS = wallets;
                 logger.info(`💾 تم تحميل ${wallets.length} محفظة للمراقبة.`);
            } else {
                 throw new Error("ملف المحافظ تالف.");
            }
        } else {
            // [جديد v15.1] إنشاء الملف آلياً
            logger.warn(`💾 ملف ${WALLETS_FILE} غير موجود. سيتم إنشاؤه بقائمة فارغة.`);
            saveTrackedWallets(); // سيقوم بحفظ القائمة الفارغة الحالية
        }
    } catch (error) {
        logger.error(`💾 خطأ تحميل ملف المحافظ: ${error.message}`);
        config.TRACKED_WALLETS = []; // بدء بقائمة فارغة كإجراء أمان
    }
}
function saveTrackedWallets() {
    try {
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(config.TRACKED_WALLETS, null, 2), 'utf8');
        logger.info(`💾 تم حفظ ${config.TRACKED_WALLETS.length} محفظة في الملف.`);
    } catch (error) {
        logger.error(`💾 خطأ حفظ ملف المحافظ: ${error.message}`);
    }
}
function addWallet(address) {
    const cleanAddress = address.toLowerCase().trim();
    if (!ethers.isAddress(cleanAddress)) {
        return { success: false, message: "❌ عنوان غير صالح." };
    }
    if (config.TRACKED_WALLETS.some(w => w.address === cleanAddress)) {
         return { success: false, message: "ℹ️ هذه المحفظة موجودة بالفعل." };
    }
    
    // [جديد v15.2] إضافة المحفظة بنظام النقاط
    config.TRACKED_WALLETS.push({ address: cleanAddress, score: 0 });
    saveTrackedWallets();
    logger.info(`[إدارة] تمت إضافة محفظة جديدة: ${cleanAddress}`);
    return { success: true, message: `✅ تمت إضافة ${cleanAddress.slice(0, 10)}... بنجاح.` };
}
function removeWallet(address) {
     const cleanAddress = address.toLowerCase().trim();
     const initialLength = config.TRACKED_WALLETS.length;
     config.TRACKED_WALLETS = config.TRACKED_WALLETS.filter(w => w.address !== cleanAddress);
     
     if (config.TRACKED_WALLETS.length < initialLength) {
        saveTrackedWallets();
        logger.info(`[إدارة] تمت إزالة محفظة: ${cleanAddress}`);
        return { success: true, message: `🗑️ تمت إزالة ${cleanAddress.slice(0, 10)}...` };
     }
     return { success: false, message: "❌ لم يتم العثور على المحفظة." };
}
function updateWalletScore(walletAddress, profit) {
    if (!walletAddress || walletAddress === 'unknown') return;

    const wallet = config.TRACKED_WALLETS.find(w => w.address === walletAddress);
    if (!wallet) return; // المحفظة ربما تم حذفها

    let scoreChange = 0;
    if (profit >= config.SCORE_PROFIT_THRESHOLD) {
        wallet.score += 1;
        scoreChange = 1;
    } else if (profit <= config.SCORE_LOSS_THRESHOLD) {
        wallet.score -= 1;
        scoreChange = -1;
    }

    if (scoreChange !== 0) {
        logger.info(`[تقييم] تم تحديث تقييم ${walletAddress.slice(0, 6)}... إلى ${wallet.score} (الربح: ${profit.toFixed(1)}%)`);
        saveTrackedWallets();
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `📈 <b>تحديث تقييم المحفظة</b>\n<b>المحفظة:</b> <code>${walletAddress.slice(0, 10)}...</code>\n<b>النتيجة:</b> ${profit.toFixed(1)}%\n<b>التقييم الجديد:</b> ${wallet.score} (${scoreChange > 0 ? '+' : ''}${scoreChange})`, { parse_mode: 'HTML' });
    }
}


// =================================================================
// 6. الراصد ونقطة الانطلاق (v15.3 - بروتوكول متتبع المحافظ)
// =================================================================

/**
 * [معدل v15.3] معالج المعاملات التي تم تتبعها
 * يقوم بفك تشفير المعاملة وتمريرها
 */
async function processTrackedTransaction(txHash) {
    // [جديد v15.3] منع معالجة نفس الهاش عدة مرات
    if (processedTxs.has(txHash)) return;
    processedTxs.add(txHash);
    // تنظيف القائمة بشكل دوري
    if (processedTxs.size > 1000) processedTxs.clear();

    let tx;
    try {
        tx = await listenerProvider.getTransaction(txHash);
        
        if (!tx || !tx.to || !tx.from || !tx.data || tx.data === '0x') {
            return;
        }

        const fromAddress = tx.from.toLowerCase();
        
        // [تعديل v15.2] البحث في قائمة الكائنات
        const trackedWallet = config.TRACKED_WALLETS.find(w => w.address === fromAddress);

        if (trackedWallet && tx.to.toLowerCase() === config.ROUTER_ADDRESS.toLowerCase())
        {
            if(config.DEBUG_MODE) logger.info(`🔥 [متتبع] رصد معاملة من ${fromAddress.slice(0,10)}... (تقييم: ${trackedWallet.score})`);

            const decodedInput = routerInterface.parseTransaction({ data: tx.data });

            if (decodedInput.name === 'swapExactETHForTokens' || decodedInput.name === 'swapExactETHForTokensSupportingFeeOnTransferTokens') {
                
                const path = decodedInput.args.path;
                const tokenAddress = path[path.length - 1]; // العملة المستهدفة
                
                logger.info(`🎯 [متتبع] المحفظة ${fromAddress.slice(0,10)}... تشتري العملة: ${tokenAddress}`);
                
                const pairAddress = await factoryContract.getPair(tokenAddress, config.WBNB_ADDRESS);
                
                if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                    handleTrackedToken(tokenAddress, pairAddress, fromAddress);
                } else {
                    logger.warn(`[متتبع] ⚠️ فشل جلب الزوج للعملة ${tokenAddress}.`);
                }
            }
        }
    } catch (error) {
        if (error.code !== 'TRANSACTION_REPLACED' && error.code !== 'TIMEOUT' && !error.message.includes('transaction not found')) {
            logger.error(`[متتبع] ❌ خطأ فادح في معالجة ${txHash}: ${error.message}`);
        }
    }
}


/**
 * [معدل v15.1] المستمع الرئيسي للبلوكتشين (متتبع المحافظ)
 */
async function startWalletScanner() {
    logger.info("🚀 [متتبع v15.3] بدء حلقة الاتصال...");
    
    if (!config.NODE_URL || !config.NODE_URL.startsWith('ws')) {
        logger.error(`[خطأ متتبع] NODE_URL يجب أن يكون رابط WebSocket (wss://)`);
        process.exit(1);
    }
    
    let reconnectDelay = 5000;
    const maxDelay = 300000; // 5 دقائق

    while (true) {
        try {
            logger.info(`🔌 [متتبع] محاولة الاتصال بـ WebSocket (${config.NODE_URL})...`);
            listenerProvider = new ethers.WebSocketProvider(config.NODE_URL);
            await provider.getNetwork(); // التأكد من المزود الرئيسي
            
            if (config.TRACKED_WALLETS.length === 0) {
                 logger.warn(`[متتبع] ⚠️ قائمة المراقبة فارغة. قم بإضافة محافظ عبر التليجرام.`);
            } else {
                 logger.info(`[متتبع] 🎯 يراقب ${config.TRACKED_WALLETS.length} محافظ ذكية.`);
            }

            logger.info("✅ [متتبع] تم الاتصال بـ WebSocket. بدء الاستماع للمعاملات المعلقة (Pending)...");
            
            listenerProvider.on('pending', processTrackedTransaction);

            reconnectDelay = 5000; 

            await new Promise((resolve, reject) => {
                listenerProvider.on('error', (err) => {
                    logger.error(`🔌 [متتبع] خطأ Provider WebSocket! ${err.code}: ${err.message}`);
                    reject(err);
                });
                if (listenerProvider._websocket) {
                    listenerProvider._websocket.onclose = () => {
                        logger.warn("🔌 [متتبع] انقطع اتصال WebSocket!");
                        resolve(); 
                    };
                }
            });

        } catch (error) {
            logger.error(`🔌 [متتبع] فشل الاتصال أو خطأ فادح: ${error.message}.`);
        } finally {
            if (listenerProvider) {
                try {
                    listenerProvider.removeAllListeners('pending');
                    listenerProvider.removeAllListeners('error');
                    if (listenerProvider.destroy) listenerProvider.destroy();
                    if (listenerProvider._websocket) listenerProvider._websocket.terminate();
                } catch (e) {
                     logger.warn(`[متتبع] خطأ أثناء التنظيف: ${e.message}`);
                }
            }
            listenerProvider = null;
            logger.info(`🔌 [متتبع] المحاولة مرة أخرى بعد ${reconnectDelay / 1000} ثانية...`);
            await sleep(reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
        }
    }
}


/**
 * [معدل v15.2] معالج العثور على الزوج
 * الآن يمرر "المحفظة المصدر"
 */
function handleTrackedToken(tokenAddress, pairAddress, triggeredByWallet) {
    if (config.IS_PAUSED) return;

    if (activeTrades.some(t => t.tokenAddress === tokenAddress) || potentialTrades.has(tokenAddress)) {
        if (config.DEBUG_MODE) logger.info(`[متتبع] تجاهل عملة مكررة: ${tokenAddress.slice(0,10)}`);
        return;
    }
    
    logger.info(`   -> تمت إضافة [${tokenAddress.slice(0,10)}] إلى قائمة الفحص الأمني (بواسطة ${triggeredByWallet.slice(0,6)}...).`);
    potentialTrades.set(tokenAddress, { 
        pairAddress: pairAddress, 
        foundAt: Date.now(), 
        triggeredBy: triggeredByWallet // [جديد v15.2]
    });
}


/**
 * [معدل v15.2] معالج قائمة المرشحين
 * الآن يمرر "المحفظة المصدر" إلى دالة الشراء
 */
async function processPotentialTrades() {
    logger.info(`[معالج v15.3] بدأ. (مراقبة قائمة الفحص الأمني)`);

    while (true) {
        try {
            if (config.IS_PAUSED || potentialTrades.size === 0) {
                await sleep(5 * 1000); 
                continue;
            }

            for (const [tokenAddress, data] of potentialTrades.entries()) {
                
                // [تعديل v15.3] نستخدم عنوان العملة بدلاً من الزوج لمنع إعادة المعالجة
                if (processedTxs.has(tokenAddress)) {
                    continue; 
                }
                processedTxs.add(tokenAddress);

                logger.info(`\n\n[معالج] ${tokenAddress.slice(0,10)}. بدء الفحص الأمني العميق...`);
                
                const securityCheck = await fullCheck(data.pairAddress, tokenAddress);
                if (!securityCheck.passed) {
                    logger.warn(`[معالج] ❌ ${tokenAddress.slice(0,10)} - ${securityCheck.reason}. إزالة.`);
                    potentialTrades.delete(tokenAddress); 
                     if (config.DEBUG_MODE) await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>❌ مرفوض (فحص أمني)</b>\n<code>${tokenAddress}</code>\n<b>السبب:</b> ${securityCheck.reason}`, { parse_mode: 'HTML' });
                    continue; 
                }
                
                logger.info(`[معالج] -> الخطوة 2: الانقضاض...`);
                if (isWiseHawkHunting) {
                    logger.info(`⏳ ${tokenAddress.slice(0,10)} ينتظر (البوت مشغول بشراء آخر).`);
                    processedTxs.delete(tokenAddress); // السماح بإعادة المحاولة
                    continue;
                }
                isWiseHawkHunting = true; 

                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `<b>🚀 فرصة مؤكدة! (v15.3)</b>\n<code>${tokenAddress}</code>\n✅ رُصدت من ${data.triggeredBy.slice(0,6)}... واجتازت الفحص.\n⏳ شراء ${config.DRY_RUN_MODE ? '(تجريبي 🟢)' : '(حقيقي 🔴)'}...`, { parse_mode: 'HTML' });

                try {
                    // [تعديل v15.2] تمرير المحفظة المصدر
                    await snipeToken(data.pairAddress, tokenAddress, data.triggeredBy); 
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
             // [تعديل v15.3] مسح القائمة بشكل دوري وليس كل مرة
             if (processedTxs.size > 1000) processedTxs.clear();
        }

        await sleep(5 * 1000); 
    }
}


// =================================================================
// 7. الدالة الرئيسية (Main) - [تعديل v15.1]
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل (v15.3 - المتتبع الذكي - المحاكي الآمن) ---`);
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        factoryContract = new ethers.Contract(config.PANCAKE_FACTORY_ADDRESS, FACTORY_ABI, provider);

        loadTradesFromFile(); 
        loadTrackedWallets(); // [جديد v15.1] تحميل المحافظ

        const network = await provider.getNetwork(); 
        logger.info(`✅ متصل بـ (RPC: ${network.name}, ID: ${network.chainId})`);

        const welcomeMsg = `✅ <b>المتتبع الذكي (v15.3) بدأ!</b>\n<b>الوضع الحالي:</b> ${config.DRY_RUN_MODE ? 'تجريبي (آمن) 🟢' : 'حقيقي (خطر) 🔴'}`;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        // --- معالجات التليجرام ---
        telegram.on('message', async (msg) => {
            const chatId = msg.chat.id; if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            
            // --- [جديد v15.1] معالج إضافة المحافظ ---
            if (userState[chatId]?.awaiting === 'add_wallet') {
                delete userState[chatId];
                const result = addWallet(msg.text);
                await telegram.sendMessage(chatId, result.message, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                showWalletMenu(chatId); // إظهار قائمة المحافظ المحدثة
                return;
            }

            if (userState[chatId]?.awaiting) {
                const settingKey = userState[chatId].awaiting; delete userState[chatId]; const valueStr = msg.text.trim();
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                        newValue = parseFloat(valueStr);
                    } else { 
                        newValue = parseInt(valueStr, 10);
                    }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");
                    config[settingKey] = newValue; logger.info(`⚙️ ${settingKey} -> ${newValue}.`);
                    await telegram.sendMessage(chatId, `✅ <b>${settingKey}</b> -> <code>${newValue}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch { await telegram.sendMessage(chatId, "❌ قيمة غير صالحة.", { reply_markup: getMainMenuKeyboard() }); } return;
            }
            
            const text = msg.text;
            // [تعديل v15.3] أزرار جديدة للوضع التجريبي
            if (text === '🟢 تفعيل التداول الحقيقي') {
                 config.DRY_RUN_MODE = false;
                 await telegram.sendMessage(chatId, `🚨 <b>تنبيه! تم تفعيل الوضع الحقيقي 🔴</b>\nالبوت سيستخدم أموالاً حقيقية الآن!`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            }
            else if (text === '⚪️ تفعيل الوضع التجريبي') {
                 config.DRY_RUN_MODE = true;
                 await telegram.sendMessage(chatId, `✅ <b>تم تفعيل الوضع التجريبي (آمن) 🟢</b>\nالبوت لن يستخدم أموالاً حقيقية.`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            }
            // (باقي الأزرار)
            else if (text === '⏸️ إيقاف البحث' || text === '▶️ استئناف البحث') { config.IS_PAUSED = !config.IS_PAUSED; await telegram.sendMessage(chatId, `ℹ️ البحث: <b>${config.IS_PAUSED ? "موقوف⏸️" : "نشط▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '🟢 تفعيل التصحيح' || text === '⚪️ إيقاف التصحيح') { config.DEBUG_MODE = !config.DEBUG_MODE; logger.level = config.DEBUG_MODE ? 'info' : 'info'; await telegram.sendMessage(chatId, `ℹ️ التصحيح: <b>${config.DEBUG_MODE ? "فعّال🟢" : "OFF⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() }); }
            else if (text === '📊 الحالة') await showStatus(chatId).catch(e => logger.error(`[showStatus] ${e.message}`));
            else if (text === '🔬 التشخيص') showDiagnostics(chatId); 
            else if (text === '⚙️ الإعدادات') showSettingsMenu(chatId);
            else if (text === '🎯 إدارة المحافظ') showWalletMenu(chatId); // [جديد v15.1]
            else if (text === '💰 بيع يدوي') showManualSellMenu(chatId); 
            else if (text === '🔄 تصفير البيانات') showResetConfirmation(chatId);
        });
        
        telegram.on('callback_query', async (query) => {
            const chatId = query.message.chat.id; const data = query.data; try { await query.answer(); } catch {}
            
            // --- [جديد v15.1] معالجات قائمة المحافظ ---
            if (data === 'add_wallet') {
                userState[chatId] = { awaiting: 'add_wallet' };
                await telegram.editMessageText("يرجى إرسال عنوان المحفظة الذي تريد إضافته للمراقبة:", { chat_id: chatId, message_id: query.message.message_id });
                return;
            }
            if (data.startsWith('remove_wallet_')) {
                 const addressToRemove = data.replace('remove_wallet_', '');
                 const result = removeWallet(addressToRemove);
                 await telegram.sendMessage(chatId, result.message);
                 showWalletMenu(chatId, query.message.message_id); // تحديث القائمة
                 return;
            }
            if (data === 'back_to_settings') {
                 showSettingsMenu(chatId, query.message.message_id);
                 return;
            }
            // --- نهاية المعالجات الجديدة ---
            
            if (data === 'confirm_reset') { try { activeTrades.length = 0; if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE); isWiseHawkHunting = false; processedTxs.clear(); potentialTrades.clear(); logger.info("🔄 تم التصفير."); await telegram.editMessageText("✅ تم.", { chat_id: chatId, message_id: query.message.message_id }); } catch (e) { logger.error(`🔄 خطأ: ${e.message}`); await telegram.editMessageText("❌ خطأ.", { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data === 'cancel_reset') await telegram.editMessageText("👍 إلغاء.", { chat_id: chatId, message_id: query.message.message_id });
            else if (data.startsWith('change_')) { const key = data.replace('change_', ''); if (SETTING_PROMPTS[key]) { userState[chatId] = { awaiting: key }; await telegram.editMessageText(SETTING_PROMPTS[key], { chat_id: chatId, message_id: query.message.message_id }); } }
            else if (data.startsWith('manual_sell_')) showSellPercentageMenu(chatId, query.message.message_id, data.replace('manual_sell_', ''));
            else if (data.startsWith('partial_sell_')) { const [_, perc, addr] = data.split('_'); if (sellingLocks.has(addr)) { try { await query.answer("⏳ بيع سابق!", { show_alert: true }); } catch {} return; } const trade = activeTrades.find(t => t.tokenAddress === addr); if (trade) { sellingLocks.add(addr); const amount = (trade.remainingAmountWei * BigInt(perc)) / 100n; await telegram.editMessageText(`⏳ بيع ${perc}%...`, { chat_id: chatId, message_id: query.message.message_id }); executeSell(trade, amount, `يدوي ${perc}%`).then(ok => { if (ok) { trade.remainingAmountWei -= amount; saveTradesToFile(); if (perc === '100' || trade.remainingAmountWei <= 0n) { updateWalletScore(trade.triggeredBy, trade.currentProfit); removeTrade(trade); } } }).finally(() => sellingLocks.delete(addr)); } else { try { await query.answer("غير موجودة!", { show_alert: true }); } catch {} } }
        });

        // --- بدء العمليات الخلفية ---
        startWalletScanner(); // <<<--- استدعاء المتتبع الجديد v15.3
        processPotentialTrades(); 
        setInterval(monitorTrades, 2000); 

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error.message}`, error);
        try { await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح!**\n${error.message}`, { parse_mode: 'HTML' }); } catch {}
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI) - [تحديث v15.3]
// =================================================================
function getMainMenuKeyboard() {
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف البحث" : "⏸️ إيقاف البحث";
    const debugButtonText = config.DEBUG_MODE ? "⚪️ إيقاف التصحيح" : "🟢 تفعيل التصحيح";
    // [جديد v15.3] زر تبديل الوضع
    const dryRunButtonText = config.DRY_RUN_MODE ? "🟢 تفعيل التداول الحقيقي" : "⚪️ تفعيل الوضع التجريبي";

    return {
        keyboard: [
            [{ text: "📊 الحالة" }, { text: pauseButtonText }],
            [{ text: "💰 بيع يدوي" }, { text: "🔬 التشخيص" }],
            [{ text: "⚙️ الإعدادات" }, { text: "🎯 إدارة المحافظ" }],
            [{ text: debugButtonText }, { text: dryRunButtonText }],
            [{ text: "🔄 تصفير البيانات" }]
        ],
        resize_keyboard: true
    };
 }
async function showStatus(chatId) {
    let statusText = `<b>📊 الحالة (v15.3 - المتتبع الذكي):</b>\n\n`; // <-- تحديث الإصدار
    // [جديد v15.3] إظهار الوضع
    statusText += `<b>الوضع: ${config.DRY_RUN_MODE ? 'تجريبي (آمن) 🟢' : 'حقيقي (خطر) 🔴'}</b>\n`;
    statusText += `<b>البحث:</b> ${config.IS_PAUSED ? 'موقوف⏸️' : 'نشط▶️'} | <b>تصحيح:</b> ${config.DEBUG_MODE ? 'فعّال🟢' : 'OFF⚪️'}\n`;
    statusText += `<b>شراء:</b> ${isWiseHawkHunting ? 'مشغول🦅' : 'جاهز'} | <b>مرشحين:${potentialTrades.size}</b>\n-----------------------------------\n`;
    let bnbBalance = 0; try { bnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(config.WALLET_ADDRESS))); } catch (e) { logger.error(`[Status] خطأ رصيد BNB: ${e.message}`); }
    statusText += `<b>💰 رصيد:</b> ~${bnbBalance.toFixed(5)} BNB\n<b>📦 صفقات:</b> ${activeTrades.length}\n-----------------------------------\n`;
    
    // [جديد v15.3] إظهار الصفقات التجريبية
    if (activeTrades.length === 0) {
        statusText += `ℹ️ لا توجد صفقات نشطة ${config.DRY_RUN_MODE ? '(تجريبية)' : '(حقيقية)'}.\n`;
    } else {
        statusText += `<b>📈 الصفقات النشطة ${config.DRY_RUN_MODE ? '(تجريبية)' : ''}:</b>\n`;
        activeTrades.forEach(trade => {
            statusText += `•<code>${trade.tokenAddress.slice(0, 10)}..</code>(${trade.currentProfit.toFixed(1)}%)\n`;
        });
    }
    statusText += "-----------------------------------\n<b>⚙️ الإعدادات الحالية:</b>\n";
    statusText += `- شراء:${config.BUY_AMOUNT_BNB} BNB | وقف:${config.TRAILING_STOP_LOSS_PERCENT}% | TP:${config.PARTIAL_TP_PERCENT}%(${config.PARTIAL_TP_SELL_PERCENT}%)\n`;
    // [جديد v15.1] عرض إعدادات المتتبع
    statusText += `<b>🎯 فلتر المتتبع:</b> (يراقب ${config.TRACKED_WALLETS.length} محافظ)\n`;
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

// --- [معدل v15.1] واجهة الإعدادات ---
function showSettingsMenu(chatId, messageId) {
    const keyboard = [
        [{ text: `💵 شراء (${config.BUY_AMOUNT_BNB})`, callback_data: 'change_BUY_AMOUNT_BNB' }, { text: `🚀 غاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }],
        [{ text: `📊 انزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        [{ text: `📈 وقف متحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
        [{ text: `🎯 TP هدف (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }, { text: `💰 TP بيع (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }],
        [{ text: `💧 فحص سيولة BNB (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `🔒 قفل سيولة (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: 'change_MIN_LOCKED_LIQUIDITY_PERCENT' }],
        [{ text: `🐳 حيتان (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: 'change_MAX_TOP_HOLDERS_PERCENT' }, { text: `👨‍💻 مطور (${config.MAX_CREATOR_PERCENT}%)`, callback_data: 'change_MAX_CREATOR_PERCENT' }],
    ];
    
    const messageText = "<b>⚙️ اختر الإعداد لتغييره:</b>\n(لإدارة المحافظ، استخدم الزر الرئيسي 🎯)";
    
    // تعديل الرسالة إذا كانت موجودة، وإلا إرسال رسالة جديدة
    if (messageId) {
        telegram.editMessageText(messageText, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    } else {
        telegram.sendMessage(chatId, messageText, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    }
}

// --- [جديد v15.1 + v15.2] واجهة إدارة المحافظ ---
function showWalletMenu(chatId, messageId) {
    const wallets = config.TRACKED_WALLETS;
    let messageText = "<b>🎯 إدارة المحافظ:</b>\n\n";
    const keyboard = [];

    if (wallets.length === 0) {
        messageText += "ℹ️ لا توجد محافظ للمراقبة حالياً.";
    } else {
        messageText += "اختر محفظة لحذفها، أو أضف واحدة جديدة:\n";
        // [تعديل v15.2] إظهار التقييم
        wallets.sort((a, b) => b.score - a.score); // ترتيب تنازلي حسب التقييم
        
        wallets.forEach(wallet => {
            let scoreIcon = "⚪️";
            if (wallet.score > 0) scoreIcon = `✅ +${wallet.score}`;
            else if (wallet.score < 0) scoreIcon = `❌ ${wallet.score}`;
            
            keyboard.push([
                { text: `(${scoreIcon}) ${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}`, callback_data: `remove_wallet_${wallet.address}` }
            ]);
        });
    }

    // إضافة أزرار التحكم
    keyboard.push([{ text: "➕ إضافة محفظة جديدة", callback_data: "add_wallet" }]);
    keyboard.push([{ text: "🔙 العودة للإعدادات", callback_data: "back_to_settings" }]);

    if (messageId) {
        telegram.editMessageText(messageText, { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    } else {
        telegram.sendMessage(chatId, messageText, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
    }
}


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
