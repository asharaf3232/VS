// =================================================================
// صياد الدرر: v9.2 (الصقر الحكيم - راصد الزخم المبكر + درع فولاذي)
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
const processedPairs = new Set(); // (للبوت v9.0)
// <<< [تطوير v9.2] متغير التحكم في التزامن للصقر الحكيم >>>
let isWiseHawkHunting = false;
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRIORITY_MULTIPLIER": "يرجى إرسال مضاعف غاز الأولوية الجديد (مثال: 2 يعني ضعف المقترح):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى للسيولة بالـ BNB (مثال: 5.0):",
    "TRAILING_STOP_LOSS_PERCENT": "يرجى إرسال نسبة وقف الخسارة المتحرك الجديدة (مثال: 20):",
    "PARTIAL_TP_PERCENT": "يرجى إرسال نسبة الربح لجني الأرباح الجزئي (مثال: 100):",
    "PARTIAL_TP_SELL_PERCENT": "يرجى إرسال النسبة المئوية للبيع عند جني الأرباح الجزئي (مثال: 50):",
};

// =================================================================
// 1. المدقق (Verifier) - [تطوير v9.2: درع فولاذي]
// =================================================================
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkTokenSecurity(tokenAddress, retry = true) {
    if (!config.GOPLUS_API_KEY) {
        logger.warn("[فحص أمني] مفتاح Go+ API غير موجود، تم تخطي الفحص.");
        return { is_safe: true, reason: "فحص أمني معطل" };
    }
    try {
        const url = `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${tokenAddress}`;
        const response = await axios.get(url, { headers: { 'X-API-KEY': config.GOPLUS_API_KEY } });
        const result = response.data.result[tokenAddress.toLowerCase()];

        if (!result) {
            if (retry) {
                logger.warn(`[فحص أمني] لم يتم العثور على العملة في Go+، سأنتظر 1 ثانية وأحاول مرة أخرى.`);
                await sleep(1000); 
                return checkTokenSecurity(tokenAddress, false);
            }
            return { is_safe: false, reason: "لم يتم العثور على العملة في Go+" };
        }

        if (result.is_honeypot === '1') {
             return { is_safe: false, reason: "فخ عسل حسب Go+" };
        }
        
        const sellTax = parseFloat(result.sell_tax || '0'); 
        if (sellTax > 0.25) { // (يمكن خفض هذا الحد إلى 10% لزيادة الأمان)
             return { is_safe: false, reason: `ضريبة بيع مرتفعة جداً (${(sellTax * 100).toFixed(0)}%)` };
        }

        if (result.is_proxy === '1') {
            return { is_safe: false, reason: "عقد وكيل (Proxy) - خطر الترقية" };
        }

        // <<< [تطوير v9.2] فحوصات الدرع الفولاذي >>>
        // فحص قفل السيولة
        const lockedPercent = parseFloat(result.lp_locked_percent || '0');
        if (lockedPercent < 0.95) {
            return { is_safe: false, reason: `السيولة غير مقفلة كفاية (${(lockedPercent * 100).toFixed(0)}%)` };
        }

        // فحص تركيز الحيتان
        const topHoldersPercent = parseFloat(result.top_10_holders_percent || '1');
        if (topHoldersPercent > 0.20) {
            return { is_safe: false, reason: `تركيز عالي للحيتان (${(topHoldersPercent * 100).toFixed(0)}%)` };
        }

        // فحص نسبة المطور
        const creatorPercent = parseFloat(result.creator_percent || '0');
        if (creatorPercent > 0.05) {
            return { is_safe: false, reason: `المطور يملك الكثير (${(creatorPercent * 100).toFixed(0)}%)` };
        }

        // فحص التخلي عن العقد
        if (result.owner_address && result.owner_address !== '0x0000000000000000000000000000000000000000') {
            return { is_safe: false, reason: "لم يتم التخلي عن العقد" };
        }
        // <<< نهاية تطوير v9.2 >>>
        
        logger.info(`[فحص أمني] ✅ العملة اجتازت الفلتر الأمني الشامل.`);
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
// 2. القناص (Sniper) - (المستثمر)
// =================================================================
async function snipeToken(pairAddress, tokenAddress) {
    if (activeTrades.some(t => t.tokenAddress === tokenAddress)) {
        logger.warn(`[استثمار] تم تجاهل الشراء، العملة ${tokenAddress} موجودة بالفعل في الصفقات النشطة.`);
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
            // جلب الـ decimals مباشرة بعد الشراء
            let decimals;
            try {
                decimals = await tokenContract.decimals();
                decimals = Number(decimals); // تحويل BigInt إلى Number
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
async function monitorTrades() {
    if (activeTrades.length === 0) return;

    // التأكد من أن provider جاهز قبل استخدامه في الحارس
    if (!routerContract) {
        logger.warn("[مراقبة] RouterContract غير جاهز بعد، تخطي الدورة.");
        return;
    }
    
    const priceChecks = activeTrades.map(trade => {
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        // التأكد من أن trade.decimals هي رقم صالح
        const decimals = trade.decimals || 18; 
        const oneToken = ethers.parseUnits("1", decimals);
        return routerContract.getAmountsOut.staticCall(oneToken, path);
    });

    const results = await Promise.allSettled(priceChecks);

    for (let i = 0; i < activeTrades.length; i++) {
        const trade = activeTrades[i];
        const result = results[i];

        if (result.status === 'fulfilled') {
            try {
                const amountsOut = result.value;
                const currentPrice = parseFloat(ethers.formatUnits(amountsOut[1], 18)); 
                const profit = trade.buyPrice > 0 ? ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100 : 0;
                trade.currentProfit = profit;
                trade.highestProfit = Math.max(trade.highestProfit, profit);

                logger.info(`[مراقبة] ${trade.tokenAddress.slice(0, 10)}... | الربح: ${profit.toFixed(2)}% | الأعلى: ${trade.highestProfit.toFixed(2)}%`);

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
                                trade.partialTpTaken = false; 
                            }
                        })
                        .finally(() => {
                            sellingLocks.delete(trade.tokenAddress);
                        });
                        
                    continue; 
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
                                removeTrade(trade); 
                            }
                        })
                        .finally(() => {
                            sellingLocks.delete(trade.tokenAddress);
                        });
                }
            } catch (processingError) {
                 logger.error(`[مراقبة] خطأ في معالجة سعر ${trade.tokenAddress}: ${processingError.message}`);
            }
        } else {
            if (result.reason.code === 'CALL_EXCEPTION') {
                 logger.warn(`[مراقبة] قد تكون الصفقة ${trade.tokenAddress} مغلقة. خطأ: ${result.reason.reason}`);
            } else {
                 logger.error(`[مراقبة] خطأ في جلب سعر ${trade.tokenAddress}: ${result.reason.message || result.reason}`);
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
        
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             txOptions.maxFeePerGas = feeData.maxFeePerGas;
             txOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 2n; 
        } else {
            txOptions.gasPrice = feeData.gasPrice * 2n;
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
        logger.error(`❌ خطأ فادح في عملية البيع لـ ${trade.tokenAddress}: ${error.reason || error}`);
    }
    return false;
}

