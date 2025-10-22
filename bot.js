// =================================================================
// صياد الدرر: v9.4 (راصد الزخم الآمن - استهداف 30د-6س)
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
    GAS_PRIORITY_MULTIPLIER: parseInt(process.env.GAS_PRIORITY_MULTIPLIER || '2', 10),
    SLIPPAGE_LIMIT: parseInt(process.env.SLIPPAGE_LIMIT || '49', 10),
    GAS_LIMIT: BigInt(process.env.GAS_LIMIT || '800000'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'),
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '20', 10),
    PARTIAL_TP_PERCENT: parseInt(process.env.PARTIAL_TP_PERCENT || '100', 10),
    PARTIAL_TP_SELL_PERCENT: parseInt(process.env.PARTIAL_TP_SELL_PERCENT || '50', 10),
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '80.0'),
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '30.0'),
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '10.0'),
    REQUIRE_OWNERSHIP_RENOUNCED: process.env.REQUIRE_OWNERSHIP_RENOUNCED === 'true',
};

// --- واجهات العقود الذكية (ABIs) ---
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- تهيئة المتغيرات الرئيسية ---
let provider, wallet, routerContract;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const sellingLocks = new Set();
const processedPairs = new Set();
const processedTokens = new Set();
let isWiseHawkHunting = false;
let lastPairsFound = 0;

