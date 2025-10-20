// =================================================================
// صياد الدرر: v1.1 (نسخة JavaScript مع إعدادات ديناميكية)
// =================================================================
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

// --- تحميل الإعدادات ---
dotenv.config();
const config = {
    // ... (كل إعداداتك من ملف .env كما هي) ...
    NODE_URL: process.env.NODE_URL,
    WALLET_ADDRESS: process.env.WALLET_ADDRESS,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_ADMIN_CHAT_ID: process.env.TELEGRAM_ADMIN_CHAT_ID,
    ROUTER_ADDRESS: process.env.ROUTER_ADDRESS || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    FACTORY_ADDRESS: process.env.FACTORY_ADDRESS || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    WBNB_ADDRESS: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    BUY_AMOUNT_BNB: parseFloat(process.env.BUY_AMOUNT_BNB || '0.01'),
    GAS_PRICE_TIP_GWEI: BigInt(process.env.GAS_PRICE_TIP_GWEI || '1'),
    SLIPPAGE_LIMIT: parseInt(process.env.SLIPPAGE_LIMIT || '49', 10),
    GAS_LIMIT: BigInt(process.env.GAS_LIMIT || '600000'),
    MINIMUM_LIQUIDITY_BNB: parseFloat(process.env.MINIMUM_LIQUIDITY_BNB || '5.0'),
    TAKE_PROFIT_THRESHOLD_1: parseInt(process.env.TAKE_PROFIT_THRESHOLD_1 || '100', 10),
    SELL_PERCENTAGE_1: parseInt(process.env.SELL_PERCENTAGE_1 || '50', 10),
    TAKE_PROFIT_THRESHOLD_2: parseInt(process.env.TAKE_PROFIT_THRESHOLD_2 || '300', 10),
    SELL_PERCENTAGE_2: parseInt(process.env.SELL_PERCENTAGE_2 || '100', 10),
    STOP_LOSS_THRESHOLD: parseInt(process.env.STOP_LOSS_THRESHOLD || '-50', 10),
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

// <<<<<<< بداية الكود الجديد: نظام المحادثة للإعدادات >>>>>>>
const userState = {}; // لتخزين حالة المستخدم (هل ننتظر منه قيمة؟)
const SETTING_PROMPTS = {
    "BUY_AMOUNT_BNB": "يرجى إرسال مبلغ الشراء الجديد بالـ BNB (مثال: 0.01):",
    "GAS_PRICE_TIP_GWEI": "يرجى إرسال إكرامية الغاز الجديدة بالـ Gwei (مثال: 1):",
    "SLIPPAGE_LIMIT": "يرجى إرسال نسبة الانزلاق السعري الجديدة (مثال: 49):",
    "MINIMUM_LIQUIDITY_BNB": "يرجى إرسال الحد الأدنى للسيولة بالـ BNB (مثال: 5.0):",
    "TAKE_PROFIT_THRESHOLD_1": "يرجى إرسال نسبة الهدف الأول للربح (مثال: 100):",
    "SELL_PERCENTAGE_1": "يرجى إرسال نسبة البيع للهدف الأول (مثال: 50):",
    "TAKE_PROFIT_THRESHOLD_2": "يرجى إرسال نسبة الهدف الثاني للربح (مثال: 300):",
    "SELL_PERCENTAGE_2": "يرجى إرسال نسبة البيع للهدف الثاني (مثال: 100):",
    "STOP_LOSS_THRESHOLD": "يرجى إرسال نسبة وقف الخسارة (مثال: -50):"
};
// <<<<<<< نهاية الكود الجديد >>>>>>>

// ... (باقي الكود من `fullCheck` إلى `removeTrade` يبقى كما هو تمامًا) ...
// =================================================================
// 1. المدقق (Verifier)
// =================================================================
async function fullCheck(pairAddress, tokenAddress) {
    try {
        console.log(`[فحص] بدء الفحص الشامل لـ ${tokenAddress}`);
        
        // --- 1. فحص السيولة ---
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();
        const wbnbReserve = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? reserves[0] : reserves[1];
        const wbnbLiquidity = parseFloat(ethers.formatEther(wbnbReserve));

        console.log(`[فحص] السيولة المكتشفة: ${wbnbLiquidity.toFixed(2)} BNB`);
        if (wbnbLiquidity < config.MINIMUM_LIQUIDITY_BNB) {
            return { passed: false, reason: `سيولة غير كافية (${wbnbLiquidity.toFixed(2)} BNB)` };
        }

        // --- 2. فحص فخ العسل (Honeypot) ---
        // Ethers.js v6's call simulation is a great way to check this
        await routerContract.getAmountsOut.staticCall(ethers.parseUnits("1", 0), [tokenAddress, config.WBNB_ADDRESS]);
        console.log(`[فحص] ✅ نجحت محاكاة البيع. العملة قابلة للبيع.`);
        
        return { passed: true, reason: "اجتاز كل الفحوصات" };
    } catch (error) {
        console.error(`[فحص] 🚨 فشلت محاكاة البيع! على الأغلب Honeypot.`, error.reason || error.message);
        return { passed: false, reason: `فخ عسل (Honeypot) - ${error.reason || 'فشل استدعاء العقد'}` };
    }
}

// =================================================================
// 2. القناص (Sniper)
// =================================================================
async function snipeToken(tokenAddress) {
    try {
        console.log(`🚀🚀🚀 بدء عملية قنص وشراء العملة: ${tokenAddress} 🚀🚀🚀`);
        const bnbAmountWei = ethers.parseEther(config.BUY_AMOUNT_BNB.toString());
        const path = [config.WBNB_ADDRESS, tokenAddress];
        const amountsOut = await routerContract.getAmountsOut.staticCall(bnbAmountWei, path);
        
        const minTokens = amountsOut[1] * BigInt(100 - config.SLIPPAGE_LIMIT) / BigInt(100);
        
        const feeData = await provider.getFeeData();
        const tip = ethers.parseUnits(config.GAS_PRICE_TIP_GWEI.toString(), 'gwei');
        
        const tx = await routerContract.swapExactETHForTokens(
            minTokens,
            path,
            config.WALLET_ADDRESS,
            Math.floor(Date.now() / 1000) + 120, // 2 minutes deadline
            {
                value: bnbAmountWei,
                gasLimit: config.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas + tip
            }
        );

        console.log(`[شراء] هاش معاملة الشراء: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
            console.log(`💰 نجحت عملية الشراء! تم قنص ${tokenAddress}.`);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
            const decimals = await tokenContract.decimals();
            const buyPrice = config.BUY_AMOUNT_BNB / parseFloat(ethers.formatUnits(amountsOut[1], decimals));

            const msg = `💰 <b>نجحت عملية الشراء!</b> 💰\n\n<b>العملة:</b> <code>${tokenAddress}</code>\n<b>المبلغ:</b> ${config.BUY_AMOUNT_BNB} BNB\n<b>سعر الشراء المقدر:</b> $${buyPrice.toExponential(6)}\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });

            const newTrade = {
                tokenAddress,
                buyPrice,
                initialAmountWei: amountsOut[1],
                remainingAmountWei: amountsOut[1],
                decimals,
                tp1Triggered: false,
                tp2Triggered: false,
            };
            activeTrades.push(newTrade);
            // Approve in the background
            approveMax(tokenAddress);
        } else {
            console.error(`🚨 فشلت معاملة الشراء (الحالة 0).`);
        }
    } catch (error) {
        console.error(`❌ خطأ فادح في تنفيذ الشراء:`, error.reason || error);
    }
}