// =================================================================
// 5. تخزين الصفقات النشطة (Persistence) - [تطوير v9.2: تحرير القفل عند الإزالة]
// =================================================================
function replacer(key, value) {
  if (typeof value === 'bigint') { return value.toString(); }
  return value;
}
function reviver(key, value) {
  // تحويل `decimals` إلى رقم
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
                    .filter(t => t.tokenAddress && t.remainingAmountWei)
                    .map(t => ({
                        ...t,
                        decimals: t.decimals || 18, // ضمان وجود decimals
                        partialTpTaken: t.partialTpTaken || false 
                    }));
                 activeTrades.push(...validTrades);
            }
        } else {
             logger.info("💾 ملف الصفقات النشطة غير موجود، البدء بقائمة فارغة.");
        }
    } catch (error) {
        logger.error(`💾 خطأ أثناء تحميل الصفقات: ${error.message}`);
        activeTrades.length = 0;
    }
}
function removeTrade(tradeToRemove) {
    const index = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress);
    if (index > -1) {
        activeTrades.splice(index, 1);
        logger.info(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress} من قائمة المراقبة.`);
        saveTradesToFile(); 
        // <<< [تطوير v9.2] تحرير قفل الصقر الحكيم عند إغلاق الصفقة >>>
        isWiseHawkHunting = false;
    }
}

// =================================================================
// 6. الراصد ونقطة الانطلاق (v9.2 "الصقر الحكيم")
// =================================================================
async function fetchTrendingPairs() {
    if (config.IS_PAUSED) {
        logger.info("[راصد الزخم] البوت موقوف مؤقتاً ⏸️. تخطي البحث عن أهداف.");
        return [];
    }
    
    try {
        // <<< [تطوير v9.2] استعلام مبكر للدخول السريع (1-10 دقائق، سيولة >5000، نشاط أولي) >>>
        const query = 'age:m1 age:m10 liquidity:5000 txns:m5:5 vol:m5:1000 chain:bsc sort:age';
        const url = `https://api.dexscreener.com/latest/dex/pairs/search?q=${query}`;
        
        logger.info("[الصقر الحكيم] جاري البحث عن أهداف مبكرة...");
        const response = await axios.get(url, { headers: { 'Accept': 'application/json' } });
        
        if (response.data && response.data.pairs) {
            logger.info(`[الصقر الحكيم] تم العثور على ${response.data.pairs.length} هدف محتمل مبكر.`);
            return response.data.pairs;
        }
        return [];
    } catch (error) {
        logger.error(`[الصقر الحكيم] ❌ خطأ في جلب البيانات من DexScreener: ${error.message}`);
        return [];
    }
}

