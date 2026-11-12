require('dotenv').config();

// ==========================================
// [ 1. Global Error Handlers ]
// ==========================================
process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); });
process.on('uncaughtException',  (err)    => { console.error('💥 Uncaught Exception:',  err);    });

// ==========================================
// [ 2. Imports ]
// ==========================================
const {
    Client, GatewayIntentBits, ActionRowBuilder, EmbedBuilder,
    PermissionFlagsBits, ButtonBuilder, ButtonStyle, Events,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');

const fs = require('fs');

// ==========================================
// [ 3. Config / Constants ]
// ==========================================
// ⚠️ แก้ไอดีเหล่านี้ให้ตรงกับเซิร์ฟเวอร์ของคุณก่อนรันบอท
const ADMIN_ROLE_ID          = '1555146265958944878'; // Role แอดมินที่รับตั๋ว/สร้าง QR ได้
const TICKET_CATEGORY_ID     = '1554881839422906495'; // Category สำหรับสร้างห้องตั๋ว
const DONE_CATEGORY_ID       = '1554881839745994884'; // Category ที่ย้ายห้องไปเก็บหลังปิดตั๋ว
const REVIEW_CHANNEL_ID      = '1554881839745994883'; // ห้องรีวิว (เอาไว้นับจำนวน)

const PROMPTPAY_NUMBER = '0621473585'; // เบอร์พร้อมเพย์รับเงิน
const REVIEW_REACTIONS = ['❤️']; // อีโมจิที่บอทกดใต้รีวิวลูกค้า (เพิ่มได้หลายอัน เช่น ['❤️', '⭐']) — อีโมจิเซิร์ฟเวอร์ใช้รูปแบบ '<:ชื่อ:ไอดี>' หรือใส่แค่ไอดี

const QUEUE_FILE        = './queue.txt';
const TICKET_FILE       = './active_tickets.json';
const REVIEW_COUNT_FILE = './review_count.json';

// อีโมจิกำหนดเองของเซิร์ฟเวอร์ (ใช้กับปุ่มต่างๆ)
const BTN_EMOJI = {
    work:    { id: '1561005772597493930', name: 'work' },
    done:    { id: '1556884242041020456', name: 'blackverified', animated: true },
    close:   { id: '1285847714076033114', name: 'close' },
    contact: { id: '1561005772597493930', name: 'contact' }
};

const LOG_CHANNEL_ID = '1568982552969224315';   // ห้อง log สรุปตอนลบห้องตั๋ว (ว่าง = ไม่ส่ง log)
// ห้องโชว์สินค้าที่จัดส่งแล้ว (ส่งสรุปออเดอร์ให้คนอื่นเห็นตอนกดปิดห้อง)
const PRODUCT_CHANNELS = { nitro: '1566033586744987698', frame: '1566033685491486720' };
const PRODUCT_LABEL    = { nitro: 'Nitro', frame: 'กรอบรูป', reward: 'รางวัลสะสมแต้ม', cancel: 'ยกเลิก' };

// ── ระบบสะสมแต้ม ──
const POINTS_FILE     = './points.json';
const POINTS_PER_ITEM = 1;                               // 1 ชิ้น = 1 แต้ม
const REWARD_THRESHOLD = 10;                             // ครบ 10 แต้ม = รับรางวัลสุ่ม 1 ครั้ง (แต้มถูกหักออก)
// โอกาสรางวัล (น้ำหนักสัมพัทธ์ — ระบบจะปรับให้รวมเป็น 100% เฉพาะ 2 รายการนี้)
const REWARD_WEIGHTS  = { nitro: 0.023, frame: 0.050 };
const REWARDS_FILE       = './rewards.json';
const LEADERBOARD_FILE   = './leaderboard.json';
const FRAME_REWARD_PRICE = 209;   // รางวัลกรอบรูป: เลือกได้ทุกแบบเมลพาส ราคา 209 บาท

// ==========================================
// [ 4. Runtime State ]
// ==========================================
let activeTicketData = {}; // activeTicketData[channelId] = { category, label, price, userId, qNum, payMethod }
let queueCount         = 1;
let reviewCount         = 0;
let pointsData         = {};   // { userId: { points, totalPieces, history[] } }
let rewardsData        = [];   // รางวัลสุ่มที่รอแอดมินส่ง
let leaderboardData    = {};   // { channelId, messageId } ของลีดเดอร์บอร์ด

// ==========================================
// [ 5. Helpers ]
// ==========================================
function loadJSON(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`❌ โหลดไฟล์ ${filePath} ไม่ได้`, err);
        return fallback;
    }
}

function loadPersistentData() {
    activeTicketData = loadJSON(TICKET_FILE, {});
    pointsData       = loadJSON(POINTS_FILE, {});
    rewardsData      = loadJSON(REWARDS_FILE, []);
    leaderboardData  = loadJSON(LEADERBOARD_FILE, {});
    if (fs.existsSync(QUEUE_FILE)) queueCount = parseInt(fs.readFileSync(QUEUE_FILE, 'utf8')) || 1;

    const reviewFile = loadJSON(REVIEW_COUNT_FILE, null);
    if (reviewFile && typeof reviewFile.count === 'number') reviewCount = reviewFile.count;
}

function saveTickets()     { fs.writeFileSync(TICKET_FILE, JSON.stringify(activeTicketData, null, 2)); }
function saveQueue()       { fs.writeFileSync(QUEUE_FILE, queueCount.toString()); }
function savePoints()      { fs.writeFileSync(POINTS_FILE, JSON.stringify(pointsData, null, 2)); }
function saveRewards()     { fs.writeFileSync(REWARDS_FILE, JSON.stringify(rewardsData, null, 2)); }
function saveLeaderboard() { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboardData, null, 2)); }
function saveReviewCount() { fs.writeFileSync(REVIEW_COUNT_FILE, JSON.stringify({ count: reviewCount })); }