async function approveMax(tokenAddress) {
    try {
        console.log(`[موافقة] جاري عمل Approve لـ ${tokenAddress}...`);
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const feeData = await provider.getFeeData();
        const tx = await tokenContract.approve(config.ROUTER_ADDRESS, ethers.MaxUint256, {
             maxFeePerGas: feeData.maxFeePerGas,
             maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        });
        await tx.wait();
        console.log(`[موافقة] ✅ تمت الموافقة بنجاح لـ ${tokenAddress}`);
    } catch (error) {
        console.error(`❌ فشلت عملية الموافقة:`, error);
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
            const profit = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
            
            console.log(`[مراقبة] ${trade.tokenAddress.slice(0, 10)}... الربح الحالي: ${profit.toFixed(2)}%`);

            // --- Selling Logic ---
            if (!trade.tp1Triggered && profit >= config.TAKE_PROFIT_THRESHOLD_1) {
                trade.tp1Triggered = true;
                const amountToSell = trade.initialAmountWei * BigInt(config.SELL_PERCENTAGE_1) / BigInt(100);
                executeSell(trade, amountToSell).then(success => {
                    if (success) trade.remainingAmountWei -= amountToSell;
                });
            } else if (!trade.tp2Triggered && profit >= config.TAKE_PROFIT_THRESHOLD_2) {
                trade.tp2Triggered = true;
                executeSell(trade, trade.remainingAmountWei).then(success => {
                    if (success) removeTrade(trade);
                });
            } else if (profit <= config.STOP_LOSS_THRESHOLD) {
                executeSell(trade, trade.remainingAmountWei).then(success => {
                    if (success) removeTrade(trade);
                });
            }
        } catch (error) {
            console.error(`[مراقبة] خطأ في مراقبة ${trade.tokenAddress}:`, error);
        }
    }
}