const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى للسيولة بالـ BNB (مثال: 5.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال نسبة البيع عند جني الأرباح الجزئي (مثال: 50):",
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 80):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إرسال الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 30):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 10):`,
};

// =================================================================
// 1. المدقق (Verifier) - الدرع الفولاذي v9.4
// =================================================================
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkTokenSecurity(tokenAddress, retry = true) {
    if (!config.GOPLUS_API_KEY) {
        logger.warn('[فحص أمني] مفتاح Go+ API غير موجود، تم تخطي الفحص الأمني.');
        return { is_safe: false, reason: "فحص أمني معطل - لا يمكن المتابعة" };
    }

    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, {
            headers: { 'X-API-KEY': config.GOPLUS_API_KEY },
            timeout: 8000
        });

        if (!response.data || !response.data.result || !response.data.result[tokenAddress.toLowerCase()]) {
            if (retry) {
                logger.warn(`[فحص أمني] لم يتم العثور على العملة ${tokenAddress.slice(0,10)}، إعادة محاولة...`);
                await sleep(2000);
                return checkTokenSecurity(tokenAddress, false);
            }
            return { is_safe: false, reason: "لم يتم العثور على العملة في Go+ بعد إعادة المحاولة" };
        }

        const result = response.data.result[tokenAddress.toLowerCase()];

        // ===== فحص 1: فخ العسل =====
        if (result.is_honeypot === '1') {
            logger.warn(`[🚨 درع] رفض ${tokenAddress.slice(0,10)}: فخ عسل واضح`);
            return { is_safe: false, reason: "فخ عسل حسب Go+" };
        }

        // ===== فحص 2: ضريبة البيع =====
        const sellTax = parseFloat(result.sell_tax || '0');
        if (sellTax > 0.25) {
            logger.warn(`[🚨 درع] رفض ${tokenAddress.slice(0,10)}: ضريبة بيع ${(sellTax * 100).toFixed(0)}%`);
            return { is_safe: false, reason: `ضريبة بيع مرتفعة (${(sellTax * 100).toFixed(0)}%)` };
        }

        // ===== فحص 3: عقد وكيل (Proxy) =====
        if (result.is_proxy === '1') {
            logger.warn(`[⚠️ درع] رفض ${tokenAddress.slice(0,10)}: عقد وكيل (Proxy)`);
            return { is_safe: false, reason: "عقد وكيل (Proxy) - خطر الترقية" };
        }

        // ===== فحص 4: قفل السيولة - محسّن =====
        let totalLockedPercent = 0;
        if (result.lp_holders && Array.isArray(result.lp_holders)) {
            for (const holder of result.lp_holders) {
                if (holder.is_locked === 1 || holder.address === '0x000000000000000000000000000000000000dead') {
                    totalLockedPercent += parseFloat(holder.percent || '0') * 100;
                }
            }
        }
        if (totalLockedPercent < config.MIN_LOCKED_LIQUIDITY_PERCENT) {
            logger.warn(`[🚨 درع] رفض ${tokenAddress.slice(0,10)}: قفل سيولة ${totalLockedPercent.toFixed(0)}% فقط`);
            return { is_safe: false, reason: `السيولة غير مقفلة كفاية (${totalLockedPercent.toFixed(0)}%)` };
        }
        logger.info(`[✅ درع] قفل السيولة: ${totalLockedPercent.toFixed(2)}%`);

        // ===== فحص 5: تركيز الحيتان =====
        let topHoldersPercent = 0;
        if (result.holders && Array.isArray(result.holders)) {
            topHoldersPercent = result.holders
                .slice(0, 10)
                .filter(h =>
                    h.address !== result.creator_address &&
                    h.address !== tokenAddress.toLowerCase() &&
                    h.address !== '0x000000000000000000000000000000000000dead'
                )
                .reduce((sum, h) => sum + parseFloat(h.percent || '0'), 0) * 100;
        } else {
            logger.warn(`[⚠️ درع] لا توجد بيانات holders لـ ${tokenAddress.slice(0,10)}`);
        }

        if (topHoldersPercent > config.MAX_TOP_HOLDERS_PERCENT) {
            logger.warn(`[🚨 درع] رفض ${tokenAddress.slice(0,10)}: تركيز حيتان ${topHoldersPercent.toFixed(0)}%`);
            return { is_safe: false, reason: `تركيز عالي للحيتان (${topHoldersPercent.toFixed(0)}%)` };
        }

        // ===== فحص 6: حصة المطور =====
        let creatorPercent = parseFloat(result.creator_percent || '0') * 100;
        if (creatorPercent === 0 && result.creator_balance && result.total_supply) {
            try {
                const creatorBalance = parseFloat(result.creator_balance);
                const totalSupply = parseFloat(result.total_supply);
                if (totalSupply > 0) creatorPercent = (creatorBalance / totalSupply) * 100;
            } catch { /* ignore */ }
        }
        if (creatorPercent > config.MAX_CREATOR_PERCENT) {
            logger.warn(`[🚨 درع] رفض ${tokenAddress.slice(0,10)}: المطور يملك ${creatorPercent.toFixed(0)}%`);
            return { is_safe: false, reason: `المطور يملك الكثير (${creatorPercent.toFixed(0)}%)` };
        }

        // ===== فحص 7: التخلي عن العقد (اختياري) =====
        if (config.REQUIRE_OWNERSHIP_RENOUNCED) {
            if (!result.owner_address || (result.owner_address && result.owner_address !== '0x0000000000000000000000000000000000000000')) {
                logger.warn(`[⚠️ درع] رفض ${tokenAddress.slice(0,10)}: لم يتم التخلي عن العقد`);
                return { is_safe: false, reason: "لم يتم التخلي عن العقد (مطلوب)" };
            }
        }

        // ===== اجتاز كل الفحوصات =====
        logger.info(`[✅✅✅ درع] ${tokenAddress.slice(0,10)} اجتاز الدرع الفولاذي!`);
        logger.info(`   ضريبة البيع: ${(sellTax * 100).toFixed(1)}% | قفل السيولة: ${totalLockedPercent.toFixed(1)}% | تركيز الحيتان: ${topHoldersPercent.toFixed(1)}% | حصة المطور: ${creatorPercent.toFixed(1)}%`);
        return { is_safe: true };

    } catch (error) {
        logger.error(`[🚨 فحص أمني] خطأ فادح لـ ${tokenAddress.slice(0,10)}: ${error.message}`);
        return { is_safe: false, reason: "خطأ فادح في API الفحص الأمني" };
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
            return { passed: false, reason: `سيولة BNB غير كافية (${wbnbLiquidity.toFixed(2)} BNB)` };
        }

        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) {
            return { passed: false, reason: securityResult.reason };
        }

        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        let decimals;
        try {
            decimals = await tokenContract.decimals();
            decimals = Number(decimals);
        } catch (e) { decimals = 18; }
        const amountIn = ethers.parseUnits("1", decimals);
        await routerContract.getAmountsOut.staticCall(amountIn, [tokenAddress, config.WBNB_ADDRESS]);

        logger.info(`[فحص] ✅ نجحت محاكاة البيع. العملة قابلة للبيع.`);
        return { passed: true, reason: "اجتاز كل الفحوصات الأمنية الشاملة (v9.4)" };
    } catch (error) {
        const isHoneypot = error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT') || error.message.includes('TransferHelper: TRANSFER_FROM_FAILED') || error.code === 'CALL_EXCEPTION';
        const reason = isHoneypot ? `فخ عسل (Honeypot) - ${error.reason || 'فشل استدعاء العقد'}` : `فشل فحص غير متوقع: ${error.reason || error.message}`;
        logger.error(`[فحص] 🚨 فشلت محاكاة البيع أو فحص آخر! السبب: ${reason}`);
        return { passed: false, reason: reason };
    }
}

// =================================================================
// 2. القناص (Sniper) - (المستثمر)
// =================================================================
async function snipeToken(pairAddress, tokenAddress) {
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) {
        logger.warn(`[استثمار] تم تجاهل الشراء، العملة ${tokenAddress} موجودة بالفعل.`);
        isWiseHawkHunting = false;
        return;
    }

    try {
        logger.info(`🚀🚀🚀 بدء عملية الاستثمار (الشراء) في: ${tokenAddress} 🚀🚀🚀`);
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
            logger.info(`[غاز] ديناميكي: الأولوية ${ethers.formatUnits(dynamicPriorityFee, 'gwei')} Gwei`);
        } else {
            txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER);
            logger.info(`[غاز] قديم: السعر ${ethers.formatUnits(txOptions.gasPrice, 'gwei')} Gwei`);
        }

        const tx = await routerContract.swapExactETHForTokens(
            minTokens, path, config.WALLET_ADDRESS,
            Math.floor(Date.now() / 1000) + 120, txOptions
        );
        logger.info(`[شراء] تم إرسال معاملة الشراء. الهاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            logger.info(`💰 نجحت عملية الشراء! تم الاستثمار في ${tokenAddress}.`);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
            let decimals;
            try {
                decimals = await tokenContract.decimals();
                decimals = Number(decimals);
            } catch (e) { decimals = 18; }

            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));
            const msg = `💰 <b>نجحت عملية الاستثمار!</b> 💰

<b>العملة:</b> <code>${tokenAddress}</code>
<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>
<b>📊 رابط الشارت:</b> <a href='https://dexscreener.com/bsc/${pairAddress}'>DexScreener</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });

            activeTrades.push({
                tokenAddress, pairAddress, buyPrice, decimals,
                initialAmountWei: amountsOut[1],
                remainingAmountWei: amountsOut[1],
                currentProfit: 0, highestProfit: 0,
                partialTpTaken: false
            });

            saveTradesToFile();
            approveMax(tokenAddress);
        } else {
            logger.error(`🚨 فشلت معاملة الشراء لـ ${tokenAddress} (الحالة 0).`);
            isWiseHawkHunting = false;
        }
    } catch (error) {
        logger.error(`❌ خطأ فادح في تنفيذ الشراء لـ ${tokenAddress}: ${error.reason || error}`);
        isWiseHawkHunting = false;
    }
}

async function approveMax(tokenAddress) {
    try {
        logger.info(`[موافقة] جاري عمل Approve لـ ${tokenAddress}...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const feeData = await provider.getFeeData();
        const txOptions = {};
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            txOptions.maxFeePerGas = feeData.maxFeePerGas;
            txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else {
            txOptions.gasPrice = feeData.gasPrice;
        }
        const tx = await tokenContract.approve(config.ROUTER_ADDRESS, ethers.MaxUint256, txOptions);
        await tx.wait();
        logger.info(`[موافقة] ✅ تمت الموافقة بنجاح لـ ${tokenAddress}`);
    } catch (error) {
        logger.error(`❌ فشلت عملية الموافقة لـ ${tokenAddress}: ${error}`);
    }
}