loadPersistentData();

/** ลิงก์รูป QR Code พร้อมเพย์ตามยอดเงิน (PromptPay.io) */
function buildQrUrl(amount) {
    return `https://promptpay.io/${PROMPTPAY_NUMBER}/${amount}.png`;
}

/**
 * แปลง mention ห้อง (<#id>), ไอดีห้องดิบๆ, หรือลิงก์ห้อง Discord ให้เป็นไอดีห้อง
 * รองรับ: <#123> / 123 / https://discord.com/channels/guildId/123/messageId
 */
function resolveChannelId(input) {
    if (!input) return null;
    const mention = input.match(/^<#(\d+)>$/);
    if (mention) return mention[1];
    const link = input.match(/discord\.com\/channels\/\d+\/(\d+)/);
    if (link) return link[1];
    if (/^\d+$/.test(input)) return input;
    return null;
}

/** แทนที่/เติมเลขรีวิวในชื่อห้อง รูปแบบ 〔1074〕 — ไม่แตะข้อความอื่นในชื่อห้อง */
function buildReviewChannelName(currentName, count) {
    if (/〔\d+〕/.test(currentName)) {
        return currentName.replace(/〔\d+〕/, `〔${count}〕`);
    }
    return `${currentName}〔${count}〕`;
}

// ── ปิดตั๋ว: รอ 1 วันแล้วลบห้อง + ส่ง log ──
const CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;
const closeTimers    = new Map(); // channelId -> timeout

function scheduleClose(channelId, delayMs) {
    if (closeTimers.has(channelId)) clearTimeout(closeTimers.get(channelId)); // ปิดซ้ำ = นับเวลาใหม่
    const timer = setTimeout(() => {
        closeTimers.delete(channelId);
        closeTicket(channelId);
    }, Math.max(0, delayMs));
    closeTimers.set(channelId, timer);
}

/** สถานะตาม ticket: จัดส่งสำเร็จ (กดปิดแล้ว) / กำลังดำเนินการ (รับงานแล้ว) / รอดำเนินการ */
function orderStatusText(data) {
    if (data.productType === 'cancel') return '❌ ยกเลิกออเดอร์';
    if (data.closeAt) return '✅ จัดส่งสำเร็จ';
    if (data.accepted) return '🛠️ กำลังดำเนินการ';
    return '⏳ รอดำเนินการ';
}

/** embed สรุปออเดอร์ (แบบเดียวกับหน้า Order Status) */
async function buildOrderEmbed(data) {
    const buyer = await client.users.fetch(data.userId).then(u => u.username).catch(() => data.userId || '-');
    const price = data.price ? `${Number(data.price).toLocaleString('en-US')} บาท` : 'ไม่ได้ระบุ';
    return new EmbedBuilder()
        .setColor(data.productType === 'frame' ? '#FF6FAF' : '#5865F2')
        .setTitle('📋 Order Status')
        .setDescription(
            `🛒 **รายการสั่งซื้อ**\n\n` +
            `👤 ผู้ซื้อ : \`${buyer}\`\n` +
            `🎁 ประเภทสินค้า : \`${PRODUCT_LABEL[data.productType] ?? '-'}\`\n` +
            `📦 ชื่อสินค้า : \`${data.productName || '-'}\`\n` +
            `💳 ราคาที่ชำระ : \`${price}\`\n` +
            `📋 สถานะสั่งซื้อ : ${orderStatusText(data)}` +
            (data.pointsEarned != null ? `\n⭐ แต้มที่ได้รับ : \`+${data.pointsEarned}\` (คงเหลือ \`${data.pointsBalance}\`)` : '') +
            (data.rewards?.length ? `\n🎉 รางวัลสะสมแต้ม : \`${data.rewards.map(r => PRODUCT_LABEL[r]).join(', ')}\`` : '')
        )
        .setFooter({ text: `Order No. / Ord #${data.orderNo || '-'}` })
        .setTimestamp();
}

const newOrderNo = (type) => `DECO-${type.toUpperCase()}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;

/** สุ่มรางวัลตามน้ำหนัก (nitro / frame) */
function rollReward() {
    const entries = Object.entries(REWARD_WEIGHTS);
    const total   = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [key, w] of entries) { if ((r -= w) < 0) return key; }
    return entries[entries.length - 1][0];
}

/** ปิดห้องแบบมีผล: ตั้งเวลาลบ 1 วัน + โพสต์สรุป (และรางวัลสุ่ม) ไปห้องโชว์ */
async function finishTicket(channel, data, { post = true } = {}) {
    data.status  = 'done';
    data.closeAt = Date.now() + CLOSE_DELAY_MS;
    saveTickets();
    scheduleClose(channel.id, CLOSE_DELAY_MS);

    if (post && data.productType !== 'cancel') {
        const ch = await client.channels.fetch(PRODUCT_CHANNELS[data.productType]).catch(() => null);
        if (ch) await ch.send({ embeds: [await buildOrderEmbed(data)], allowedMentions: { parse: [] } })
            .catch(err => console.error('❌ โพสต์สรุปไปห้องโชว์ไม่สำเร็จ:', err.message));
        else console.error(`❌ ไม่พบห้องโชว์สินค้า ${PRODUCT_CHANNELS[data.productType]}`);
    }
    await sendSummaryDM(data);
    await updateLeaderboard();
}

const newRewardId = () => 'R' + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
const progressBar = (p, n = REWARD_THRESHOLD) => '▰'.repeat(p) + '▱'.repeat(Math.max(0, n - p));
const rankedUsers = () => Object.entries(pointsData)
    .filter(([, r]) => (r.totalPieces || 0) > 0)
    .sort((a, b) => (b[1].totalPieces || 0) - (a[1].totalPieces || 0));
const pendingRewardsOf = (userId) => rewardsData.filter(r => r.userId === userId && r.status === 'pending');

/** ส่งสรุปเข้า DM ลูกค้า (ถ้าปิด DM ก็ข้าม) */
async function sendSummaryDM(data) {
    if (!data.userId) return;
    const user = await client.users.fetch(data.userId).catch(() => null);
    if (!user) return;
    const rewardLine = data.rewards?.length
        ? `🎉 คุณได้รับรางวัลสะสมแต้ม: **${data.rewards.map(r => PRODUCT_LABEL[r]).join(', ')}**\nแคปหน้าจอข้อความนี้ไว้ แล้วเปิดตั๋วใหม่เพื่อรับรางวัลกับแอดมินได้เลยนะคะ`
        : '';
    await user.send({ content: rewardLine || undefined, embeds: [await buildOrderEmbed(data)] }).catch(() => {});
}

function buildLeaderboardEmbed() {
    const medals = ['🥇', '🥈', '🥉'];
    const top = rankedUsers().slice(0, 10);
    const lines = top.length
        ? top.map(([id, r], i) => `${medals[i] ?? `**${i + 1}.**`} <@${id}> — **${r.totalPieces}** ชิ้น`).join('\n')
        : '_ยังไม่มีข้อมูล_';
    return new EmbedBuilder()
        .setColor('#F1C40F')
        .setTitle('🏆 อันดับลูกค้าซื้อบ่อย')
        .setDescription(`${lines}\n\nกดปุ่มด้านล่างเพื่อเช็คอันดับของคุณ`)
        .setFooter({ text: 'อัปเดตเรียลไทม์' })
        .setTimestamp();
}
const buildLeaderboardRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_mine').setLabel('เช็คอันดับของฉัน').setEmoji('🔍').setStyle(ButtonStyle.Primary)
);

async function updateLeaderboard() {
    if (!leaderboardData.channelId || !leaderboardData.messageId) return;
    try {
        const ch  = await client.channels.fetch(leaderboardData.channelId);
        const msg = await ch.messages.fetch(leaderboardData.messageId);
        await msg.edit({ embeds: [buildLeaderboardEmbed()], components: [buildLeaderboardRow()], allowedMentions: { parse: [] } });
    } catch (err) {
        console.error('❌ อัปเดตลีดเดอร์บอร์ดไม่สำเร็จ:', err.message);
    }
}

/** ปุ่มส่งรางวัลในห้องตั๋วของลูกค้า (ใส่ได้ 4 แถว แถวละ 5 ปุ่ม) */
function buildRewardRows(userId) {
    const pending = pendingRewardsOf(userId).slice(0, 20);
    const rows = [];
    for (let i = 0; i < pending.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(
            ...pending.slice(i, i + 5).map(r => new ButtonBuilder()
                .setCustomId(`reward_sent_${r.id}`).setLabel(`ส่งแล้ว #${r.id}`).setEmoji('✅').setStyle(ButtonStyle.Success))
        ));
    }
    return rows;
}

