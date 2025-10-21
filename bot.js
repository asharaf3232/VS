// =================================================================
// صياد الدرر: v9.3 (الصقر الحكيم - الدرع الفولاذي)
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
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'), // فحص السيولة المبدئي
    TRAILING_STOP_LOSS_PERCENT: parseInt(process.env.TRAILING_STOP_LOSS_PERCENT || '15', 10), // تعديل مقترح للصقر
    PARTIAL_TP_PERCENT: parseInt(process.env.PARTIAL_TP_PERCENT || '75', 10),      // تعديل مقترح للصقر
    PARTIAL_TP_SELL_PERCENT: parseInt(process.env.PARTIAL_TP_SELL_PERCENT || '50', 10), // تعديل مقترح للصقر
    DEBUG_MODE: process.env.DEBUG_MODE === 'true',
    IS_PAUSED: false,
    // <<< [تطوير v9.3] إعدادات الدرع الفولاذي >>>
    MIN_LOCKED_LIQUIDITY_PERCENT: parseFloat(process.env.MIN_LOCKED_LIQUIDITY_PERCENT || '95.0'), // نسبة قفل السيولة الدنيا
    MAX_TOP_HOLDERS_PERCENT: parseFloat(process.env.MAX_TOP_HOLDERS_PERCENT || '20.0'),       // أقصى نسبة لتركيز الحيتان
    MAX_CREATOR_PERCENT: parseFloat(process.env.MAX_CREATOR_PERCENT || '5.0'),           // أقصى نسبة للمطور
    REQUIRE_OWNERSHIP_RENOUNCED: process.env.REQUIRE_OWNERSHIP_RENOUNCED === 'true',     // هل يتطلب التخلي عن العقد؟
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
let isWiseHawkHunting = false;
let lastPairsFound = 0;
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2 يعني ضعف المقترح):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى للسيولة بالـ BNB (مثال: 5.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 15):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 75):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال النسبة المئوية للبيع عند جني الأرباح الجزئي (مثال: 50):",
    // <<< [تطوير v9.3] إضافة الإعدادات الجديدة >>>
    "MIN_LOCKED_LIQUIDITY_PERCENT": `يرجى إرسال الحد الأدنى لنسبة قفل السيولة (مثال: 95):`,
    "MAX_TOP_HOLDERS_PERCENT": `يرجى إرسال الحد الأقصى لنسبة تركيز أكبر 10 حيتان (مثال: 20):`,
    "MAX_CREATOR_PERCENT": `يرجى إرسال الحد الأقصى لنسبة ملكية المطور (مثال: 5):`,
};