// =================================================================
// 3. الحارس (Guardian)
// =================================================================
async function monitorTrades() {
    if (activeTrades.length === 0) return;
    if (!routerContract) { logger.warn("[مراقبة] RouterContract غير جاهز."); return; }

    const priceChecks = activeTrades.map(trade => {
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const decimals = trade.decimals || 18;
        const oneToken = ethers.parseUnits("1", decimals);
        return routerContract.getAmountsOut.staticCall(oneToken, path).catch(err => {
            logger.warn(`[مراقبة] فشل جلب سعر ${trade.tokenAddress.slice(0,10)}: ${err.reason || err.message}`);
            return null;
        });
    });

    const results = await Promise.allSettled(priceChecks);

    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i];
        const result = results[i];

        if (result.status === 'fulfilled' && result.value !== null) {
            try {
                const amountsOut = result.value;
                const currentPrice = parseFloat(ethers.formatUnits(amountsOut[1], 18));
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit;
                trade.highestProfit = Math.max(trade.highestProfit, profit);

                if (i % 5 === 0 || config.DEBUG_MODE) {
                    logger.info(`[مراقبة] ${trade.tokenAddress.slice(0, 10)}... | الربح: ${profit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%`);
                }

                // جني الأرباح الجزئي
                if (config.PARTIAL_TP_PERCENT > 0 && profit >= config.PARTIAL_TP_PERCENT && !trade.partialTpTaken) {
                    if (sellingLocks.has(trade.tokenAddress)) continue;
                    logger.info(`🎯 [جني ربح جزئي] ${trade.tokenAddress} @ ${profit.toFixed(2)}%`);
                    sellingLocks.add(trade.tokenAddress);
                    trade.partialTpTaken = true;
                    const amountToSell = (trade.remainingAmountWei * BigInt(config.PARTIAL_TP_SELL_PERCENT)) / 100n;
                    executeSell(trade, amountToSell, `جني ربح جزئي ${config.PARTIAL_TP_SELL_PERCENT}%`)
                        .then(success => { if (success) { trade.remainingAmountWei -= amountToSell; saveTradesToFile(); } else { trade.partialTpTaken = false; } })
                        .finally(() => sellingLocks.delete(trade.tokenAddress));
                    continue;
                }

                // وقف الخسارة المتحرك
                if (trade.highestProfit > 0 && profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) {
                    if (sellingLocks.has(trade.tokenAddress)) continue;
                    logger.info(`🎯 [وقف متحرك] ${trade.tokenAddress} @ ${profit.toFixed(2)}%`);
                    sellingLocks.add(trade.tokenAddress);
                    executeSell(trade, trade.remainingAmountWei, `وقف خسارة متحرك`)
                        .then(success => { if (success) removeTrade(trade); })
                        .finally(() => sellingLocks.delete(trade.tokenAddress));
                }
            } catch (processingError) { logger.error(`[مراقبة] خطأ معالجة ${trade.tokenAddress}: ${processingError.message}`); }
        } else if (result.status === 'rejected' || result.value === null) {
            const reason = result.reason ? (result.reason.message || result.reason) : "فشل جلب السعر";
            logger.error(`[مراقبة] خطأ جلب سعر ${trade.tokenAddress}: ${reason}`);
        }
    }
}