function buildRewardEmbed(userId) {
    const pending = pendingRewardsOf(userId);
    if (!pending.length) return null;
    const lines = pending.map(r => r.type === 'frame'
        ? `• \`#${r.id}\` — กรอบรูป (เมลพาสทั้งหมด · ${FRAME_REWARD_PRICE} บาท)`
        : `• \`#${r.id}\` — Nitro`).join('\n');
    return new EmbedBuilder().setColor('#E91E63').setTitle('🎁 รางวัลสะสมแต้มที่รอรับ')
        .setDescription(`${lines}\n\nแอดมินจะจัดส่งให้ และกดปุ่มด้านล่างเมื่อส่งเรียบร้อยแล้วครับ`);
}

/** ครบ 1 วัน: ลบห้องตั๋ว แล้วส่ง log ไปห้อง LOG_CHANNEL_ID */
async function closeTicket(channelId) {
    const data = activeTicketData[channelId];
    if (!data) return;

    try {
        const chan = await client.channels.fetch(channelId).catch(() => null);
        if (chan) await chan.delete(`ลบตั๋ว #${data.qNum} ครบ 1 วัน`);
        console.log(`🗑️ ลบตั๋ว #${data.qNum} แล้ว`);
    } catch (err) {
        if (err.code !== 10003) { // 10003 = ห้องถูกลบไปแล้ว ถือว่าเสร็จ
            console.error(`❌ ลบตั๋ว ${channelId} ไม่สำเร็จ (เช็คสิทธิ์ Manage Channels):`, err.message);
            return; // เก็บข้อมูลไว้ ลองใหม่ตอนบอทรีสตาร์ท
        }
    }

    if (LOG_CHANNEL_ID) {
        const logCh = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logCh) await logCh.send({ embeds: [await buildOrderEmbed(data)], allowedMentions: { parse: [] } })
            .catch(err => console.error('❌ ส่ง log ไม่สำเร็จ:', err.message));
    }

    delete activeTicketData[channelId];
    saveTickets();
}

// ── เปลี่ยนชื่อห้องรีวิว: Discord จำกัดการเปลี่ยนชื่อห้อง 2 ครั้ง/10 นาที
//    จึงรวมการเปลี่ยนไว้ทีละครั้ง (เว้นอย่างน้อย 5 นาที) แล้วใช้เลขล่าสุดเสมอ ──
const REVIEW_RENAME_COOLDOWN = 5 * 60 * 1000;
let lastReviewRename  = 0;
let reviewRenameTimer = null;