async function executeSell(trade, amountToSellWei) {
    if (amountToSellWei <= 0) return false;
    try {
        console.log(`💸 [بيع] بدء عملية البيع لـ ${trade.tokenAddress}...`);
        const path = [trade.tokenAddress, config.WBNB_ADDRESS];
        const feeData = await provider.getFeeData();
        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountToSellWei,
            0,
            path,
            config.WALLET_ADDRESS,
            Math.floor(Date.now() / 1000) + 300,
            {
                gasLimit: config.GAS_LIMIT,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
            }
        );
        const receipt = await tx.wait();
        if (receipt.status === 1) {
            const msg = `💸 <b>نجحت عملية البيع!</b> 💸\n\n<b>العملة:</b> <code>${trade.tokenAddress}</code>\n<b>رابط المعاملة:</b> <a href='https://bscscan.com/tx/${tx.hash}'>BscScan</a>`;
            telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
            console.log(`💰💰💰 نجحت عملية البيع لـ ${trade.tokenAddress}!`);
            return true;
        }
    } catch (error) {
        console.error(`❌ خطأ فادح في عملية البيع:`, error.reason || error);
    }
    return false;
}

function removeTrade(tradeToRemove) {
    const index = activeTrades.findIndex(t => t.tokenAddress === tradeToRemove.tokenAddress);
    if (index > -1) {
        activeTrades.splice(index, 1);
        console.log(`🗑️ تمت إزالة ${tradeToRemove.tokenAddress} من قائمة المراقبة.`);
    }
}