async function executeSell(trade, amountToSellWei, reason = "يدوي") {
    if (amountToSellWei <= 0n) { logger.warn(`[بيع] محاولة بيع كمية صفر من ${trade.tokenAddress}`); return false; }

    try {
        const decimals = trade.decimals || 18;
        logger.info(`💸 [بيع] ${reason} لـ ${trade.tokenAddress}... الكمية: ${ethers.formatUnits(amountToSellWei, decimals)}`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const txOptions = { gasLimit: config.GAS_LIMIT };
        const sellPriorityMultiplier = BigInt(Math.max(1, config.GAS_PRIORITY_MULTIPLIER / 2));

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            const dynamicPriorityFee = feeData.maxPriorityFeePerGas * sellPriorityMultiplier;
            txOptions.maxFeePerGas = feeData.maxFeePerGas + (dynamicPriorityFee - feeData.maxPriorityFeePerGas);
            txOptions.maxPriorityFeePerGas = dynamicPriorityFee;
        } else { txOptions.gasPrice = feeData.gasPrice * sellPriorityMultiplier; }

        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountToSellWei, 0, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 300, txOptions
        );
        logger.info(`[بيع] تم إرسال (${reason}). هاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            const msg = `💸 <b>نجاح البيع (${reason})!</b> 💸

<code>${trade.tokenAddress}</code>
<a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            logger.info(`💰💰💰 نجاح بيع ${trade.tokenAddress}!`);
            return true;
        } else { logger.error(`🚨 فشل معاملة بيع ${trade.tokenAddress} (الحالة 0).`); }
    } catch (error) {
        const reasonText = error.reason || error.message;
        logger.error(`❌ خطأ بيع ${trade.tokenAddress}: ${reasonText}`);
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل البيع (${reason})</b> 🚨

<code>${trade.tokenAddress}</code>
<b>السبب:</b> ${reasonText}`, { parse_mode: 'HTML' });
    }
    return false;
}

// =================================================================
// 5. تخزين الصفقات النشطة (Persistence)
// =================================================================
function replacer(key, value) {
    if (typeof value === 'bigint') { return value.toString(); }
    return value;
}

function reviver(key, value) {
    if (key === 'decimals' && typeof value === 'string') { return parseInt(value, 10); }
    if (key && (key.endsWith('Wei') || key.endsWith('Amount')) && typeof value === 'string') {
        try { return BigInt(value); } catch(e) {}
    }
    return value;
}

function saveTradesToFile() {
    try {
        const dataToSave = JSON.stringify(activeTrades, replacer, 2);
        fs.writeFileSync(TRADES_FILE, dataToSave, 'utf8');
    } catch (error) { logger.error(`💾 خطأ حفظ الصفقات: ${error.message}`); }
}

function loadTradesFromFile() {
    try {
        if (fs.existsSync(TRADES_FILE)) {
            const data = fs.readFileSync(TRADES_FILE, 'utf8');
            const loadedTrades = JSON.parse(data, reviver);
            if (Array.isArray(loadedTrades)) {
                const validTrades = loadedTrades
                    .filter(t => t.tokenAddress && t.remainingAmountWei > 0n)
                    .map(t => ({ ...t, decimals: t.decimals || 18, partialTpTaken: t.partialTpTaken || false }));
                activeTrades.push(...validTrades);
            }
        } else { logger.info("💾 ملف الصفقات غير موجود."); }
    } catch (error) { logger.error(`💾 خطأ تحميل الصفقات: ${error.message}`); activeTrades.length = 0; }
}

function removeTrade(tradeToRemove) {
    const index = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress);
    if (index > -1) {
        activeTrades.splice(index, 1);
        logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress} من المراقبة.`);
        saveTradesToFile();
        isWiseHawkHunting = false;
    }
}