function scheduleReviewRename() {
    if (reviewRenameTimer) return; // มีคิวรออยู่แล้ว ตอนยิงจะใช้เลขล่าสุดเอง
    const wait = Math.max(0, lastReviewRename + REVIEW_RENAME_COOLDOWN - Date.now());
    reviewRenameTimer = setTimeout(async () => {
        reviewRenameTimer = null;
        lastReviewRename  = Date.now();
        try {
            const ch      = await client.channels.fetch(REVIEW_CHANNEL_ID);
            const newName = buildReviewChannelName(ch.name, reviewCount);
            if (newName !== ch.name) {
                await ch.setName(newName);
                console.log(`✏️ เปลี่ยนชื่อห้องรีวิวเป็น ${newName}`);
            }
        } catch (err) {
            console.error('❌ เปลี่ยนชื่อห้องรีวิวไม่ได้ (เช็ค REVIEW_CHANNEL_ID และสิทธิ์ Manage Channels ของบอท):', err.message);
        }
    }, wait);
}

// ==========================================
// [ 6. Client ]
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once(Events.ClientReady, async () => {
    console.log(`✅ ล็อกอินแล้ว: ${client.user.tag}`);

    // กู้ตัวจับเวลาปิดตั๋วที่ค้างอยู่ (เผื่อบอทรีสตาร์ทระหว่างรอ 10 นาที)
    for (const [channelId, data] of Object.entries(activeTicketData)) {
        if (data.closeAt) scheduleClose(channelId, data.closeAt - Date.now());
    }

    // ซิงค์เลขรีวิวจากชื่อห้อง (กันนับใหม่จาก 0 ทับเลขเดิม) + ตรวจว่าบอทเข้าถึงห้องรีวิวได้
    try {
        const ch = await client.channels.fetch(REVIEW_CHANNEL_ID);
        const m  = ch.name.match(/〔(\d+)〕/);
        if (m && parseInt(m[1], 10) > reviewCount) {
            reviewCount = parseInt(m[1], 10);
            saveReviewCount();
        }
        console.log(`⭐ ห้องรีวิว: ${ch.name} | เลขที่นับอยู่: ${reviewCount}`);
    } catch (err) {
        console.error('❌ บอทเข้าถึงห้องรีวิวไม่ได้ — เช็ค REVIEW_CHANNEL_ID ว่าถูกเซิร์ฟเวอร์ และบอทเห็นห้องนี้:', err.message);
    }
});

