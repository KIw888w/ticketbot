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

const LOG_CHANNEL_ID = '1568982552969224315';   // ห้อง log สรุปตอนลบห้องตั๋ว (ว่าง = ไม่ส่ง log)
// ห้องโชว์สินค้าที่จัดส่งแล้ว (ส่งสรุปออเดอร์ให้คนอื่นเห็นตอนกดปิดห้อง)
const PRODUCT_CHANNELS = { nitro: '1566033586744987698', frame: '1566033685491486720' };
const PRODUCT_LABEL    = { nitro: 'Nitro', frame: 'กรอบรูป' };

// ==========================================
// [ 4. Runtime State ]
// ==========================================
let activeTicketData = {}; // activeTicketData[channelId] = { category, label, price, userId, qNum, payMethod }
let queueCount         = 1;
let reviewCount         = 0;

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
    if (fs.existsSync(QUEUE_FILE)) queueCount = parseInt(fs.readFileSync(QUEUE_FILE, 'utf8')) || 1;

    const reviewFile = loadJSON(REVIEW_COUNT_FILE, null);
    if (reviewFile && typeof reviewFile.count === 'number') reviewCount = reviewFile.count;
}

function saveTickets()     { fs.writeFileSync(TICKET_FILE, JSON.stringify(activeTicketData, null, 2)); }
function saveQueue()       { fs.writeFileSync(QUEUE_FILE, queueCount.toString()); }
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
    if (closeTimers.has(channelId)) return;
    const timer = setTimeout(() => {
        closeTimers.delete(channelId);
        closeTicket(channelId);
    }, Math.max(0, delayMs));
    closeTimers.set(channelId, timer);
}

/** สถานะตาม ticket: จัดส่งสำเร็จ (กดปิดแล้ว) / กำลังดำเนินการ (รับงานแล้ว) / รอดำเนินการ */
function orderStatusText(data) {
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
            `📋 สถานะสั่งซื้อ : ${orderStatusText(data)}`
        )
        .setFooter({ text: `Order No. / Ord #${data.orderNo || '-'}` })
        .setTimestamp();
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

        const ADMIN_COMMANDS = ['!setupshop', '!qr'];
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
                new ButtonBuilder().setCustomId('create_ticket').setLabel('ᴄʀᴇᴀᴛᴇ ᴛɪᴄᴋᴇᴛ').setEmoji('🎫').setStyle(ButtonStyle.Success)
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
                new ButtonBuilder().setCustomId('btn_work').setLabel('รับงาน').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_done').setLabel('ปิดห้อง').setEmoji('✅').setStyle(ButtonStyle.Success)
            );

            await channel.send({ content: `🔔 <@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [btns] });

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

        // ── กดปิดห้อง → เลือกประเภทสินค้า (Nitro / กรอบรูป) ──
        if (interaction.isButton() && interaction.customId === 'btn_done') {
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            const isAdmin = interaction.member.roles.cache.has(ADMIN_ROLE_ID);
            if (!isAdmin && interaction.user.id !== data.userId)
                return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปิดห้องนี้ครับ', ephemeral: true });

            if (data.closeAt)
                return interaction.reply({ content: '⏳ ห้องนี้ถูกปิดไปแล้ว รอการลบอัตโนมัติ 1 วันครับ', ephemeral: true });

            return interaction.reply({
                content: '📦 **เลือกประเภทสินค้าของออเดอร์นี้**\nราคาจะดึงจาก QR ที่สร้างไว้ให้อัตโนมัติ',
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('close_type_nitro').setLabel('Nitro').setEmoji('🎁').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('close_type_frame').setLabel('กรอบรูป').setEmoji('🖼️').setStyle(ButtonStyle.Secondary)
                )],
                ephemeral: true
            });
        }

        // ── เลือกประเภทแล้ว → กรอกชื่อสินค้า ──
        if (interaction.isButton() && (interaction.customId === 'close_type_nitro' || interaction.customId === 'close_type_frame')) {
            const data = activeTicketData[interaction.channel.id];
            if (!data || data.closeAt) return interaction.reply({ content: '⏳ ห้องนี้ถูกปิดไปแล้วหรือไม่พบข้อมูลตั๋ว', ephemeral: true });

            const type  = interaction.customId === 'close_type_nitro' ? 'nitro' : 'frame';
            const modal = new ModalBuilder()
                .setCustomId(`close_info_${type}`)
                .setTitle('📦 ข้อมูลสินค้า')
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('product_name')
                        .setLabel('ชื่อสินค้า')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('เช่น กากสุด')
                        .setMaxLength(100)
                        .setRequired(true)
                ));
            return interaction.showModal(modal);
        }

        // ── กรอกชื่อสินค้าแล้ว → ปิดห้อง ตั้งเวลาลบ 1 วัน + โพสต์สรุปไปห้องโชว์สินค้า ──
        if (interaction.isModalSubmit() && interaction.customId.startsWith('close_info_')) {
            const type = interaction.customId.slice('close_info_'.length);
            const data = activeTicketData[interaction.channel.id];
            if (!data) return interaction.reply({ content: '❌ ไม่พบข้อมูลตั๋วนี้', ephemeral: true });
            if (data.closeAt) return interaction.reply({ content: '⏳ ห้องนี้ถูกปิดไปแล้วครับ', ephemeral: true });

            data.productType = type;
            data.productName = interaction.fields.getTextInputValue('product_name').trim();
            data.orderNo     = `DECO-${type.toUpperCase()}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
            data.status      = 'done';
            data.closeAt     = Date.now() + CLOSE_DELAY_MS;
            saveTickets();
            scheduleClose(interaction.channel.id, CLOSE_DELAY_MS);

            const showCh = await client.channels.fetch(PRODUCT_CHANNELS[type]).catch(() => null);
            if (showCh) await showCh.send({ embeds: [await buildOrderEmbed(data)], allowedMentions: { parse: [] } })
                .catch(err => console.error('❌ โพสต์สรุปไปห้องโชว์ไม่สำเร็จ:', err.message));
            else console.error(`❌ ไม่พบห้องโชว์สินค้า ${PRODUCT_CHANNELS[type]}`);

            const embed = new EmbedBuilder()
                .setColor('#2ECC71').setTitle('✅ ปิดห้องแล้ว')
                .setDescription(`ห้องนี้ถูกปิดแล้วครับ ระบบจะลบห้องภายใน 1 วัน\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

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