// =================================================================
// 1. المدقق (Verifier) - [تطوير v9.3: درع فولاذي مُفَعَّل]
// =================================================================
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkTokenSecurity(tokenAddress, retry = true) {
    if (!config.GOPLUS_API_KEY) {
        logger.warn("[فحص أمني] مفتاح Go+ API غير موجود، تم تخطي الفحص الأمني.");
        return { is_safe: true, reason: "فحص أمني معطل" };
    }
    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY } });

        // التحقق من وجود البيانات قبل محاولة الوصول إليها
        if (!response.data || !response.data.result || !response.data.result[tokenAddress.toLowerCase()]) {
             if (retry) {
                logger.warn(`[فحص أمني] لم يتم العثور على العملة أو بيانات غير كاملة من Go+، سأنتظر 2 ثواني وأحاول مرة أخرى.`);
                await sleep(2000);
                return checkTokenSecurity(tokenAddress, false);
            }
            return { is_safe: false, reason: "لم يتم العثور على العملة في Go+ أو بيانات غير كاملة" };
        }

        const result = response.data.result[tokenAddress.toLowerCase()];

        // 1. فحص فخ العسل (Honeypot)
        if (result.is_honeypot === '1') {
             return { is_safe: false, reason: "فخ عسل حسب Go+" };
        }

        // 2. فحص ضريبة البيع
        const sellTax = parseFloat(result.sell_tax || '0');
        if (sellTax > 0.25) { // يمكن تعديل هذا الحد
             return { is_safe: false, reason: `ضريبة بيع مرتفعة جداً (${(sellTax * 100).toFixed(0)}%)` };
        }

        // 3. فحص العقد الوكيل (Proxy)
        if (result.is_proxy === '1') {
            return { is_safe: false, reason: "عقد وكيل (Proxy) - خطر الترقية" };
        }

        // --- <<< [تفعيل الدرع الفولاذي v9.3] >>> ---

        // 4. فحص قفل السيولة
        // ملاحظة: تأكد من اسم الحقل الصحيح من وثائق GoPlus API. قد يكون 'locked_lp_percentage' أو مشابه.
        // استخدمنا 'lp_holder_count' كمؤشر مؤقت إذا لم يكن الحقل المباشر متاحًا.
        let isLiquidityLocked = false;
        if (result.lp_holders) {
            for (const holder of result.lp_holders) {
                 // ابحث عن عقد قفل مشهور أو العنوان الميت
                if (holder.is_locked === 1 || holder.address === '0x000000000000000000000000000000000000dead') {
                    // تحقق من النسبة المئوية لهذا القفل
                    const holderPercent = parseFloat(holder.percent || '0') * 100;
                    if (holderPercent >= config.MIN_LOCKED_LIQUIDITY_PERCENT) {
                        isLiquidityLocked = true;
                        logger.info(`[فحص أمني] تم تأكيد قفل السيولة بنسبة ${holderPercent.toFixed(2)}% بواسطة ${holder.address}`);
                        break;
                    }
                }
            }
        }
        if (!isLiquidityLocked) {
             // تحقق من النسبة الإجمالية كحل بديل إذا لم يتم العثور على قفل كبير واحد
            const totalLockedPercent = result.lp_holders ? result.lp_holders.reduce((sum, h) => sum + (h.is_locked === 1 ? parseFloat(h.percent || '0') : 0), 0) * 100 : 0;
            if (totalLockedPercent < config.MIN_LOCKED_LIQUIDITY_PERCENT) {
                 return { is_safe: false, reason: `السيولة غير مقفلة كفاية (إجمالي مقفل: ${totalLockedPercent.toFixed(0)}%)` };
            } else {
                 logger.info(`[فحص أمني] تم تأكيد قفل السيولة (إجمالي ${totalLockedPercent.toFixed(2)}% مقفل في محافظ متعددة).`);
            }
        }


        // 5. فحص تركيز الحيتان (Top Holders)
        const topHoldersPercent = result.holders ? result.holders.reduce((sum, h, index) => sum + (index < 10 ? parseFloat(h.percent || '0') : 0), 0) * 100 : 100;
        if (topHoldersPercent > config.MAX_TOP_HOLDERS_PERCENT) {
            return { is_safe: false, reason: `تركيز عالي للحيتان (${topHoldersPercent.toFixed(0)}%)` };
        }

        // 6. فحص نسبة المطور (Creator)
        const creatorPercent = parseFloat(result.creator_balance || '0') / parseFloat(result.total_supply || '1') * 100; // حساب النسبة يدويًا إذا لم تكن متاحة مباشرة
        if (creatorPercent > config.MAX_CREATOR_PERCENT) {
            return { is_safe: false, reason: `المطور يملك الكثير (${creatorPercent.toFixed(0)}%)` };
        }

        // 7. فحص التخلي عن العقد (Renounced Ownership)
        if (config.REQUIRE_OWNERSHIP_RENOUNCED) {
            if (result.owner_address && result.owner_address !== '0x0000000000000000000000000000000000000000') {
                return { is_safe: false, reason: "لم يتم التخلي عن العقد" };
            }
        }
        // --- <<< نهاية تفعيل الدرع الفولاذي v9.3 >>> ---

        logger.info(`[فحص أمني] ✅ العملة اجتازت الفلتر الأمني الشامل (v9.3).`);
        return { is_safe: true };

    } catch (error) {
        logger.error(`[فحص أمني] 🚨 خطأ في التواصل أو تحليل بيانات Go+ API: ${error.message}`);
        return { is_safe: false, reason: "خطأ في API الفحص الأمني أو تحليل البيانات" };
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

        // محاكاة البيع (كما هي مع إصلاح BUFFER_OVERRUN)
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        let decimals;
        try {
            decimals = await tokenContract.decimals();
            decimals = Number(decimals);
        } catch (e) {
            logger.warn(`[فحص] فشل في جلب decimals لـ ${tokenAddress}، افتراضي 18`);
            decimals = 18;
        }
        const amountIn = ethers.parseUnits("1", decimals);
        await routerContract.getAmountsOut.staticCall(amountIn, [tokenAddress, config.WBNB_ADDRESS]);

        logger.info(`[فحص] ✅ نجحت محاكاة البيع. العملة قابلة للبيع.`);
        return { passed: true, reason: "اجتاز كل الفحوصات الأمنية الشاملة (v9.3)" };
    } catch (error) {
        // تحسين رسالة الخطأ لتكون أوضح
        const isHoneypot = error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT') || error.message.includes('TransferHelper: TRANSFER_FROM_FAILED') || error.code === 'CALL_EXCEPTION';
        const reason = isHoneypot ? `فخ عسل (Honeypot) - ${error.reason || error.message}` : `فشل فحص غير متوقع: ${error.reason || error.message}`;
        logger.error(`[فحص] 🚨 فشلت محاكاة البيع أو فحص آخر! السبب: ${reason}`);
        return { passed: false, reason: reason };
    }
}