// ==========================================
// [ 7. Message Handler: คำสั่งแอดมิน + นับรีวิว ]
// ==========================================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    // ── ระบบนับรีวิว (เช็คก่อนคำสั่ง เพื่อให้รีวิวที่ขึ้นต้นด้วย ! ก็นับ) ──
    if (message.channel.id === REVIEW_CHANNEL_ID) {
        if (message.member?.roles.cache.has(ADMIN_ROLE_ID)) {
            console.log('ℹ️ ข้อความของแอดมินในห้องรีวิว — ไม่นับ');
        } else {
            reviewCount++;
            saveReviewCount();
            console.log(`⭐ นับรีวิวใหม่ → ${reviewCount}`);
            scheduleReviewRename();

            // กดรีแอคชั่นอัตโนมัติใต้รีวิว (ทีละอัน เรียงตามลำดับ) — พังก็ไม่กระทบการนับ
            for (const emoji of REVIEW_REACTIONS) {
                try {
                    await message.react(emoji);
                } catch (err) {
                    console.error(`❌ กดรีแอคชั่น ${emoji} ในห้องรีวิวไม่ได้ (เช็คสิทธิ์ Add Reactions + Read Message History ของบอทในห้องนี้, และอีโมจิถูกต้องไหม):`, err.message);
                    break;
                }
            }
            return;
        }
    }

    // ── คำสั่งแอดมิน (เช็คก่อนเสมอ แม้จะพิมพ์ในห้องตั๋วก็ใช้ได้) ──────
    if (message.content.startsWith('!')) {
        const args    = message.content.trim().split(/ +/);
        const command = args[0].toLowerCase();

        const ADMIN_COMMANDS = ['!setupshop', '!qr', '!points', '!addpoints', '!rewards', '!pointlog', '!undo', '!topbuyer'];
        if (!ADMIN_COMMANDS.includes(command)) return;

        // แจ้งเตือนชัดเจนแทนการเงียบ เผื่อ role ไม่ตรง จะได้รู้ทันทีว่าปัญหาคืออะไร
        if (!message.member || !message.member.roles.cache.has(ADMIN_ROLE_ID)) {
            return message.reply(`❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ครับ (ต้องมี role ไอดี \`${ADMIN_ROLE_ID}\`)`);
        }

        // !setupshop → โพสต์ปุ่มเปิดตั๋ว
        if (command === '!setupshop') {
            const embed = new EmbedBuilder()
                .setAuthor({ name: '🛒 SHOP', iconURL: client.user.displayAvatarURL() })
                .setTitle('🛍️ ยินดีต้อนรับสู่ร้านค้า')
                .setDescription(
`╭━━━━━━━━━━━━━━━━━━━━━━╮
✨ **กดปุ่มด้านล่างเพื่อเปิดตั๋วได้เลยครับ**
╰━━━━━━━━━━━━━━━━━━━━━━╯

🎫 แอดมินจะเข้ามาดูแลและแจ้งยอดชำระเงินให้ในห้องตั๋วของคุณครับ`
                )
                .setColor('#00B2FF')
                .setFooter({ text: 'ระบบร้านค้าอัตโนมัติ' });

            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('create_ticket').setLabel('ᴄʀᴇᴀᴛᴇ ᴛɪᴄᴋᴇᴛ').setEmoji(BTN_EMOJI.contact).setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('points_me').setLabel('เช็คแต้มของฉัน').setEmoji('⭐').setStyle(ButtonStyle.Secondary)
            );

            return message.channel.send({ embeds: [embed], components: [buttons] });
        }

        // !qr [ยอดเงิน] [ห้องปลายทาง]  → สร้าง QR พร้อมเพย์ยอดที่ระบุ ส่งไปห้องไหนก็ได้
        if (command === '!qr') {
            const amount   = parseFloat(args[1]);
            const targetId = resolveChannelId(args[2]);

            if (isNaN(amount) || amount <= 0)
                return message.reply('❌ รูปแบบไม่ถูกต้อง\nรูปแบบ: `!qr [ยอดเงิน] [ห้องปลายทาง]`\nห้องปลายทางใช้ mention ห้อง (#ชื่อห้อง), ไอดีห้อง, หรือลิงก์ห้องก็ได้\nตัวอย่าง: `!qr 150 #ticket-3`');

            if (!targetId)
                return message.reply('❌ ระบุห้องปลายทางไม่ถูกต้อง ใช้การ mention ห้อง (#ชื่อห้อง), ไอดีห้อง, หรือลิงก์ห้องก็ได้ครับ');

            const targetChannel = message.guild.channels.cache.get(targetId);
            if (!targetChannel)
                return message.reply('❌ ไม่พบห้องปลายทางนี้ในเซิร์ฟเวอร์ครับ');

            const existing = activeTicketData[targetId];
            let qNum = existing?.qNum;
            if (!qNum) { qNum = queueCount++; saveQueue(); }

            activeTicketData[targetId] = {
                category:     existing?.category ?? 'manual',
                label:        existing?.label ?? 'ชำระเงิน',
                price:        amount,
                userId:       existing?.userId ?? null,
                qNum,
                payMethod:    'promptpay'
            };
            saveTickets();

            const qrEmbed = new EmbedBuilder()
                .setTitle('🧾 แจ้งยอดชำระเงิน')
                .setColor('#2ECC71')
                .setDescription(
`💰 ยอดชำระ: **${amount.toLocaleString()} บาท**

📌 สแกน QR พร้อมเพย์ด้านล่างนี้ หรือโอนมาที่เบอร์: \`${PROMPTPAY_NUMBER}\`

📸 **เมื่อโอนเสร็จแล้ว ให้ส่งรูปสลิปลงในห้องนี้ แล้วรอแอดมินตรวจสอบสักครู่นะครับ**`
                )
                .setImage(buildQrUrl(amount))
                .setFooter({ text: 'แอดมินจะตรวจสอบสลิปและดำเนินการให้ครับ' });

            await targetChannel.send({ embeds: [qrEmbed] });
            return message.reply(`✅ สร้าง QR ยอด **${amount.toLocaleString()} บาท** ส่งไปที่ ${targetChannel} แล้วครับ`);
        }

        // !rewards → รายการรางวัลที่รอส่ง
        if (command === '!rewards') {
            const pending = rewardsData.filter(r => r.status === 'pending');
            if (!pending.length) return message.reply({ content: '✅ ไม่มีรางวัลค้างส่ง', allowedMentions: { parse: [] } });
            const lines = pending.map(r => `• \`#${r.id}\` <@${r.userId}> — ${PRODUCT_LABEL[r.type]} (ออเดอร์ \`${r.sourceOrderNo}\`)`).join('\n');
            return message.reply({ embeds: [new EmbedBuilder().setColor('#E91E63').setTitle(`🎁 รางวัลค้างส่ง ${pending.length} รายการ`).setDescription(lines)], allowedMentions: { parse: [] } });
        }

        // !pointlog @ลูกค้า → ประวัติแต้มล่าสุด 10 รายการ
        if (command === '!pointlog') {
            const target = message.mentions.users.first();
            if (!target) return message.reply({ content: '❌ รูปแบบ: `!pointlog @ลูกค้า`', allowedMentions: { parse: [] } });
            const hist = (pointsData[target.id]?.history ?? []).slice(-10).reverse();
            if (!hist.length) return message.reply({ content: 'ยังไม่มีประวัติแต้ม', allowedMentions: { parse: [] } });
            const lines = hist.map(h => {
                const when = new Date(h.ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });
                const pts  = h.undone ? `~~+${h.points}~~ ❌ ยกเลิกแล้ว` : `+${h.points} แต้ม`;
                const rw   = h.rewards?.length ? ` · 🎁 ${h.rewards.map(r => PRODUCT_LABEL[r]).join(', ')}` : '';
                return `• ${when} · \`${h.orderNo}\` · ${PRODUCT_LABEL[h.product] ?? h.product} ${h.qty} ชิ้น · ${pts}${rw} · คงเหลือ ${h.balance}`;
            }).join('\n');
            return message.reply({ embeds: [new EmbedBuilder().setColor('#F1C40F').setTitle(`📜 ประวัติแต้ม ${target.username}`).setDescription(lines)], allowedMentions: { parse: [] } });
        }

        // !undo <เลขออเดอร์> [force] → หักแต้มย้อนหลัง
        if (command === '!undo') {
            const orderNo = args[1];
            const force   = args[2]?.toLowerCase() === 'force';
            if (!orderNo) return message.reply({ content: '❌ รูปแบบ: `!undo <เลขออเดอร์>`', allowedMentions: { parse: [] } });

            let uid = null, entry = null;
            for (const [id, rec] of Object.entries(pointsData)) {
                const h = (rec.history ?? []).find(x => x.orderNo === orderNo);
                if (h) { uid = id; entry = h; break; }
            }
            if (!entry) return message.reply({ content: `❌ ไม่พบออเดอร์ \`${orderNo}\``, allowedMentions: { parse: [] } });
            if (entry.undone) return message.reply({ content: 'ออเดอร์นี้ถูกหักแต้มไปแล้ว', allowedMentions: { parse: [] } });

            const sent = rewardsData.filter(r => r.sourceOrderNo === orderNo && r.status === 'sent');
            if (sent.length && !force)
                return message.reply({ content: `⚠️ ออเดอร์นี้มีรางวัลที่ส่งไปแล้ว ${sent.length} รายการ ถ้ายังจะหักแต้ม พิมพ์ \`!undo ${orderNo} force\``, allowedMentions: { parse: [] } });

            const rec = pointsData[uid];
            rec.points     = Math.max(0, rec.points - entry.points);
            rec.totalPieces = Math.max(0, (rec.totalPieces || 0) - entry.qty);
            entry.undone = true; entry.undoneAt = Date.now(); entry.undoneBy = message.author.id;
            rewardsData.forEach(r => { if (r.sourceOrderNo === orderNo && r.status === 'pending') r.status = 'void'; });
            savePoints(); saveRewards();
            await updateLeaderboard();
            return message.reply({ content: `↩️ ยกเลิกออเดอร์ \`${orderNo}\` แล้ว หัก ${entry.points} แต้มของ <@${uid}> คงเหลือ ${rec.points} แต้ม`, allowedMentions: { parse: [] } });
        }

        // !topbuyer → วางลีดเดอร์บอร์ดเรียลไทม์ในห้องนี้ (แทนของเดิม)
        if (command === '!topbuyer') {
            if (leaderboardData.channelId && leaderboardData.messageId) {
                const old = await client.channels.fetch(leaderboardData.channelId).then(c => c.messages.fetch(leaderboardData.messageId)).catch(() => null);
                if (old) await old.delete().catch(() => {});
            }
            const m = await message.channel.send({ embeds: [buildLeaderboardEmbed()], components: [buildLeaderboardRow()], allowedMentions: { parse: [] } });
            leaderboardData = { channelId: message.channel.id, messageId: m.id };
            saveLeaderboard();
            return;
        }

        // !points @ลูกค้า → ดูแต้ม
        if (command === '!points') {
            const target = message.mentions.users.first();
            if (!target) return message.reply('❌ รูปแบบ: `!points @ลูกค้า`');
            const p = pointsData[target.id]?.points ?? 0;
            return message.reply(`⭐ แต้มของ ${target} คือ **${p}** แต้ม (อีก ${Math.max(0, REWARD_THRESHOLD - p)} แต้มได้รางวัลสุ่ม)`);
        }

        // !addpoints @ลูกค้า จำนวน → เพิ่ม/ลดแต้มด้วยมือ (ใส่ -2 เพื่อลด)
        if (command === '!addpoints') {
            const target = message.mentions.users.first();
            const n      = parseInt(args[2], 10);
            if (!target || !Number.isFinite(n)) return message.reply('❌ รูปแบบ: `!addpoints @ลูกค้า จำนวน` (ลดแต้มใส่เลขติดลบ เช่น -2)');
            const rec = (pointsData[target.id] ??= { points: 0 });
            rec.points = Math.max(0, rec.points + n);
            savePoints();
            return message.reply(`✅ ปรับแต้ม ${target} ${n > 0 ? '+' : ''}${n} → คงเหลือ **${rec.points}** แต้ม`);
        }

        return;
    }

});