// =================================================================
// 4. الراصد ونقطة الانطلاق (Watcher & Main)
// =================================================================
async function main() {
    console.log("--- بدء تشغيل بوت صياد الدرر (v1.1 JS) ---");
    
    try {
        provider = new ethers.WebSocketProvider(config.NODE_URL);
        wallet = new ethers.Wallet(config.PRIVATE_KEY, provider);
        factoryContract = new ethers.Contract(config.FACTORY_ADDRESS, FACTORY_ABI, provider);
        routerContract = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, wallet);

        const network = await provider.getNetwork();
        console.log(`✅ تم الاتصال بالشبكة بنجاح! (${network.name}, ChainID: ${network.chainId})`);
        
        const welcomeMsg = "✅ <b>تم تشغيل بوت صياد الدرر (v1.1 JS) بنجاح!</b>";
        const keyboard = getMainMenuKeyboard();
        telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, welcomeMsg, { parse_mode: 'HTML', reply_markup: keyboard });


        // --- <<<<<<< بداية الكود الجديد: معالجات أوامر التليجرام >>>>>>> ---
        telegram.on('message', (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.TELEGRAM_ADMIN_CHAT_ID) return;

            // --- معالجة القيم الجديدة للإعدادات ---
            if (userState[chatId] && userState[chatId].awaiting) {
                const settingKey = userState[chatId].awaiting;
                const newValueStr = msg.text;
                try {
                    // تحويل القيمة إلى النوع الصحيح (رقم عشري أو صحيح)
                    let newValue;
                    if (settingKey === 'BUY_AMOUNT_BNB' || settingKey === 'MINIMUM_LIQUIDITY_BNB') {
                        newValue = parseFloat(newValueStr);
                    } else if (settingKey === 'GAS_PRICE_TIP_GWEI') {
                        newValue = BigInt(newValueStr);
                    } else {
                        newValue = parseInt(newValueStr, 10);
                    }
                    
                    if (isNaN(newValue) && typeof newValue !== 'bigint') throw new Error("قيمة غير صالحة");

                    config[settingKey] = newValue;
                    console.log(`⚙️ تم تغيير ${settingKey} ديناميكياً إلى ${newValue}.`);
                    telegram.sendMessage(chatId, `✅ تم تحديث <b>${settingKey}</b> إلى: <code>${newValue}</code>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });

                } catch (error) {
                    telegram.sendMessage(chatId, "❌ قيمة غير صالحة. يرجى إدخال رقم صحيح.", { reply_markup: getMainMenuKeyboard() });
                } finally {
                    delete userState[chatId]; // إنهاء حالة الانتظar
                }
                return;
            }

            // --- معالجة الأوامر من لوحة المفاتيح ---
            switch (msg.text) {
                case '⏸️ إيقاف القنص':
                case '▶️ استئناف القنص':
                    config.IS_PAUSED = !config.IS_PAUSED;
                    const status = config.IS_PAUSED ? "موقوف مؤقتاً ⏸️" : "نشط ▶️";
                    telegram.sendMessage(chatId, `ℹ️ حالة قنص العملات الجديدة الآن: <b>${status}</b>`, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard() });
                    break;
                case '⚙️ الإعدادات':
                    showSettingsMenu(chatId);
                    break;
                // يمكنك إضافة أوامر أخرى هنا مثل '📊 الحالة'
            }
        });

        // --- معالج الضغط على أزرار الإعدادات ---
        telegram.on('callback_query', (query) => {
            const chatId = query.message.chat.id;
            const data = query.data;

            if (data.startsWith('change_')) {
                const settingKey = data.replace('change_', '');
                userState[chatId] = { awaiting: settingKey };
                telegram.editMessageText(SETTING_PROMPTS[settingKey], {
                    chat_id: chatId,
                    message_id: query.message.message_id
                });
            } else if (data === 'main_menu') {
                 telegram.editMessageText("🏠 القائمة الرئيسية", {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    reply_markup: getMainMenuKeyboard()
                });
            }
        });
        // --- <<<<<<< نهاية الكود الجديد >>>>>>> ---
        
        // --- بدء الراصد (Watcher) ---
        console.log("🎧 [الراصد] بدء الاستماع لحدث PairCreated...");
        factoryContract.on('PairCreated', async (token0, token1, pairAddress) => {
            if (config.IS_PAUSED) return;
            
            console.log(`\n👀 [الراصد] تم رصد مجمع جديد: ${pairAddress}`);
            const targetToken = token0.toLowerCase() === config.WBNB_ADDRESS.toLowerCase() ? token1 : token0;
            
            const checkResult = await fullCheck(pairAddress, targetToken);
            if (checkResult.passed) {
                await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `✅ <b>عملة اجتازت الفحص!</b>\n\n<code>${targetToken}</code>\n\n🚀 جاري محاولة القنص...`, { parse_mode: 'HTML' });
                snipeToken(targetToken);
            } else {
                console.log(`🔻 [مهمة منتهية] تم تجاهل ${targetToken} (السبب: ${checkResult.reason}).`);
                if (config.DEBUG_MODE) {
                    await telegram.sendMessage(config.TELEGRAM_ADMIN_CHAT_ID, `⚪️ <b>تم تجاهل عملة</b>\n\n<code>${targetToken}</code>\n\n<b>السبب:</b> ${checkResult.reason}`, { parse_mode: 'HTML' });
                }
            }
        });

        // --- بدء الحارس (Guardian) ---
        setInterval(monitorTrades, 10000); // Check prices every 10 seconds

    } catch (error) {
        console.error("❌ فشل فادح في الدالة الرئيسية:", error);
        process.exit(1);
    }
}

// --- <<<<<<< بداية الكود الجديد: دوال مساعدة للتليجرام >>>>>>> ---
function getMainMenuKeyboard() {
    const pauseButtonText = config.IS_PAUSED ? "▶️ استئناف القنص" : "⏸️ إيقاف القنص";
    return {
        keyboard: [
            [{ text: "📊 الحالة" }, { text: pauseButtonText }],
            [{ text: "⚙️ الإعدادات" }]
        ],
        resize_keyboard: true
    };
}

function showSettingsMenu(chatId) {
    const keyboard = [
        [{ text: `💵 مبلغ الشراء (${config.BUY_AMOUNT_BNB} BNB)`, callback_data: 'change_BUY_AMOUNT_BNB' }],
        [{ text: `🚀 إكرامية الغاز (${config.GAS_PRICE_TIP_GWEI} Gwei)`, callback_data: 'change_GAS_PRICE_TIP_GWEI' }],
        [{ text: `📊 الانزلاق (${config.SLIPPAGE_LIMIT}%)`, callback_data: 'change_SLIPPAGE_LIMIT' }],
        [{ text: `💧 حد السيولة (${config.MINIMUM_LIQUIDITY_BNB} BNB)`, callback_data: 'change_MINIMUM_LIQUIDITY_BNB' }],
        [{ text: `🎯 ربح 1 (${config.TAKE_PROFIT_THRESHOLD_1}%) | بيع ${config.SELL_PERCENTAGE_1}%`, callback_data: 'change_TAKE_PROFIT_THRESHOLD_1' }],
        [{ text: `🎯 ربح 2 (${config.TAKE_PROFIT_THRESHOLD_2}%) | بيع ${config.SELL_PERCENTAGE_2}%`, callback_data: 'change_TAKE_PROFIT_THRESHOLD_2' }],
        [{ text: `🛑 وقف الخسارة (${config.STOP_LOSS_THRESHOLD}%)`, callback_data: 'change_STOP_LOSS_THRESHOLD' }],
    ];
    telegram.sendMessage(chatId, "<b>⚙️ اختر الإعداد الذي تريد تغييره:</b>", {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}
// --- <<<<<<< نهاية الكود الجديد >>>>>>> ---

main();