// =================================================================
// 2. القناص (Sniper) - (المستثمر) - (لا تغيير)
// =================================================================
// ... (دوال snipeToken و approveMax تبقى كما هي من v9.1/v9.2)
async function snipeToken(pairAddress, tokenAddress) {
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) {
        logger.warn(`[استثمار] تم تجاهل الشراء، العملة ${tokenAddress} موجودة بالفعل في الصفقات النشطة.`);
        // <<< [تطوير v9.3] تحرير القفل إذا كانت الصفقة موجودة بالفعل >>>
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
            } catch (e) {
                logger.warn(`[Decimals] فشل في جلب decimals، الافتراضي 18: ${e.message}`);
                decimals = 18;
            }

            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));
            const msg = `💰 <b>نجحت عملية الاستثمار!</b> 💰\n\n<b>العملة:</b> <code>${tokenAddress}</code>\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>\n<b>📊 رابط الشارت:</b> <a href='https://dexscreener.com/bsc/${pairAddress}'>DexScreener</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });

            activeTrades.push({
                tokenAddress, pairAddress, buyPrice, decimals,
                initialAmountWei: amountsOut[1],
                remainingAmountWei: amountsOut[1],
                currentProfit: 0, highestProfit: 0,
                partialTpTaken: false
            });

            saveTradesToFile();
            approveMax(tokenAddress); // الموافقة لا تزال ضرورية بعد الشراء
        } else {
            logger.error(`🚨 فشلت معاملة الشراء (الحالة 0).`);
             // <<< [تطوير v9.3] تحرير القفل عند فشل المعاملة >>>
             isWiseHawkHunting = false;
        }
    } catch (error) {
        logger.error(`❌ خطأ فادح في تنفيذ الشراء: ${error.reason || error}`);
         // <<< [تطوير v9.3] تحرير القفل عند حدوث خطأ فادح >>>
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
        logger.error(`❌ فشلت عملية الموافقة: ${error}`);
    }
}


// =================================================================
// 3. الحارس (Guardian) - (لا تغيير)
// =================================================================
// ... (دوال monitorTrades و executeSell تبقى كما هي من v9.1/v9.2)
async function monitorTrades() {
    if (activeTrades.length === 0) return;

    if (!routerContract) {
        logger.warn("[مراقبة] RouterContract غير جاهز بعد، تخطي الدورة.");
        return;
    }

    const priceChecks = activeTrades.map(trade => {
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const decimals = trade.decimals || 18;
        const oneToken = ethers.parseUnits("1", decimals);
        // استخدام staticCall لتجنب استهلاك الغاز فقط لجلب السعر
        return routerContract.getAmountsOut.staticCall(oneToken, path).catch(err => {
             // التعامل مع الأخطاء المحتملة هنا، مثل فشل العقد
             logger.warn(`[مراقبة] فشل في جلب السعر لـ ${trade.tokenAddress.slice(0,10)}: ${err.reason || err.message}`);
             return null; // إرجاع null للإشارة إلى الفشل
         });
    });

    const results = await Promise.allSettled(priceChecks);

    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i];
        const result = results[i];

        // تحقق مما إذا كانت النتيجة null (بسبب خطأ في staticCall)
        if (result.status === 'fulfilled' && result.value !== null) {
            try {
                const amountsOut = result.value;
                const currentPrice = parseFloat(ethers.formatUnits(amountsOut[1], 18));
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit;
                trade.highestProfit = Math.max(trade.highestProfit, profit);

                // تقليل تكرار التسجيل لتجنب إغراق السجل
                if (i % 5 === 0 || config.DEBUG_MODE) {
                     logger.info(`[مراقبة] ${trade.tokenAddress.slice(0, 10)}... | الربح: ${profit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%`);
                }

                // (جني الأرباح الجزئي)
                if (config.PARTIAL_TP_PERCENT > 0 &&
                    profit >= config.PARTIAL_TP_PERCENT &&
                    !trade.partialTpTaken)
                {
                    if (sellingLocks.has(trade.tokenAddress)) {
                        logger.info(`[جني ربح] TP لـ ${trade.tokenAddress} مؤجل (عملية بيع جارية).`);
                        continue;
                    }

                    logger.info(`🎯 [جني ربح] تفعيل جني الأرباح الجزئي لـ ${trade.tokenAddress} عند ربح ${profit.toFixed(2)}%`);

                    sellingLocks.add(trade.tokenAddress);
                    trade.partialTpTaken = true;

                    const amountToSell = (trade.remainingAmountWei * BigInt(config.PARTIAL_TP_SELL_PERCENT)) / 100n;

                    executeSell(trade, amountToSell, `جني ربح جزئي ${config.PARTIAL_TP_SELL_PERCENT}%`)
                        .then(success => {
                            if (success) {
                                trade.remainingAmountWei = trade.remainingAmountWei - amountToSell;
                                saveTradesToFile();
                            } else {
                                trade.partialTpTaken = false; // إعادة المحاولة إذا فشل البيع
                            }
                        })
                        .finally(() => {
                            sellingLocks.delete(trade.tokenAddress);
                        });

                    continue; // انتقل إلى الصفقة التالية بعد بدء البيع
                }

                // (وقف الخسارة المتحرك)
                if (trade.highestProfit > 0 && profit < trade.highestProfit - config.TRAILING_STOP_LOSS_PERCENT) {

                    if (sellingLocks.has(trade.tokenAddress)) {
                        logger.info(`[الحارس] TSL لـ ${trade.tokenAddress} مؤجل (عملية بيع جارية).`);
                        continue;
                    }

                    logger.info(`🎯 [الحارس] تفعيل وقف الخسارة المتحرك لـ ${trade.tokenAddress} عند ربح ${profit.toFixed(2)}%`);

                    sellingLocks.add(trade.tokenAddress);

                    executeSell(trade, trade.remainingAmountWei, `وقف خسارة متحرك`)
                        .then(success => {
                            if (success) {
                                removeTrade(trade); // الإزالة تحدث هنا عند نجاح البيع
                            }
                             // لا تحرر القفل هنا إذا فشل البيع، قد يحاول مرة أخرى
                        })
                        .finally(() => {
                             // تحرير القفل دائمًا للسماح بمحاولات أخرى أو بيع يدوي
                            sellingLocks.delete(trade.tokenAddress);
                        });
                }
            } catch (processingError) {
                 logger.error(`[مراقبة] خطأ في معالجة سعر ${trade.tokenAddress}: ${processingError.message}`);
            }
        } else if (result.status === 'rejected' || result.value === null) {
             // التعامل مع الأخطاء التي حدثت أثناء جلب السعر
             const reason = result.reason ? (result.reason.message || result.reason) : "فشل جلب السعر (staticCall)";
             if (reason.includes('CALL_EXCEPTION') || reason.includes('Unexpected token')) {
                  logger.warn(`[مراقبة] قد تكون الصفقة ${trade.tokenAddress} مغلقة أو بها مشكلة. خطأ: ${reason}`);
                  // يمكن إضافة منطق لإزالة الصفقة بعد عدد معين من المحاولات الفاشلة
             } else {
                  logger.error(`[مراقبة] خطأ في جلب سعر ${trade.tokenAddress}: ${reason}`);
             }
        }
    }
}


async function executeSell(trade, amountToSellWei, reason = "يدوي") {
    if (amountToSellWei <= 0n) {
         logger.warn(`[بيع] محاولة بيع كمية صفر أو سالبة من ${trade.tokenAddress}`);
         return false;
    }
    try {
        const decimals = trade.decimals || 18;
        logger.info(`💸 [بيع] بدء عملية بيع ${reason} لـ ${trade.tokenAddress}... الكمية: ${ethers.formatUnits(amountToSellWei, decimals)}`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const txOptions = { gasLimit: config.GAS_LIMIT };

        // استخدام نفس منطق الغاز الديناميكي للشراء ولكن ربما بمضاعف أقل للبيع
        const sellPriorityMultiplier = BigInt(Math.max(1, config.GAS_PRIORITY_MULTIPLIER / 2)); // مثال: نصف أولوية الشراء

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             const dynamicPriorityFee = feeData.maxPriorityFeePerGas * sellPriorityMultiplier;
             txOptions.maxFeePerGas = feeData.maxFeePerGas + (dynamicPriorityFee - feeData.maxPriorityFeePerGas);
             txOptions.maxPriorityFeePerGas = dynamicPriorityFee;
        } else {
            txOptions.gasPrice = feeData.gasPrice * sellPriorityMultiplier;
        }
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountToSellWei, 0, path, config.WALLET_ADDRESS, Math.floor(Date.now() / 1000) + 300,
            txOptions
        );
        logger.info(`[بيع] تم إرسال معاملة البيع (${reason}). الهاش: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            const msg = `💸 <b>نجحت عملية البيع (${reason})!</b> 💸\n\n<b>العملة:</b> <code>${trade.tokenAddress}</code>\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            logger.info(`💰💰💰 نجحت عملية البيع لـ ${trade.tokenAddress}!`);
            return true;
        } else {
             logger.error(`🚨 فشلت معاملة البيع ${trade.tokenAddress} (الحالة 0).`);
        }
    } catch (error) {
         // تقديم تفاصيل أكثر عن الخطأ
         const reasonText = error.reason || error.message;
         logger.error(`❌ خطأ فادح في عملية البيع لـ ${trade.tokenAddress}: ${reasonText}`);
         // إرسال إشعار للمستخدم بفشل البيع
         telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 <b>فشل البيع (${reason})</b> 🚨\n\n<b>العملة:</b> <code>${trade.tokenAddress}</code>\n<b>السبب:</b> ${reasonText}`, { parse_mode: 'HTML' });
    }
    return false;
}