// ════════════════════════════════════════════════════════════
//  TICKET FLOW
//
//  create_ticket → สร้างห้องตั๋วทันที ไม่ถามอะไรเลย
//  แอดมินใช้ !qr [ยอด] [ห้อง] เพื่อแจ้งยอด+สร้าง QR เมื่อไหร่ก็ได้ ห้องไหนก็ได้
//  ADMIN: btn_work (รับงาน)  |  btn_done (ปิดห้อง — แอดมินหรือเจ้าของตั๋วกดได้)
// ════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
    try {
        // ─────────────────────────────────────────────────────────
        //  create_ticket → สร้างห้องตั๋วทันที
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'create_ticket') {
            await interaction.deferReply({ ephemeral: true });

            const channel = await interaction.guild.channels.create({
                name:   `ticket-${queueCount}`,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                    { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            activeTicketData[channel.id] = {
                category:     'ticket',
                label:        'Ticket',
                price:        0,
                userId:       interaction.user.id,
                qNum:         queueCount,
                payMethod:    'promptpay'
            };
            saveTickets();

            const embed = new EmbedBuilder()
                .setTitle(`🎫 Ticket #${queueCount}`)
                .setColor('#5865F2')
                .setDescription(`สวัสดีครับ <@${interaction.user.id}>\n\nแจ้งรายละเอียดที่ต้องการได้เลยครับ รอแอดมินเข้ามาดำเนินการและแจ้งยอดชำระให้สักครู่นะครับ`);

            const btns = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_work').setLabel('รับงาน').setEmoji(BTN_EMOJI.work).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_done').setLabel('ปิดห้อง').setEmoji(BTN_EMOJI.done).setStyle(ButtonStyle.Success)
            );

            const rewardEmbed = buildRewardEmbed(interaction.user.id);
            await channel.send({
                content: `🔔 <@&${ADMIN_ROLE_ID}>`,
                embeds: rewardEmbed ? [embed, rewardEmbed] : [embed],
                components: [btns, ...buildRewardRows(interaction.user.id)]
            });

            queueCount++;
            saveQueue();

            return interaction.editReply({ content: `✅ สร้างตั๋วเรียบร้อยแล้ว! แตะที่นี่ได้เลย 👉 ${channel}` });
        }

        // ════════════════════════════════════════════════════════════
        //  ADMIN TICKET BUTTONS
        // ════════════════════════════════════════════════════════════

        if (interaction.isButton() && interaction.customId === 'btn_work') {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return;
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            await interaction.reply({ content: `👨‍💻 <@${interaction.user.id}> รับงานนี้แล้วครับ กำลังดำเนินการให้${data.userId ? ` <@${data.userId}>` : ''}` });
            data.accepted = true;
            saveTickets();
            return interaction.channel.setName(`🛠️-${data.qNum}`).catch(() => {});
        }

        // ── ลูกค้าเช็คแต้มของตัวเอง (ตอบเฉพาะตัวเอง) ──
        if (interaction.isButton() && interaction.customId === 'points_me') {
            const uid = interaction.user.id;
            const rec = pointsData[uid] ?? { points: 0, totalPieces: 0, history: [] };
            const got = { nitro: 0, frame: 0 };
            for (const h of rec.history ?? []) if (!h.undone) for (const r of h.rewards ?? []) got[r]++;
            const pending = pendingRewardsOf(uid).length;
            const embed = new EmbedBuilder().setColor('#F1C40F').setTitle('⭐ แต้มของคุณ')
                .setDescription(
                    `${progressBar(rec.points)}  **${rec.points}/${REWARD_THRESHOLD}** แต้ม\n` +
                    `อีก **${Math.max(0, REWARD_THRESHOLD - rec.points)}** แต้มได้รางวัลสุ่ม\n\n` +
                    `🛒 ซื้อสะสม **${rec.totalPieces ?? 0}** ชิ้น\n` +
                    `🎁 รางวัลที่เคยได้: Nitro ${got.nitro} · กรอบรูป ${got.frame}\n` +
                    `📦 รางวัลที่รอรับ: **${pending}** รายการ${pending ? ' (เปิดตั๋วแจ้งแอดมินได้เลย)' : ''}`
                );
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // ── เช็คอันดับของตัวเอง: อันดับ จำนวนชิ้น ออเดอร์ และสินค้าที่เคยซื้อ ──
        if (interaction.isButton() && interaction.customId === 'lb_mine') {
            const uid = interaction.user.id;
            const rank = rankedUsers().findIndex(([id]) => id === uid) + 1;
            const rec  = pointsData[uid];
            if (!rank || !rec)
                return interaction.reply({ content: 'ยังไม่มีประวัติการซื้อของคุณครับ', ephemeral: true });

            const live = (rec.history ?? []).filter(h => !h.undone);
            const byProduct = {};
            for (const h of live) {
                byProduct[h.product] ??= { qty: 0, orders: 0 };
                byProduct[h.product].qty    += h.qty;
                byProduct[h.product].orders += 1;
            }
            const itemLines = Object.entries(byProduct)
                .map(([k, v]) => `• ${PRODUCT_LABEL[k] ?? k} — ${v.qty} ชิ้น (${v.orders} ออเดอร์)`)
                .join('\n') || '_ยังไม่มี_';

            const embed = new EmbedBuilder().setColor('#F1C40F').setTitle(`🔍 อันดับของคุณ #${rank}`)
                .setDescription(`🛒 ซื้อสะสม **${rec.totalPieces ?? 0}** ชิ้น · **${live.length}** ออเดอร์\n\n**สินค้าที่เคยซื้อ**\n${itemLines}`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // ── แอดมินกดส่งรางวัลแล้ว → อัปเดตปุ่ม โพสต์โชว์ ──
        if (interaction.isButton() && interaction.customId.startsWith('reward_sent_')) {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
                return interaction.reply({ content: '❌ เฉพาะแอดมินเท่านั้นครับ', ephemeral: true });

            const id = interaction.customId.slice('reward_sent_'.length);
            const rw = rewardsData.find(r => r.id === id);
            if (!rw || rw.status !== 'pending')
                return interaction.reply({ content: '❌ ไม่พบรายการนี้ หรือส่งไปแล้ว', ephemeral: true });

            rw.status = 'sent'; rw.sentAt = Date.now(); rw.sentBy = interaction.user.id;
            saveRewards();

            const rowsLeft = buildRewardRows(rw.userId);
            const embedLeft = buildRewardEmbed(rw.userId);
            await interaction.update({ embeds: embedLeft ? [interaction.message.embeds[0], embedLeft] : [interaction.message.embeds[0]], components: [interaction.message.components[0], ...rowsLeft] }).catch(() => {});

            const payload = rw.type === 'frame'
                ? { userId: rw.userId, productType: 'frame', productName: 'เมลพาสทั้งหมด (เลือกได้)', price: FRAME_REWARD_PRICE, orderNo: `RW-${rw.id}`, closeAt: rw.sentAt }
                : { userId: rw.userId, productType: 'nitro', productName: 'Nitro (รางวัลสะสมแต้ม)', price: 0, orderNo: `RW-${rw.id}`, closeAt: rw.sentAt };
            const showCh = await client.channels.fetch(PRODUCT_CHANNELS[payload.productType]).catch(() => null);
            if (showCh) await showCh.send({ embeds: [await buildOrderEmbed(payload)], allowedMentions: { parse: [] } }).catch(() => {});
            return interaction.followUp({ content: `✅ ส่งรางวัล \`#${rw.id}\` แล้ว`, ephemeral: true });
        }

        // ── กดปิดห้อง → เลือกประเภทสินค้า (Nitro / กรอบรูป) ──
        if (interaction.isButton() && interaction.customId === 'btn_done') {
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
                return interaction.reply({ content: '❌ เฉพาะแอดมินเท่านั้นที่ปิดห้องได้ครับ', ephemeral: true });

            return interaction.reply({
                content: '📦 **เลือกประเภทสินค้าของออเดอร์นี้**\nราคาจะดึงจาก QR ที่สร้างไว้ให้อัตโนมัติ · ถ้าไม่ได้ซื้อ ให้กดยกเลิก (ไม่ได้แต้ม)',
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('close_type_nitro').setLabel('Nitro').setEmoji('🎁').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('close_type_frame').setLabel('กรอบรูป').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('close_type_cancel').setLabel('ยกเลิก').setEmoji(BTN_EMOJI.close).setStyle(ButtonStyle.Danger)
                )],
                ephemeral: true
            });
        }

        // ── เลือกประเภท / ยกเลิก ──
        if (interaction.isButton() && ['close_type_nitro', 'close_type_frame', 'close_type_cancel'].includes(interaction.customId)) {
            const data = activeTicketData[interaction.channel.id];
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: '❌ เฉพาะแอดมินเท่านั้นครับ', ephemeral: true });
            if (!data) return interaction.reply({ content: '❌ ไม่พบข้อมูลตั๋ว', ephemeral: true });

            // ยกเลิก → ปิดห้องโดยไม่ให้แต้ม ไม่โพสต์โชว์
            if (interaction.customId === 'close_type_cancel') {
                data.productType = 'cancel';
                data.productName = '-';
                data.orderNo     = newOrderNo('cancel');
                data.pointsEarned = 0;
                data.pointsBalance = pointsData[data.userId]?.points ?? 0;
                await finishTicket(interaction.channel, data, { post: false });
                await interaction.reply({ embeds: [new EmbedBuilder().setColor('#E74C3C').setTitle('❌ ยกเลิกออเดอร์แล้ว')
                    .setDescription(`ออเดอร์นี้ถูกยกเลิก ไม่มีการให้แต้ม\nระบบจะลบห้องภายใน 1 วัน`)] });
                return interaction.channel.setName(`❌-${data.qNum}`).catch(() => {});
            }

            const type  = interaction.customId === 'close_type_nitro' ? 'nitro' : 'frame';
            const modal = new ModalBuilder()
                .setCustomId(`close_info_${type}`)
                .setTitle('📦 ข้อมูลสินค้า')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('product_name').setLabel('ชื่อสินค้า')
                            .setStyle(TextInputStyle.Short).setPlaceholder('เช่น กากสุด').setMaxLength(100).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('qty').setLabel('จำนวนชิ้น (1 ชิ้น = 1 แต้ม)')
                            .setStyle(TextInputStyle.Short).setValue('1').setMaxLength(6).setRequired(true)
                    )
                );
            return interaction.showModal(modal);
        }

        // ── กรอกข้อมูลแล้ว → นับแต้ม สุ่มรางวัล ปิดห้อง (ปิดกี่รอบก็ได้ ระบบนับเวลาใหม่ทุกรอบ) ──
        if (interaction.isModalSubmit() && interaction.customId.startsWith('close_info_')) {
            const type = interaction.customId.slice('close_info_'.length);
            const data = activeTicketData[interaction.channel.id];
            if (!data) return interaction.reply({ content: '❌ ไม่พบข้อมูลตั๋วนี้', ephemeral: true });

            const qty = parseInt(interaction.fields.getTextInputValue('qty').trim(), 10);
            if (!Number.isFinite(qty) || qty < 1)
                return interaction.reply({ content: '❌ จำนวนชิ้นต้องเป็นตัวเลข 1 ขึ้นไป ลองกดปิดห้องใหม่อีกครั้ง', ephemeral: true });

            data.productType  = type;
            data.productName  = interaction.fields.getTextInputValue('product_name').trim();
            data.quantity     = qty;
            data.orderNo      = newOrderNo(type);
            data.pointsEarned = qty * POINTS_PER_ITEM;
            data.rewards      = [];

            if (data.userId) {
                const rec = (pointsData[data.userId] ??= { points: 0, totalPieces: 0, history: [] });
                rec.totalPieces = (rec.totalPieces || 0) + qty;
                rec.points     += data.pointsEarned;
                while (rec.points >= REWARD_THRESHOLD) {
                    rec.points -= REWARD_THRESHOLD;
                    const r = rollReward();
                    data.rewards.push(r);
                    rewardsData.push({ id: newRewardId(), userId: data.userId, type: r, sourceOrderNo: data.orderNo, status: 'pending', createdAt: Date.now() });
                }
                data.pointsBalance = rec.points;
                (rec.history ??= []).push({
                    ts: Date.now(), orderNo: data.orderNo, product: type, productName: data.productName,
                    qty, points: data.pointsEarned, rewards: [...data.rewards], balance: rec.points, undone: false
                });
                if (rec.history.length > 200) rec.history.shift();
                savePoints();
                saveRewards();
            }

            await finishTicket(interaction.channel, data);

            const rewardText = data.rewards.length
                ? `\n\n🎉 ได้รับรางวัลสะสมแต้ม: **${data.rewards.map(r => PRODUCT_LABEL[r]).join(', ')}**\nแคปหน้าจอข้อความนี้ไว้ แล้วเปิดตั๋วใหม่เพื่อรับรางวัลกับแอดมินได้เลยนะคะ`
                : '';
            const embed = new EmbedBuilder()
                .setColor('#2ECC71').setTitle('✅ ปิดห้องแล้ว')
                .setDescription(`ห้องนี้ถูกปิดแล้วครับ ระบบจะลบห้องภายใน 1 วัน (ถ้ามีการปิดอีกจะนับเวลาใหม่)\n\n⭐ ได้รับ ${data.pointsEarned} แต้ม (คงเหลือ ${data.pointsBalance ?? 0} แต้ม)${rewardText}\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

            await interaction.reply({ embeds: [embed] });
            interaction.channel.setName(`✅-${data.qNum}`).catch(() => {});
            return;
        }

    } catch (err) {
        console.error('❌ Error:', err);
        try {
            if (interaction && !interaction.replied && !interaction.deferred)
                await interaction.reply({ content: '❌ เกิดข้อผิดพลาด กรุณาลองใหม่', ephemeral: true });
            else if (interaction && interaction.deferred)
                await interaction.followUp({ content: '❌ เกิดข้อผิดพลาดในการประมวลผล', ephemeral: true });
        } catch (_) {}
    }
});

// ==========================================
// [ 8. Login ]
// ==========================================
// ⚠️ ห้ามเขียนโทเคนตรงๆ ในโค้ด — ใส่ไว้ในไฟล์ .env เป็น TOKEN=your_token_here
client.login(process.env.DISCORDTOKEN || process.env.TOKEN);