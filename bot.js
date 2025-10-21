// =================================================================
// صياد الدرر: v3.0 (قناص خاطف - فلتر خفيف + هروب سريع)
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
// (نفس إعدادات v2.8، لأننا ما زلنا بحاجة لجني الأرباح والغاز الديناميكي)
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
const FACTORY_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'];
const PAIR_ABI = ['function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)'];
const ROUTER_ABI = ['function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'];
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function balanceOf(address account) external view returns (uint256)'];

// --- تهيئة المتغيرات الرئيسية ---
let provider, wallet, factoryContract, routerContract, wssProvider;
const activeTrades = [];
const telegram = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const userState = {};
const TRADES_FILE = 'active_trades.json';
const sellingLocks = new Set();
// (نحتفظ بنفس قائمة الإعدادات لأننا ما زلنا نتحكم بها)
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
// 1. المدقق (Verifier)
// =================================================================
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =================================================================
// دالة checkTokenSecurity - نسخة v3.0 "القناص الخاطف" (فلتر خفيف)
// =================================================================
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
                // [تطوير v3.0] تقليل فترة الانتظار إلى ثانية واحدة فقط
                logger.warn(`[فحص أمني] لم يتم العثور على العملة في Go+، سأنتظر 1 ثانية وأحاول مرة أخرى.`);
                await sleep(1000); 
                return checkTokenSecurity(tokenAddress, false);
            }
            return { is_safe: false, reason: "لم يتم العثور على العملة في Go+" };
        }

        // --- [تطوير v3.0] الفلتر الخفيف (فقط الكوارث الفورية) ---

        // 1. هل هو فخ عسل واضح؟ (سريع)
        if (result.is_honeypot === '1') {
             return { is_safe: false, reason: "فخ عسل حسب Go+" };
        }
        
        // 2. هل ضريبة البيع كارثية؟ (سريع)
        // [تطوير v3.0] تغيير الافتراضي إلى 0 ورفع الحد إلى 25%
        const sellTax = parseFloat(result.sell_tax || '0'); 
        if (sellTax > 0.25) { // تم رفع الحد إلى 25%
             return { is_safe: false, reason: `ضريبة بيع مرتفعة جداً (${(sellTax * 100).toFixed(0)}%)` };
        }

        // 3. هل هو عقد وكيل (Proxy)؟ (سريع)
        // (هذا الفلتر ضروري بناءً على اكتشافك)
        if (result.is_proxy === '1') {
            return { is_safe: false, reason: "عقد وكيل (Proxy) - خطر الترقية" };
        }

        // --- [تطوير v3.0] تم حذف فلاتر (الحيتان، الأقفال، المالك) ---
        // لأنها بطيئة وتمنعنا من الشراء السريع (تسبب خطأ 100% حيتان).
        // سنعتمد على TSL و TP للهروب.
        
        logger.info(`[فحص أمني] ✅ العملة اجتازت الفلتر الخفيف (v3.0).`);
        return { is_safe: true };

    } catch (error) {
        logger.error(`[فحص أمني] 🚨 خطأ في التواصل مع Go+ API: ${error.message}`);
        return { is_safe: false, reason: "خطأ في API الفحص الأمني" };
    }
}
// <<< نهاية تطوير v3.0


async function fullCheck(pairAddress, tokenAddress) {
    try {
        logger.info(`[فحص] بدء الفحص الشامل لـ ${tokenAddress}`);
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider); 
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));
        logger.info(`[فحص] السيولة المكتشفة: ${wbnbLiquidity.toFixed(2)} BNB`);
        
        // (نحتفظ بفحص السيولة الأدنى)
        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) {
            return { passed: false, reason: `سيولة غير كافية (${wbnbLiquidity.toFixed(2)} BNB)` };
        }
        
        // (استدعاء الفلتر الخفيف الجديد)
        const securityResult = await checkTokenSecurity(tokenAddress);
        if (!securityResult.is_safe) {
            return { passed: false, reason: securityResult.reason };
        }
        
        // (نحتفظ بمحاكاة البيع، فهي أهم فحص Honeypot)
        await routerContract.getAmountsOut.staticCall(ethers.parseUnits("1", 0), [tokenAddress, config.WBNB_ADDRESS]);
        logger.info(`[فحص] ✅ نجحت محاكاة البيع. العملة قابلة للبيع.`);
        return { passed: true, reason: "اجتاز كل الفحوصات" };
    } catch (error) {
        logger.error(`[فحص] 🚨 فشلت محاكاة البيع! ${error.reason || error.message}`);
        return { passed: false, reason: `فخ عسل (Honeypot) - ${error.reason || 'فشل استدعاء العقد'}` };
    }
}