async function processNewTarget(pair) {
    const pairAddress = pair.pairAddress;
    const tokenAddress = pair.baseToken.address;

    logger.info(`\n🔥 [هدف محتمل!] تم العثور على عملة ذات زخم مبكر: ${pair.baseToken.symbol} (${tokenAddress.slice(0, 10)}...)`);
    logger.info(`   - الرابط: https://dexscreener.com/bsc/${pairAddress}`);
    
    const checkResult = await fullCheck(pairAddress, tokenAddress); 
    
    if (checkResult.passed) {
        // <<< [تطوير v9.2] فلتر نبض الحياة الأولي >>>
        if (pair.txns && pair.txns.m5 && pair.txns.m5.buys < 5 || pair.volume && pair.volume.m5 < 1000) {
            logger.warn(`🔻 [مهمة منتهية] تم تجاهل ${tokenAddress} (السبب: نشاط أولي ضعيف جداً - <5 شراء أو <1000$ حجم في 5 دقائق).`);
            if (config.DEBUG_MODE) {
                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة مبكرة</b>\n\n<code>${tokenAddress}</code>\n\n<b>السبب:</b> نشاط أولي ضعيف`, { parse_mode: 'HTML' });
            }
            return;
        }
        // <<< نهاية تطوير v9.2 >>>

        // <<< [تطوير v9.2] التحكم في التزامن: صقر واحد فقط >>>
        if (isWiseHawkHunting) {
            logger.info(`[الصقر الحكيم] تجاهل ${tokenAddress}، هناك عملية صيد نشطة بالفعل.`);
            return;
        }
        isWiseHawkHunting = true; // اقفل الصيد
        // <<< نهاية تطوير v9.2 >>>

        await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `✅ <b>عملة اجتازت فحص الزخم المبكر والأمان الفولاذي!</b>\n\n<b>العملة:</b> ${pair.baseToken.symbol} (<code>${tokenAddress}</code>)\n\n🚀 جاري محاولة الاستثمار...`, { parse_mode: 'HTML' });
        
        try {
            await snipeToken(pairAddress, tokenAddress); 
        } finally {
            // حرر القفل بعد 5 ثوانٍ للسماح للحارس بالبدء
            setTimeout(() => { isWiseHawkHunting = false; }, 5000);
        }
    } else {
        logger.warn(`🔻 [مهمة منتهية] تم تجاهل ${tokenAddress} (السبب: ${checkResult.reason}).`);
        if (config.DEBUG_MODE) {
            await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة ذات زخم</b>\n\n<code>${tokenAddress}</code>\n\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' });
        }
    }
}

async function pollForMomentum() {
    logger.info("🚀 [الصقر الحكيم] بدأ تشغيل البوت (v9.2).");
    while (true) {
        try {
            const pairs = await fetchTrendingPairs();
            
            for (const pair of pairs) {
                if (!processedPairs.has(pair.pairAddress)) {
                    processedPairs.add(pair.pairAddress);
                    
                    processNewTarget(pair).catch(e => {
                        logger.error(`❌ خطأ فادح في معالجة الهدف ${pair.pairAddress}: ${e.message}`);
                    });
                }
            }
        } catch (error) {
            logger.error(`❌ خطأ في حلقة "الصقر الحكيم" الرئيسية: ${error.message}`);
        }
        
        logger.info(`[الصقر الحكيم] اكتمل البحث. في انتظار 10 دقائق (حتى ${new Date(Date.now() + 10 * 60 * 1000).toLocaleTimeString()})...`);
        await sleep(10 * 60 * 1000); // 10 دقائق
    }
}

// =================================================================
// 7. الدالة الرئيسية (Main)
// =================================================================
async function main() {
    logger.info(`--- بدء تشغيل بوت صياد الدرر (v9.2 - الصقر الحكيم) ---`);
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        loadTradesFromFile();
        logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة من الملف.`);
        const network = await provider.getNetwork();
        logger.info(`✅ تم الاتصال بالشبكة (RPC) بنجاح! (${network.name}, ChainID: ${network.chainId})`);
        const welcomeMsg = `✅ <b>تم تشغيل بوت الصقر الحكيم (v9.2 JS) بنجاح!</b>`;
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

        telegram.on('message', (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;
            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting;
                const newValueStr = msg.text;
                try {
                    let newValue;
                    if (['BUY_AMOUNT_BNB', 'MINIMUM_LIQUIDITY_BNB'].includes(settingKey)) { 
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
            switch (msg.text) {
                case '⏸️ إيقاف البحث': case '▶️ استئناف البحث':
                    config.IS_PAUSED = !config.IS_PAUSED;
                    telegram.sendMessage(chatId, `ℹ️ حالة البحث عن الزخم الآن: <b>${config.IS_PAUSED ? "موقوف ⏸️" : "نشط ▶️"}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                    break;
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
                // <<< [تطوير v9.1] إضافة زر التصفير >>>
                case '🔄 تصفير البيانات': showResetConfirmation(chatId); break;
            }
        });

        telegram.on('callback_query', (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;

            // <<< [تطوير v9.1] معالجة تأكيد التصفير >>>
            if (data === 'confirm_reset') {
                try {
                    activeTrades.length = 0; // 1. مسح المصفوفة
                    if (fs.existsSync(TRADES_FILE)) {
                        fs.unlinkSync(TRADES_FILE); // 2. حذف الملف
                    }
                    // <<< [تطوير v9.2] تحرير قفل الصقر عند التصفير >>>
                    isWiseHawkHunting = false;
                    logger.info("🔄 تم تصفير البيانات بنجاح (حذف الصفقات النشطة والملف).");
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
            // <<< نهاية تطوير v9.1 >>>

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
                                removeTrade(trade); 
                            }
                        } else {
                             telegram.sendMessage(chatId, `❌ فشلت محاولة بيع ${percentage}% من ${tokenAddress.slice(0,10)}.`);
                        }
                    }).finally(() => {
                        sellingLocks.delete(tokenAddress);
                    });
                } else {
                     telegram.answerCallbackQuery(query.id, { text: "الصفقة لم تعد موجودة!" });
                }
            }
        });
        
        pollForMomentum(); 

        setInterval(monitorTrades, 2000); 

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error}`);
        process.exit(1);
    }
}

// =================================================================
// 8. دوال واجهة التليجرام (Telegram UI) - (لا تغيير كبير)
// =================================================================

function getMainMenuKeyboard() {
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف البحث" : "⏸️ إيقاف البحث";
    const debugButtonText = config.DEBUG_MODE ? "⚪️ إيقاف التصحيح" : "🟢 تفعيل التصحيح";
    return {
        keyboard: [
            [{ text: "📊 الحالة" }, { text: pauseButtonText }],
            [{ text: "💰 بيع يدوي" }, { text: "🔬 التشخيص" }],
            [{ text: "⚙️ الإعدادات" }, { text: debugButtonText }],
            [{ text: "🔄 تصفير البيانات" }] // <<< [تطوير v9.1]
        ],
        resize_keyboard: true
    };
}

// <<< [تطوير v9.1] تحويل الدالة إلى async لجلب الأرصدة >>>
async function showStatus(chatId) {
    let statusText = "<b>📊 الحالة الحالية للبوت (v9.2 - الصقر الحكيم):</b>\n\n";
    statusText += `<b>حالة البحث:</b> ${config.IS_PAUSED ? 'موقوف مؤقتاً ⏸️' : 'نشط ▶️'}\n`;
    statusText += `<b>وضع التصحيح:</b> ${config.DEBUG_MODE ? 'فعّال 🟢' : 'غير فعّال ⚪️'}\n`;
    statusText += `<b>حالة الصقر:</b> ${isWiseHawkHunting ? 'يصطاد 🦅' : 'جاهز للصيد'}\n`; // <<< [تطوير v9.2]
    statusText += "-----------------------------------\n";

    // --- جلب رصيد BNB ---
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
    // --- نهاية جلب رصيد BNB ---

    if (activeTrades.length === 0) {
        statusText += "ℹ️ لا توجد صفقات نشطة حالياً.\n";
    } else {
        statusText += "<b>📈 الصفقات النشطة (والأرصدة):</b>\n";
        
        // --- جلب أرصدة العملات المتداولة ---
        const balancePromises = activeTrades.map(trade => {
            const tokenContract = new ethers.Contract(trade.tokenAddress, ERC20_ABI, provider);
            return tokenContract.balanceOf(config.WALLET_ADDRESS);
        });
        const balanceResults = await Promise.allSettled(balancePromises);
        // --- نهاية جلب الأرصدة ---

        for (let i = 0; i < activeTrades.length; i++) {
            const trade = activeTrades[i];
            const balanceResult = balanceResults[i];
            
            let tokenBalance = "N/A";
            if (balanceResult.status === 'fulfilled') {
                const decimals = trade.decimals || 18;
                tokenBalance = parseFloat(ethers.formatUnits(balanceResult.value, decimals)).toFixed(2);
            }

            statusText += `<b>- <code>${trade.tokenAddress.slice(0, 10)}...</code></b>\n`;
            statusText += `  - الربح الحالي: ${trade.currentProfit.toFixed(2)}%\n`;
            statusText += `  - الرصيد المملوك: ${tokenBalance}\n`; // <<< [تطوير v9.1]
            if (trade.partialTpTaken) {
                statusText += "  - (تم جني الربح الجزئي ✅)\n";
            }
        }
    }
    statusText += "-----------------------------------\n";
    statusText += "<b>⚙️ إعدادات الاستثمار:</b>\n";
    statusText += `- مبلغ الشراء: ${config.BUY_AMOUNT_BNB} BNB\n`;
    // ... (باقي الإعدادات كما هي)
    statusText += `- مضاعف الغاز: ${config.GAS_PRIORITY_MULTIPLIER}x\n`;
    statusText += `- الانزلاق السعري: ${config.SLIPPAGE_LIMIT}%\n`;
    statusText += `- حد السيولة (فحص): ${config.MINIMUM_LIQUIDITY_BNB} BNB\n`;
    statusText += `- وقف الخسارة المتحرك: ${config.TRAILING_STOP_LOSS_PERCENT}%\n`;
    statusText += `- جني الربح الجزئي: بيع ${config.PARTIAL_TP_SELL_PERCENT}% عند ${config.PARTIAL_TP_PERCENT}% ربح\n`;

    telegram.sendMessage(chatId, statusText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
}

// <<< [تطوير v9.1] دالة جديدة لتأكيد التصفير >>>
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

function showSettingsMenu(chatId) {
    const keyboard = [
        [{ text: `💵 مبلغ الشراء (${config.BUY_AMOUNT_BNB} BNB)`, callback_data: 'change_BUY_AMOUNT_BNB' }],
        [{ text: `🚀 مضاعف الغاز (${config.GAS_PRIORITY_MULTIPLIER}x)`, callback_data: 'change_GAS_PRIORITY_MULTIPLIER' }],
        [{ text: `📊 الانزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        [{ text: `💧 حد السيولة (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `📈 وقف الخسارة المتحرك (${config.TRAILING_STOP_LOSS_PERCENT}%)`, callback_data: 'change_TRAILING_STOP_LOSS_PERCENT' }],
        [{ text: `🎯 ربح جزئي (% الهدف) (${config.PARTIAL_TP_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_PERCENT' }],
        [{ text: `💰 ربح جزئي (% البيع) (${config.PARTIAL_TP_SELL_PERCENT}%)`, callback_data: 'change_PARTIAL_TP_SELL_PERCENT' }],
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

telegram.on('polling_error', (error) => {
    logger.error(`[خطأ تليجرام] ${error.code}: ${error.message}`);
});

main();