// =================================================================
// 5. تخزين الصفقات النشطة (Persistence) - (لا تغيير)
// =================================================================
// ... (دوال replacer, reviver, saveTradesToFile, loadTradesFromFile, removeTrade تبقى كما هي)
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
        logger.info(`💾 تم حفظ ${activeTrades.length} صفقة نشطة في الملف.`);
    } catch (error) {
        logger.error(`💾 خطأ أثناء حفظ الصفقات: ${error.message}`);
    }
}
function loadTradesFromFile() {
    try {
        if (fs.existsSync(TRADES_FILE)) {
            const data = fs.readFileSync(TRADES_FILE, 'utf8');
            const loadedTrades = JSON.parse(data, reviver);
            if (Array.isArray(loadedTrades)) {
                 const validTrades = loadedTrades
                    .filter(t => t.tokenAddress && t.remainingAmountWei > 0n) // تعديل الشرط ليشمل BigInt
                    .map(t => ({
                        ...t,
                        decimals: t.decimals || 18,
                        partialTpTaken: t.partialTpTaken || false
                    }));
                 activeTrades.push(...validTrades);
            }
        } else {
             logger.info("💾 ملف الصفقات النشطة غير موجود، البدء بقائمة فارغة.");
        }
    } catch (error) {
        logger.error(`💾 خطأ أثناء تحميل الصفقات: ${error.message}`);
        activeTrades.length = 0; // مسح القائمة إذا كان الملف تالفًا
    }
}
function removeTrade(tradeToRemove) {
    const index = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress);
    if (index > -1) {
        activeTrades.splice(index, 1);
        logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress} من قائمة المراقبة.`);
        saveTradesToFile();
        isWiseHawkHunting = false; // تحرير القفل هنا أيضًا
    }
}


// =================================================================
// 6. الراصد ونقطة الانطلاق (v9.3 "الصقر الحكيم")
// =================================================================
async function fetchTrendingPairs() {
    if (config.IS_PAUSED) {
        logger.info("[الصقر الحكيم] البوت موقوف مؤقتاً ⏸️. تخطي البحث عن أهداف.");
        return [];
    }

    try {
        // البحث عن العملات التي تم إنشاؤها مؤخرًا ولديها بعض السيولة الأولية
        const query = 'chain:bsc sort:age'; // البحث عن الأحدث
        const url = `https://api.dexscreener.com/latest/dex/search/?q=${query}`;

        logger.info(`[الصقر الحكيم] جاري البحث عن أهداف مبكرة باستخدام query: ${query}...`);
        const response = await axios.get(url, { headers: { 'Accept': 'application/json' } });

        if (response.data && response.data.pairs) {
            lastPairsFound = response.data.pairs.length; // تحديث عدد الأهداف المكتشفة
            logger.info(`[الصقر الحكيم] تم العثور على ${lastPairsFound} هدف محتمل مبدئيًا.`);
            // الفلترة الأولية تتم الآن في processNewTarget
            return response.data.pairs;
        }
        lastPairsFound = 0;
        return [];
    } catch (error) {
        logger.error(`[الصقر الحكيم] ❌ خطأ في جلب البيانات من DexScreener: ${error.message}`);
        lastPairsFound = 0;
        return [];
    }
}