// =================================================================
// 6. الراصد ونقطة الانطلاق (v9.4 "راصد الزخم الآمن")
// =================================================================
async function fetchTrendingPairs() {
    if (config.IS_PAUSED) {
        logger.info('🛑 البوت متوقف مؤقتاً. تخطي البحث.');
        return [];
    }

    try {
        const url = 'https://api.dexscreener.com/latest/dex/tokens/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
        
        logger.info(`📡 جاري الاتصال بـ DexScreener...`);
        
        const response = await axios.get(url, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000
        });

        if (response.data && response.data.pairs) {
            const allPairs = response.data.pairs;
            
            const filtered = allPairs.filter(pair => {
                if (!pair.pairCreatedAt || !pair.chainId || pair.chainId !== 'bsc') return false;
                
                const age = Date.now() - (pair.pairCreatedAt * 1000);
                const ageInMinutes = age / (1000 * 60);
                const ageInHours = ageInMinutes / 60;
                
                if (ageInMinutes < 30 || ageInHours > 6) return false;
                
                const liquidityUsd = pair.liquidity?.usd || 0;
                if (liquidityUsd < 10000) return false;
                
                const volumeH1 = pair.volume?.h1 || 0;
                if (volumeH1 < 5000) return false;
                
                const txns = pair.txns?.h1 || {};
                const totalTxns = (txns.buys || 0) + (txns.sells || 0);
                if (totalTxns < 20) return false;
                
                return true;
            });
            
            lastPairsFound = filtered.length;
            logger.info(`✅ تم العثور على ${lastPairsFound} هدف محتمل (من ${allPairs.length} زوج)`);
            
            return filtered;
        }
        
        lastPairsFound = 0;
        logger.warn(`⚠️ لم يتم العثور على أزواج.`);
        return [];

    } catch (error) {
        logger.error(`❌ خطأ في الاتصال بـ DexScreener: ${error.message}`);
        lastPairsFound = 0;
        return [];
    }
}

async function processNewTarget(pair) {
    if (!pair || !pair.pairAddress || !pair.baseToken || !pair.baseToken.address || !pair.pairCreatedAt) {
        logger.warn('⚠️ بيانات الزوج غير مكتملة.');
        return;
    }

    const pairAddress = pair.pairAddress;
    const tokenAddress = pair.baseToken.address;
    
    if (processedPairs.has(pairAddress)) return;
    if (processedTokens.has(tokenAddress)) {
        logger.info(`⏭️ تم فحص ${tokenAddress.slice(0,10)} مسبقاً`);
        return;
    }
    processedTokens.add(tokenAddress);

    const liquidityUsd = pair.liquidity?.usd || 0;
    const volumeH1 = pair.volume?.h1 || 0;
    const txnsH1 = pair.txns?.h1 || {};
    const totalTxns = (txnsH1.buys || 0) + (txnsH1.sells || 0);
    const pairAgeMs = Date.now() - (pair.pairCreatedAt * 1000);
    const pairAgeMin = pairAgeMs / (1000 * 60);

    logger.info(`
🎯 عملة مرشحة! ${pair.baseToken.symbol} (${tokenAddress.slice(0, 10)}...)`);
    logger.info(`   العمر: ${pairAgeMin.toFixed(1)} دقيقة`);
    logger.info(`   السيولة: $${liquidityUsd.toFixed(0)}`);
    logger.info(`   الحجم/ساعة: $${volumeH1.toFixed(0)}`);
    logger.info(`   المعاملات/ساعة: ${totalTxns}`);
    logger.info(`   🔗 https://dexscreener.com/bsc/${pairAddress}`);

    const checkResult = await fullCheck(pairAddress, tokenAddress);

    if (checkResult.passed) {
        if (isWiseHawkHunting) {
            logger.info(`⏳ ${tokenAddress.slice(0,10)} ينتظر - البوت مشغول.`);
            return;
        }

        isWiseHawkHunting = true;

        await telegram.sendMessage(
            config.TELEGRAM_ADMIN_CHAT_ID,
            `<b>🚀 فرصة استثمار آمنة!</b>

` +
            `<b>الرمز:</b> ${pair.baseToken.symbol}
` +
            `<code>${tokenAddress}</code>
` +
            `<b>السيولة:</b> $${liquidityUsd.toFixed(0)}
` +
            `<b>الحجم/ساعة:</b> $${volumeH1.toFixed(0)}
` +
            `<b>المعاملات/ساعة:</b> ${totalTxns}
` +
            `<b>العمر:</b> ${pairAgeMin.toFixed(0)} دقيقة

` +
            `✅ اجتاز الدرع الفولاذي.
⏳ جاري محاولة الشراء...`,
            { parse_mode: 'HTML' }
        );

        try {
            await snipeToken(pairAddress, tokenAddress);
        } finally {
            // سيتم تحرير القفل في snipeToken أو removeTrade
        }
    } else {
        logger.warn(`❌ ${tokenAddress.slice(0,10)} - ${checkResult.reason}`);
        if (config.DEBUG_MODE) {
            await telegram.sendMessage(
                config.TELEGRAM_ADMIN_CHAT_ID,
                `<b>❌ مرفوض</b>
<code>${tokenAddress}</code>

<b>السبب:</b> ${checkResult.reason}`,
                { parse_mode: 'HTML' }
            );
        }
    }
}