// =================================================================
// 2. القناص (Sniper) - (لا تغيير عن v2.8)
// =================================================================
async function snipeToken(pairAddress, tokenAddress) {
    try {
        logger.info(`🚀🚀🚀 بدء عملية قنص وشراء العملة: ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        const amountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        const minTokens = amountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);
        
        const feeData = await provider.getFeeData();
        const txOptions = {
            value: bnbAmountWei,
            gasLimit: config.GAS_LIMIT,
        };

        // (استراتيجية الغاز الديناميكي ضرورية للقناص الخاطف)
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            const dynamicPriorityFee = feeData.maxPriorityFeePerGas * BigInt(config.GAS_PRIORITY_MULTIPLIER);
            txOptions.maxFeePerGas = feeData.maxFeePerGas + (dynamicPriorityFee - feeData.maxPriorityFeePerGas); 
            txOptions.maxPriorityFeePerGas = dynamicPriorityFee;
            logger.info(`[غاز] ديناميكي: الأولوية ${ethers.formatUnits(dynamicPriorityFee, 'gwei')} Gwei (المقترح ${ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} Gwei)`);
        } else {
            txOptions.gasPrice = feeData.gasPrice * BigInt(config.GAS_PRIORITY_MULTIPLIER);
             logger.info(`[غاز] قديم: السعر ${ethers.formatUnits(txOptions.gasPrice, 'gwei')} Gwei`);
        }
        
        const tx = await routerContract.swapExactETHForTokens(
            minTokens,
            path,
            config.WALLET_ADDRESS,
            Math.floor(Date.now() / 1000) + 120,
            txOptions
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
            
            // (ما زلنا بحاجة لـ partialTpTaken)
            activeTrades.push({ 
                tokenAddress, 
                pairAddress, 
                buyPrice, 
                initialAmountWei: amountsOut[1], 
                remainingAmountWei: amountsOut[1], 
                decimals, 
                currentProfit: 0, 
                highestProfit: 0,
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
// 3. الحارس (Guardian) - (لا تغيير عن v2.8)
// =================================================================
async function monitorTrades() {
    if (activeTrades.length === 0) return;

    // (نظام المراقبة المتوازية v2.7 ما زال هو الأفضل)
    const priceChecks = activeTrades.map(trade => {
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const oneToken = ethers.parseUnits("1", trade.decimals);
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

                // (منطق جني الأرباح الجزئي v2.8 ضروري للخاطف)
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

                // (منطق وقف الخسارة المتحرك v2.8 ضروري للخاطف)
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
        logger.info(`💸 [بيع] بدء عملية بيع ${reason} لـ ${trade.tokenAddress}... الكمية: ${ethers.formatUnits(amountToSellWei, trade.decimals)}`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const txOptions = { gasLimit: config.GAS_LIMIT };
        // (البيع السريع ضروري للخاطف)
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
// 5. تخزين الصفقات النشطة (Persistence) - (لا تغيير عن v2.8)
// =================================================================
function replacer(key, value) {
  if (typeof value === 'bigint') { return value.toString(); }
  return value;
}
function reviver(key, value) {
  if (key && key.endsWith('Wei') && typeof value === 'string') { try { return BigInt(value); } catch(e) {} }
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
    }
}

// =================================================================
// 6. الراصد ونقطة الانطلاق (Watcher & Main) - [تطوير v3.0]
// =================================================================
async function connectAndWatch() {
    let reconnectDelay = 5000;
    const maxDelay = 300000;
    while (true) {
        let heartbeatInterval;
        try {
            logger.info("🔌 [الراصد] محاولة الاتصال بـ WebSocket...");
            wssProvider = new ethers.WebSocketProvider(config.NODE_URL);
            await Promise.race([
                wssProvider.ready,
                sleep(30000).then(() => Promise.reject(new Error("WebSocket connection timeout")))
            ]);
            logger.info("✅ [الراصد] تم الاتصال بـ WebSocket بنجاح!");
            reconnectDelay = 5000;
            factoryContract = new ethers.Contract(config.FACTORY_ADDRESS, FACTORY_ABI, wssProvider);
            logger.info("🎧 [الراصد] بدء الاستماع لحدث PairCreated...");
            factoryContract.removeAllListeners('PairCreated');
            factoryContract.on('PairCreated', handlePairCreated);
            heartbeatInterval = setInterval(async () => {
                try { await wssProvider.getBlockNumber(); } catch (heartbeatError) {
                    logger.error("💔 [الراصد] فشل نبضة WebSocket! بدء إعادة الاتصال...", heartbeatError);
                    clearInterval(heartbeatInterval);
                    wssProvider.websocket.close();
                }
            }, 60000);
            await new Promise((resolve) => {
                wssProvider.websocket.onclose = () => { logger.warn("🔌 [الراصد] انقطع اتصال WebSocket!"); clearInterval(heartbeatInterval); resolve(); };
                wssProvider.websocket.onerror = (err) => { logger.error("🔌 [الراصد] خطأ في WebSocket!", err); clearInterval(heartbeatInterval); };
            });
        } catch (error) {
            logger.error(`🔌 [الراصد] فشل الاتصال أو خطأ فادح: ${error.message}. المحاولة مرة أخرى بعد ${reconnectDelay / 1000} ثانية...`);
            if (wssProvider && wssProvider.websocket) { wssProvider.websocket.terminate(); }
            if (heartbeatInterval) clearInterval(heartbeatInterval); 
        }
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    }
}

async function handlePairCreated(token0, token1, pairAddress) {
     if (config.IS_PAUSED) return;
     logger.info(`\n👀 [الراصد] تم رصد مجمع جديد: ${pairAddress}`);
     const targetToken = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? token1 : token0;
     if (targetToken.toLowerCase() === config.WBNB_ADDRESS.toLowerCase()) return;
     
     // (استدعاء دالة الفحص الجديدة)
     const checkResult = await fullCheck(pairAddress, targetToken);
     
     if (checkResult.passed) {
         await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `✅ <b>عملة اجتازت الفلتر الخفيف!</b>\n\n<code>${targetToken}</code>\n\n🚀 جاري محاولة القنص...`, { parse_mode: 'HTML' });
         snipeToken(pairAddress, targetToken);
     } else {
         logger.warn(`🔻 [مهمة منتهية] تم تجاهل ${targetToken} (السبب: ${checkResult.reason}).`);
         if (config.DEBUG_MODE) {
             await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة</b>\n\n<code>${targetToken}</code>\n\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' });
         }
     }
}

async function main() {
    logger.info(`--- بدء تشغيل بوت صياد الدرر (v3.0 JS) ---`); // [تطوير v3.0]
    try {
        provider = new ethers.JsonRpcProvider(config.PROTECTED_RPC_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);
        loadTradesFromFile();
        logger.info(`💾 تم تحميل ${activeTrades.length} صفقة نشطة من الملف.`);
        const network = await provider.getNetwork();
        logger.info(`✅ تم الاتصال بالشبكة (RPC) بنجاح! (${network.name}, ChainID: ${network.chainId})`);
        const welcomeMsg = `✅ <b>تم تشغيل بوت صياد الدرر (v3.0 JS) بنجاح!</b>`; // [تطوير v3.0]
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
                    else if (settingKey === 'GAS_PRIORITY_MULTIPLIER') { 
                        newValue = parseInt(newValueStr, 10); 
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
        
        connectAndWatch();

        // <<< [تطوير v3.0] زيادة سرعة الحارس لتتناسب مع استراتيجية "الخاطف"
        setInterval(monitorTrades, 2000); // Check every 2 seconds

    } catch (error) {
        logger.error(`❌ فشل فادح في الدالة الرئيسية: ${error}`);
        process.exit(1);
    }
}

// --- دوال واجهة التليجرام الكاملة ---
// (لا تغيير عن v2.8، ما زالت تعمل بشكل ممتاز)

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
            statusText += `<b>- <code>${trade.tokenAddress.slice(0, 10)}...</code>:</b> ${trade.currentProfit.toFixed(2)}%`;
            if (trade.partialTpTaken) {
                statusText += " (تم جني الربح الجزئي ✅)";
            }
            statusText += "\n";
        });
    }
    statusText += "-----------------------------------\n";
    statusText += "<b>⚙️ إعدادات التداول (v3.0 - خاطف):</b>\n";
    statusText += `- مبلغ الشراء: ${config.BUY_AMOUNT_BNB} BNB\n`;
    statusText += `- مضاعف الغاز: ${config.GAS_PRIORITY_MULTIPLIER}x\n`;
    statusText += `- الانزلاق السعري: ${config.SLIPPAGE_LIMIT}%\n`;
    statusText += `- حد السيولة: ${config.MINIMUM_LIQUIDITY_BNB} BNB\n`;
    statusText += `- وقف الخسارة المتحرك: ${config.TRAILING_STOP_LOSS_PERCENT}%\n`;
    statusText += `- جني الربح الجزئي: بيع ${config.PARTIAL_TP_SELL_PERCENT}% عند ${config.PARTIAL_TP_PERCENT}% ربح\n`;

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