async function processNewTarget(pair) {
    // التحقق الأساسي من وجود البيانات اللازمة
    if (!pair || !pair.pairAddress || !pair.baseToken || !pair.baseToken.address || !pair.pairCreatedAt) {
         logger.warn("[فلتر] تجاهل pair بسبب بيانات غير كاملة من API.");
         return;
    }

    const pairAddress = pair.pairAddress;
    const tokenAddress = pair.baseToken.address;

    // فلترة client-side للدخول المبكر (أقل من 10 دقائق، سيولة >5000 USD، نشاط أولي)
    const pairAgeMs = Date.now() - new Date(pair.pairCreatedAt).getTime();
    const pairAgeMin = pairAgeMs / (1000 * 60);
    if (pairAgeMin > 10) {
        if (config.DEBUG_MODE) logger.info(`[فلتر] تجاهل ${tokenAddress.slice(0,10)} (عمر >10 دقائق: ${pairAgeMin.toFixed(1)} دقيقة)`);
        return;
    }

    const liquidityUsd = pair.liquidity ? pair.liquidity.usd : 0;
    if (liquidityUsd < 5000) {
        if (config.DEBUG_MODE) logger.info(`[فلتر] تجاهل ${tokenAddress.slice(0,10)} (سيولة <5000 USD: ${liquidityUsd.toFixed(0)})`);
        return;
    }

    // فلتر نشاط أولي (m5 إذا متوفر، وإلا h1) - استخدام m5 هو الأنسب هنا
    const txnsPeriod = pair.txns && pair.txns.m5 ? 'm5' : 'h1'; // الأولوية لـ m5
    const buys = pair.txns ? pair.txns[txnsPeriod]?.buys || 0 : 0;
    const volumePeriod = pair.volume ? pair.volume[txnsPeriod] || 0 : 0;
    if (buys < 5 || volumePeriod < 1000) {
        logger.warn(`🔻 [فلتر نشاط] تم تجاهل ${tokenAddress.slice(0,10)} (نشاط ضعيف: ${buys} شراء، ${volumePeriod.toFixed(0)}$ حجم في ${txnsPeriod})`);
        if (config.DEBUG_MODE) {
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة مبكرة</b>\n\n<code>${tokenAddress}</code>\n\n<b>السبب:</b> نشاط أولي ضعيف (${buys} شراء/${volumePeriod.toFixed(0)}$ حجم/${txnsPeriod})`, { parse_mode: 'HTML' });
        }
        return;
    }

    logger.info(`\n🔥 [هدف محتمل!] عملة اجتازت الفلترة الأولية: ${pair.baseToken.symbol} (${tokenAddress.slice(0, 10)}...)`);
    logger.info(`   - الرابط: https://dexscreener.com/bsc/${pairAddress}`);

    const checkResult = await fullCheck(pairAddress, tokenAddress);

    if (checkResult.passed) {
        if (isWiseHawkHunting) {
            logger.info(`[الصقر الحكيم] تجاهل ${tokenAddress}، هناك عملية صيد نشطة بالفعل.`);
            return;
        }
        isWiseHawkHunting = true;

        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `✅ <b>عملة اجتازت الدرع الفولاذي!</b>\n\n<b>العملة:</b> ${pair.baseToken.symbol} (<code>${tokenAddress}</code>)\n\n🚀 جاري محاولة القنص...`, { parse_mode: 'HTML' });

        try {
            await snipeToken(pairAddress, tokenAddress);
        } finally {
            // لا تحرر القفل هنا مباشرة، snipeToken أو removeTrade سيقوم بذلك
        }
    } else {
        logger.warn(`🔻 [مهمة منتهية] تم تجاهل ${tokenAddress} (السبب: ${checkResult.reason}).`);
        if (config.DEBUG_MODE) {
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة ذات زخم</b>\n\n<code>${tokenAddress}</code>\n\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' });
        }
    }
}


async function pollForMomentum() {
    logger.info("🚀 [الصقر الحكيم] بدأ تشغيل البوت (v9.3).");
    while (true) {
        try {
            const pairs = await fetchTrendingPairs();

            // معالجة الأهداف بشكل تسلسلي لتجنب الضغط الزائد
            for (const pair of pairs) {
                if (!processedPairs.has(pair.pairAddress)) {
                    processedPairs.add(pair.pairAddress); // إضافة للمُعَالَجة حتى لو تم تجاهله لاحقًا

                    // لا تستخدم .catch هنا لمنع الدورة من التوقف عند خطأ فادح في معالجة واحدة
                    try {
                         await processNewTarget(pair);
                         // تأخير بسيط بين معالجة كل pair لتوزيع الحمل
                         await sleep(500); // 0.5 ثانية
                    } catch (e) {
                         logger.error(`❌ خطأ فادح في معالجة الهدف ${pair.pairAddress}: ${e.message}`, e);
                    }
                }
            }
        } catch (error) {
            logger.error(`❌ خطأ في حلقة "الصقر الحكيم" الرئيسية: ${error.message}`, error);
        }

        logger.info(`[الصقر الحكيم] اكتمل البحث (${lastPairsFound} هدف مكتشف مبدئيًا). في انتظار 10 دقائق (حتى ${new Date(Date.now() + 10 * 60 * 1000).toLocaleTimeString()})...`);
        await sleep(10 * 60 * 1000); // 10 دقائق
    }
}

// =================================================================
// 7. الدالة الرئيسية (Main) - (لا تغيير كبير)
// =================================================================
// ... (دالة main تبقى كما هي من v9.2)
async function main() {
    logger.info(`--- بدء تشغيل بوت صياد الدرر (v9.3 - الصقر الحكيم - درع فولاذي) ---`); // تحديث الإصدار
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        loadTradesFromFile();
        logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة من الملف.`);
        const network = await provider.getNetwork();
        logger.info(`✅ تم الاتصال بالشبكة (RPC) بنجاح! (${network.name}, ChainID: ${network.chainId})`);
        const welcomeMsg = `✅ <b>تم تشغيل بوت الصقر الحكيم (v9.3 - درع فولاذي) بنجاح!</b>`; // تحديث الإصدار
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        telegram.on('message', (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting;
                const newValueStr = msg.text;
                try {
                    let newValue;
                    // <<< [تطوير v9.3] التعامل مع الإعدادات الجديدة >>>
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB', 'MIN_LOCKED_LIQUIDITY_PERCENT', 'MAX_TOP_HOLDERS_PERCENT', 'MAX_CREATOR_PERCENT'].includes(settingKey)) {
                        newValue = parseFloat(newValueStr);
                    }
                    else {
                        newValue = parseInt(newValueStr, 10);
                    }
                    if (isNaN(newValue) || newValue < 0) throw new Error("قيمة غير صالحة");

                    config[settingKey] = newValue;
                    logger.info(`⚙️ تم تغيير ${settingKey} ديناميكياً إلى ${newValue}.`);
                    telegram.sendMessage(chatId, `✅ تم تحديث <b>${settingKey}</b> إلى: <code>${newValue.toString()}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                } catch (error) {
                    telegram.sendMessage(chatId, "❌ قيمة غير صالحة. يرجى إدخال رقم موجب صحيح.", { reply_markup: getMainMenuKeyboard() });
                } finally {
                    delete userState[chatId];
                }
                return;
            }
            // تبديل النص ليتناسب مع "الصقر الحكيم"
            const pauseText = msg.text === '⏸️ إيقاف الصيد' ? '▶️ استئناف الصيد' : null;
            const resumeText = msg.text === '▶️ استئناف الصيد' ? '⏸️ إيقاف الصيد' : null;

            if (pauseText || resumeText) {
                 config.IS_PAUSED = !config.IS_PAUSED;
                 telegram.sendMessage(chatId, `ℹ️ حالة صيد الصقر الآن: <b>${config.IS_PAUSED ? "موقوف ⏸️" : "نشط ▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
            } else {
                 switch (msg.text) {
                    // (بقية الحالات تبقى كما هي)
                    case '🟢 تفعيل التصحيح': case '⚪️ إيقاف التصحيح':
                        config.DEBUG_MODE = !config.DEBUG_MODE;
                        telegram.sendMessage(chatId, `ℹ️ وضع التصحيح الآن: <b>${config.DEBUG_MODE ? "فعّال 🟢" : "غير فعّال ⚪️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                        break;
                    case '📊 الحالة':
                        showStatus(chatId).catch(err => logger.error(`[showStatus] ${err.message}`));
                        break;
                    case '🔬 التشخيص': showDiagnostics(chatId); break;
                    case '⚙️ الإعدادات': showSettingsMenu(chatId); break;
                    case '💰 بيع يدوي': showManualSellMenu(chatId); break;
                    case '🔄 تصفير البيانات': showResetConfirmation(chatId); break;
                 }
            }
        });


        telegram.on('callback_query', (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;

            if (data === 'confirm_reset') {
                try {
                    activeTrades.length = 0;
                    if (fs.existsSync(TRADES_FILE)) {
                        fs.unlinkSync(TRADES_FILE);
                    }
                    isWiseHawkHunting = false;
                    logger.info("🔄 تم تصفير البيانات بنجاح.");
                    telegram.editMessageText("✅ تم تصفير جميع الصفقات النشطة بنجاح.", { chat_id: chatId, message_id: query.message.message_id });
                } catch (error) {
                    logger.error(`🔄 خطأ أثناء تصفير البيانات: ${error.message}`);
                    telegram.editMessageText("❌ حدث خطأ أثناء محاولة تصفير البيانات.", { chat_id: chatId, message_id: query.message.message_id });
                }
                return;
            } else if (data === 'cancel_reset') {
                telegram.editMessageText("👍 تم إلغاء عملية التصفير.", { chat_id: chatId, message_id: query.message.message_id });
                return;
            }

            if (data.startsWith('change_')) {
                const settingKey = data.replace('change_', '');
                if (SETTING_PROMPTS[settingKey]) {
                     userState[chatId] = { awaiting: settingKey };
                     telegram.editMessageText(SETTING_PROMPTS[settingKey], { chat_id: chatId, message_id: query.message.message_id });
                } else {
                     telegram.answerCallbackQuery(query.id, { text: "إعداد غير معروف!" });
                }
            } else if (data.startsWith('manual_sell_')) {
                const tokenAddress = data.replace('manual_sell_', '');
                showSellPercentageMenu(chatId, query.message.message_id, tokenAddress);
            } else if (data.startsWith('partial_sell_')) {
                const [_, percentage, tokenAddress] = data.split('_');

                if (sellingLocks.has(tokenAddress)) {
                    telegram.answerCallbackQuery(query.id, { text: "⏳ جاري تنفيذ عملية بيع سابقة!" });
                    return;
                }

                const trade = activeTrades.find(t => t.tokenAddress === tokenAddress);
                if (trade) {

                    sellingLocks.add(tokenAddress);

                    const amount = (trade.remainingAmountWei * BigInt(percentage)) / 100n;
                    telegram.editMessageText(`⏳ جاري بيع ${percentage}% من ${tokenAddress.slice(0,10)}...`, { chat_id: chatId, message_id: query.message.message_id });

                    executeSell(trade, amount, `بيع يدوي ${percentage}%`).then(success => {
                        if (success) {
                            trade.remainingAmountWei = trade.remainingAmountWei - amount;
                            saveTradesToFile();

                            if (percentage === '100' || trade.remainingAmountWei <= 0n) {
                                removeTrade(trade); // removeTrade سيحرر قفل الصقر
                            }
                        } else {
                             telegram.sendMessage(chatId, `❌ فشلت محاولة بيع ${percentage}% من ${tokenAddress.slice(0,10)}.`);
                        }
                    }).finally(() => {
                        sellingLocks.delete(tokenAddress); // تحرير قفل البيع المحدد
                    });
                } else {
                     telegram.answerCallbackQuery(query.id, { text: "الصفقة لم تعد موجودة!" });
                }
            }
        });

        pollForMomentum(); // بدء حلقة الصقر الحكيم

        setInterval(monitorTrades, 2000); // الحارس يراقب كل ثانيتين

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error}`);
        // محاولة إرسال رسالة خطأ للمستخدم قبل الخروج
        try {
             await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `🚨 **خطأ فادح أوقف البوت!** 🚨\n\nالسبب: ${error.message}\n\nيرجى مراجعة ملف السجل sniper_bot_pro.log فوراً.`, { parse_mode: 'HTML' });
        } catch (tgError) {
             logger.error(`فشل إرسال رسالة الخطأ الفادح إلى تليجرام: ${tgError.message}`);
        }
        process.exit(1);
    }
}


// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI) - [تحديث النصوص والأزرار]
// =================================================================

function getMainMenuKeyboard() {
    // تحديث النص ليعكس "الصيد" بدلًا من "البحث"
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف الصيد" : "⏸️ إيقاف الصيد";
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
    let statusText = "<b>📊 الحالة الحالية للبوت (v9.3 - الصقر الحكيم):</b>\n\n"; // تحديث الإصدار
    // تحديث النص ليعكس "الصيد"
    statusText += `<b>حالة الصيد:</b> ${config.IS_PAUSED ? 'موقوف مؤقتاً ⏸️' : 'نشط ▶️'}\n`;
    statusText += `<b>وضع التصحيح:</b> ${config.DEBUG_MODE ? 'فعّال 🟢' : 'غير فعّال ⚪️'}\n`;
    statusText += `<b>حالة الصقر:</b> ${isWiseHawkHunting ? 'يصطاد 🦅' : 'جاهز للصيد'}\n`;
    statusText += `<b>أهداف مكتشفة مبدئيًا (آخر دورة):</b> ${lastPairsFound}\n`; // عرض عدد الأهداف الأولية
    statusText += "-----------------------------------\n";

    let bnbBalance = 0;
    try {
        const balanceWei = await provider.getBalance(config.WALLET_ADDRESS);
        bnbBalance = parseFloat(ethers.formatEther(balanceWei));
    } catch (e) {
        logger.error(`[Status] فشل في جلب رصيد BNB: ${e.message}`);
    }
    statusText += `<b>💰 رصيد المحفظة:</b>\n`;
    statusText += `- ${bnbBalance.toFixed(5)} BNB\n`;
    statusText += "-----------------------------------\n";

    if (activeTrades.length === 0) {
        statusText += "ℹ️ لا توجد صفقات صيد نشطة حالياً.\n";
    } else {
        statusText += "<b>📈 صفقات الصيد النشطة (والأرصدة):</b>\n"; // تحديث النص

        const balancePromises = activeTrades.map(trade => {
            const tokenContract = new ethers.Contract(trade.tokenAddress, ERC20_ABI, provider);
            // إضافة معالجة خطأ هنا أيضًا
            return tokenContract.balanceOf(config.WALLET_ADDRESS).catch(err => {
                 logger.warn(`[Status] فشل في جلب رصيد ${trade.tokenAddress.slice(0,10)}: ${err.message}`);
                 return 0n; // إرجاع BigInt صفر عند الفشل
            });
        });
        const balanceResults = await Promise.allSettled(balancePromises);

        for (let i = 0; i < activeTrades.length; i++) {
            const trade = activeTrades[i];
            const balanceResult = balanceResults[i];

            let tokenBalance = "N/A";
            if (balanceResult.status === 'fulfilled' && balanceResult.value !== null) {
                const decimals = trade.decimals || 18;
                // التأكد من أن القيمة هي BigInt قبل استخدام formatUnits
                if (typeof balanceResult.value === 'bigint') {
                    tokenBalance = parseFloat(ethers.formatUnits(balanceResult.value, decimals)).toFixed(2);
                }
            }

            statusText += `<b>- <code>${trade.tokenAddress.slice(0, 10)}...</code></b>\n`;
            statusText += `  - الربح الحالي: ${trade.currentProfit.toFixed(2)}%\n`;
            statusText += `  - الرصيد المملوك: ${tokenBalance}\n`;
            if (trade.partialTpTaken) {
                statusText += "  - (تم جني الربح الجزئي ✅)\n";
            }
        }
    }
    statusText += "-----------------------------------\n";
    statusText += "<b>⚙️ إعدادات الصقر الحكيم:</b>\n"; // تحديث النص
    statusText += `- مبلغ الشراء: ${config.BUY_AMOUNT_BNB} BNB\n`;
    statusText += `- مضاعف الغاز: ${config.GAS_PRIORITY_MULTIPLIER}x\n`;
    statusText += `- الانزلاق السعري: ${config.SLIPPAGE_LIMIT}%\n`;
    statusText += `- حد السيولة (فحص): ${config.MINIMUM_LIQUIDITY_BNB} BNB\n`;
    statusText += `- وقف الخسارة المتحرك: ${config.TRAILING_STOP_LOSS_PERCENT}%\n`;
    statusText += `- جني الربح الجزئي: بيع ${config.PARTIAL_TP_SELL_PERCENT}% عند ${config.PARTIAL_TP_PERCENT}% ربح\n`;
    statusText += "<b>🛡️ إعدادات الدرع الفولاذي:</b>\n"; // إضافة قسم جديد
    statusText += `- قفل السيولة الأدنى: ${config.MIN_LOCKED_LIQUIDITY_PERCENT}%\n`;
    statusText += `- تركيز الحيتان الأقصى: ${config.MAX_TOP_HOLDERS_PERCENT}%\n`;
    statusText += `- نسبة المطور القصوى: ${config.MAX_CREATOR_PERCENT}%\n`;
    statusText += `- يتطلب التخلي عن العقد: ${config.REQUIRE_OWNERSHIP_RENOUNCED ? '✅' : '❌'}\n`;


    await telegram.sendMessage(chatId, statusText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
}

// <<< [تطوير v9.3] إضافة الإعدادات الجديدة لقائمة التعديل >>>
function showSettingsMenu(chatId) {
    const keyboard = [
        [{ text: `💵 مبلغ الشراء (${config.BUY_AMOUNT_BNB} BNB)`, callback_data: 'change_BUY_AMOUNT_BNB' }],
        [{ text: `🚀 مضاعف الغاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }],
        [{ text: `📊 الانزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        [{ text: `💧 حد السيولة (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `📈 وقف الخسارة المتحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
        [{ text: `🎯 ربح جزئي (% الهدف) (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }],
        [{ text: `💰 ربح جزئي (% البيع) (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }],
        // --- قسم الدرع الفولاذي ---
        [{ text: `🔒 قفل السيولة الأدنى (${config.MIN_LOCKED_LIQUIDITY_PERCENT}%)`, callback_data: 'change_MIN_LOCKED_LIQUIDITY_PERCENT' }],
        [{ text: `🐳 تركيز الحيتان الأقصى (${config.MAX_TOP_HOLDERS_PERCENT}%)`, callback_data: 'change_MAX_TOP_HOLDERS_PERCENT' }],
        [{ text: `👨‍💻 نسبة المطور القصوى (${config.MAX_CREATOR_PERCENT}%)`, callback_data: 'change_MAX_CREATOR_PERCENT' }],
        // زر التخلي عن العقد غير قابل للتعديل حاليًا من الواجهة
    ];
    telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد الذي تريد تغييره:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
}


// ... (بقية دوال الواجهة تبقى كما هي: showResetConfirmation, showDiagnostics, showManualSellMenu, showSellPercentageMenu)
function showResetConfirmation(chatId) {
    const keyboard = [
        [{ text: "❌ نعم، قم بالتصفير", callback_data: 'confirm_reset' }],
        [{ text: "✅ إلغاء", callback_data: 'cancel_reset' }]
    ];
    telegram.sendMessage(chatId, "<b>⚠️ تحذير!</b>\nهل أنت متأكد أنك تريد حذف جميع الصفقات النشطة وملف الحفظ؟ هذا الإجراء سيحذف سجل تتبع البوت فقط، ولن يبيع أي عملات.\n\n<b>لا يمكن التراجع عن هذا الإجراء.</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
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


telegram.on('polling_error', (error) => {
    logger.error(`[خطأ تليجرام] ${error.code}: ${error.message}`);
});

main(); // بدء تشغيل البوت