async function pollForMomentum() {
    logger.info("🚀 [راصد الزخم الآمن] بدأ تشغيل البوت (v9.4).");
    while (true) {
        try {
            const pairs = await fetchTrendingPairs();

            for (const pair of pairs) {
                if (!processedPairs.has(pair.pairAddress)) {
                    processedPairs.add(pair.pairAddress);
                    try {
                        await processNewTarget(pair);
                        await sleep(500);
                    } catch (e) { logger.error(`❌ خطأ معالجة ${pair.pairAddress}: ${e.message}`, e); }
                }
            }
        } catch (error) { logger.error(`❌ خطأ في حلقة الراصد الرئيسية: ${error.message}`, error); }

        logger.info(`[راصد الزخم الآمن] اكتمل البحث (${lastPairsFound} هدف مكتشف). انتظار 10 دقائق...`);
        await sleep(10 * 60 * 1000);
    }
}

// =================================================================
// 7. الدالة الرئيسية (Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل بوت صياد الدرر (v9.4 - راصد الزخم الآمن) ---`);
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        loadTradesFromFile();
        logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة.`);
        const network = await provider.getNetwork();
        logger.info(`✅ متصل بـ (${network.name}, ChainID: ${network.chainId})`);
        const welcomeMsg = `✅ <b>تم تشغيل بوت راصد الزخم الآمن (v9.4) بنجاح!</b>`;
        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        telegram.on('message', async (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;

            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting;
                const newValueStr = msg.text;
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                        newValue = parseFloat(newValueStr);
                    } else {
                        newValue = parseInt(newValueStr, 10);
                    }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");

                    config[settingKey] = newValue;
                    logger.info(`⚙️ تم تغيير ${settingKey} -> ${newValue}.`);
                    await telegram.sendMessage(chatId, `✅ تم تحديث <b>${settingKey}</b> -> <code>${newValue.toString()}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch (error) {
                    await telegram.sendMessage(chatId, "❌ قيمة غير صالحة. أدخل رقم موجب.", { reply_markup: getMainMenuKeyboard() });
                } finally {
                    delete userState[chatId];
                }
                return;
            }

            const pauseText = msg.text === '⏸️ إيقاف البحث' ? '▶️ استئناف البحث' : null;
            const resumeText = msg.text === '▶️ استئناف البحث' ? '⏸️ إيقاف البحث' : null;

            if (pauseText || resumeText) {
                config.IS_PAUSED = !config.IS_PAUSED;
                await telegram.sendMessage(chatId, `ℹ️ حالة البحث الآن: <b>${config.IS_PAUSED ? "موقوف ⏸️" : "نشط ▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            } else {
                switch (msg.text) {
                    case '🟢 تفعيل التصحيح': case '⚪️ إيقاف التصحيح':
                        config.DEBUG_MODE = !config.DEBUG_MODE;
                        await telegram.sendMessage(chatId, `ℹ️ وضع التصحيح: <b>${config.DEBUG_MODE ? "فعّال 🟢" : "غير فعّال ⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                        break;
                    case '📊 الحالة': await showStatus(chatId).catch(err => logger.error(`[showStatus] ${err.message}`)); break;
                    case '🔬 التشخيص': showDiagnostics(chatId); break;
                    case '⚙️ الإعدادات': showSettingsMenu(chatId); break;
                    case '💰 بيع يدوي': showManualSellMenu(chatId); break;
                    case '🔄 تصفير البيانات': showResetConfirmation(chatId); break;
                }
            }
        });

        telegram.on('callback_query', async (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;

            try { await query.answer(); } catch {/* ignore */}

            if (data === 'confirm_reset') {
                try {
                    activeTrades.length = 0;
                    if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE);
                    isWiseHawkHunting = false;
                    logger.info("🔄 تم تصفير البيانات.");
                    await telegram.editMessageText("✅ تم تصفير الصفقات.", { chat_id: chatId, message_id: query.message.message_id });
                } catch (error) {
                    logger.error(`🔄 خطأ تصفير: ${error.message}`);
                    await telegram.editMessageText("❌ خطأ أثناء التصفير.", { chat_id: chatId, message_id: query.message.message_id });
                }
                return;
            } else if (data === 'cancel_reset') {
                await telegram.editMessageText("👍 تم الإلغاء.", { chat_id: chatId, message_id: query.message.message_id });
                return;
            }

            if (data.startsWith('change_')) {
                const settingKey = data.replace('change_', '');
                if (SETTING_PROMPTS[settingKey]) {
                    userState[chatId] = { awaiting: settingKey };
                    await telegram.editMessageText(SETTING_PROMPTS[settingKey], { chat_id: chatId, message_id: query.message.message_id });
                }
            } else if (data.startsWith('manual_sell_')) {
                showSellPercentageMenu(chatId, query.message.message_id, data.replace('manual_sell_', ''));
            } else if (data.startsWith('partial_sell_')) {
                const [_, percentage, tokenAddress] = data.split('_');
                if (sellingLocks.has(tokenAddress)) { try { await query.answer("⏳ بيع سابق جاري!", { show_alert: true }); } catch {} return; }

                const trade = activeTrades.find(t => t.tokenAddress === tokenAddress);
                if (trade) {
                    sellingLocks.add(tokenAddress);
                    const amount = (trade.remainingAmountWei * BigInt(percentage)) / 100n;
                    await telegram.editMessageText(`⏳ جاري بيع ${percentage}% من ${tokenAddress.slice(0,10)}...`, { chat_id: chatId, message_id: query.message.message_id });
                    executeSell(trade, amount, `بيع يدوي ${percentage}%`).then(success => {
                        if (success) {
                            trade.remainingAmountWei -= amount;
                            saveTradesToFile();
                            if (percentage === '100' || trade.remainingAmountWei <= 0n) removeTrade(trade);
                        }
                    }).finally(() => sellingLocks.delete(tokenAddress));
                } else { try { await query.answer("الصفقة غير موجودة!", { show_alert: true }); } catch {} }
            }
        });

        pollForMomentum();
        setInterval(monitorTrades, 2000);

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error.message}`, error);
        try { await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح أوقف البوت!** 🚨

السبب: ${error.message}

راجع السجل فوراً.`, { parse_mode: 'HTML' }); }
        catch (tgError) { logger.error(`فشل إرسال خطأ تليجرام: ${tgError.message}`); }
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI)
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
    let statusText = "<b>📊 الحالة الحالية للبوت (v9.4):</b>

";
    statusText += `<b>حالة البحث:</b> ${config.IS_PAUSED ? 'موقوف ⏸️' : 'نشط ▶️'}
`;
    statusText += `<b>وضع التصحيح:</b> ${config.DEBUG_MODE ? 'فعّال 🟢' : 'غير فعّال ⚪️'}
`;
    statusText += `<b>حالة الشراء:</b> ${isWiseHawkHunting ? 'مشغول 🦅' : 'جاهز'}
`;
    statusText += `<b>أهداف مكتشفة:</b> ${lastPairsFound}
`;
    statusText += "-----------------------------------
";

    let bnbBalance = 0;
    try { 
        bnbBalance = parseFloat(ethers.formatEther(await provider.getBalance(config.WALLET_ADDRESS))); 
    } catch (e) { logger.error(`خطأ جلب الرصيد: ${e.message}`); }
    
    statusText += `<b>💰 رصيد المحفظة:</b> ~${bnbBalance.toFixed(5)} BNB
`;
    statusText += `<b>📦 صفقات نشطة:</b> ${activeTrades.length}

`;

    if (activeTrades.length > 0) {
        statusText += "<b>📈 الصفقات النشطة:</b>
";
        for (const trade of activeTrades) {
            statusText += `
• <code>${trade.tokenAddress.slice(0, 10)}...</code>
`;
            statusText += `  الربح: ${trade.currentProfit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%
`;
        }
    } else {
        statusText += "لا توجد صفقات نشطة حالياً.
";
    }

    await telegram.sendMessage(chatId, statusText, { 
        parse_mode: 'HTML', 
        reply_markup: getMainMenuKeyboard() 
    });
}

function showResetConfirmation(chatId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ نعم، قم بالتصفير", callback_data: "confirm_reset" }],
            [{ text: "❌ إلغاء", callback_data: "cancel_reset" }]
        ]
    };
    telegram.sendMessage(chatId, "⚠️ <b>تحذير:</b>

هل تريد حقاً تصفير جميع الصفقات النشطة؟", { parse_mode: 'HTML', reply_markup: keyboard });
}

function showDiagnostics(chatId) {
    let diagText = "<b>🔬 التشخيص الفني:</b>

";
    diagText += `<b>الشبكة:</b> BSC
`;
    diagText += `<b>العنوان:</b> <code>${config.WALLET_ADDRESS}</code>
`;
    diagText += `<b>الراوتر:</b> <code>${config.ROUTER_ADDRESS}</code>

`;
    diagText += `<b>--- إعدادات الشراء ---</b>
`;
    diagText += `• مبلغ الشراء: ${config.BUY_AMOUNT_BNB} BNB
`;
    diagText += `• الانزلاق: ${config.SLIPPAGE_LIMIT}%
`;
    diagText += `• مضاعف الغاز: ${config.GAS_PRIORITY_MULTIPLIER}x

`;
    diagText += `<b>--- الدرع الفولاذي ---</b>
`;
    diagText += `• قفل السيولة الأدنى: ${config.MIN_LOCKED_LIQUIDITY_PERCENT}%
`;
    diagText += `• أقصى تركيز حيتان: ${config.MAX_TOP_HOLDERS_PERCENT}%
`;
    diagText += `• أقصى حصة مطور: ${config.MAX_CREATOR_PERCENT}%

`;
    diagText += `<b>--- إدارة المخاطر ---</b>
`;
    diagText += `• وقف الخسارة: ${config.TRAILING_STOP_LOSS_PERCENT}%
`;
    diagText += `• جني الأرباح: ${config.PARTIAL_TP_PERCENT}%
`;
    telegram.sendMessage(chatId, diagText, { parse_mode: 'HTML' });
}

function showSettingsMenu(chatId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: `مبلغ الشراء (${config.BUY_AMOUNT_BNB} BNB)`, callback_data: "change_BUY_AMOUNT_BNB" }],
            [{ text: `الانزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: "change_SLIPPAGE_LIMIT" }],
            [{ text: `مضاعف الغاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: "change_GAS_PRIORITY_MULTIPLIER" }],
            [{ text: `وقف الخسارة (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: "change_TRAILING_STOP_LOSS_PERCENT" }],
            [{ text: `جني الأرباح (${config.PARTIAL_TP_PERCENT}%)`, callback_data: "change_PARTIAL_TP_PERCENT" }],
            [{ text: `قفل السيولة (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: "change_MIN_LOCKED_LIQUIDITY_PERCENT" }],
            [{ text: `تركيز الحيتان (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: "change_MAX_TOP_HOLDERS_PERCENT" }],
            [{ text: `حصة المطور (${config.MAX_CREATOR_PERCENT}%)`, callback_data: "change_MAX_CREATOR_PERCENT" }]
        ]
    };
    telegram.sendMessage(chatId, "<b>⚙️ الإعدادات:</b>

اختر الإعداد الذي تريد تعديله:", { parse_mode: 'HTML', reply_markup: keyboard });
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
    telegram.sendMessage(chatId, "<b>💰 البيع اليدوي:</b>

اختر العملة:", { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

function showSellPercentageMenu(chatId, messageId, tokenAddress) {
    const keyboard = {
        inline_keyboard: [
            [{ text: "بيع 25%", callback_data: `partial_sell_25_${tokenAddress}` }, { text: "بيع 50%", callback_data: `partial_sell_50_${tokenAddress}` }],
            [{ text: "بيع 75%", callback_data: `partial_sell_75_${tokenAddress}` }, { text: "بيع 100%", callback_data: `partial_sell_100_${tokenAddress}` }]
        ]
    };
    telegram.editMessageText(`<b>💰 اختر نسبة البيع:</b>

<code>${tokenAddress.slice(0,10)}...</code>`, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard });
}

// تشغيل البوت
main().catch(err => {
    logger.error(`❌ خطأ فادح في تشغيل main(): ${err.message}`, err);
    process.exit(1);
});
