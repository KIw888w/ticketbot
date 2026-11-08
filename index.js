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
    PermissionFlagsBits, ButtonBuilder, ButtonStyle, Events
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
const REVIEW_REACTIONS = ['237291pinkhearts', 'blackverified']; // อีโมจิที่บอทกดใต้ "ทุกข้อความ" ในห้องรีวิว (กดเรียงตามลำดับ) — ใส่เป็นชื่ออีโมจิเซิร์ฟเวอร์ (ไม่ต้องใส่ :) หรืออีโมจิธรรมดา เช่น '❤️'

const QUEUE_FILE        = './queue.txt';
const TICKET_FILE       = './active_tickets.json';
const REVIEW_COUNT_FILE = './review_count.json';

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

// ── ปิดตั๋ว: รอ 10 นาที แล้วย้ายเข้าหมวดเก็บงาน + ซ่อนห้องจากลูกค้า ──
const CLOSE_DELAY_MS = 10 * 60 * 1000;
const closeTimers    = new Map(); // channelId -> timeout

function scheduleClose(channelId, delayMs) {
    if (closeTimers.has(channelId)) return;
    const timer = setTimeout(() => {
        closeTimers.delete(channelId);
        closeTicket(channelId);
    }, Math.max(0, delayMs));
    closeTimers.set(channelId, timer);
}

async function closeTicket(channelId) {
    const data   = activeTicketData[channelId];
    const userId = data?.userId;

    try {
        const chan = await client.channels.fetch(channelId);
        await chan.setParent(DONE_CATEGORY_ID, { lockPermissions: false });
        if (userId) await chan.permissionOverwrites.edit(userId, { ViewChannel: false });
        console.log(`📦 ตั๋ว #${data?.qNum ?? '?'} ย้ายเข้าหมวดเก็บงานและซ่อนจากลูกค้าแล้ว`);
    } catch (err) {
        if (err.code !== 10003) { // 10003 = Unknown Channel (ห้องถูกลบไปแล้ว ก็ถือว่าเสร็จ)
            console.error(`❌ ย้าย/ซ่อนตั๋ว ${channelId} ไม่สำเร็จ (เช็ค DONE_CATEGORY_ID, สิทธิ์ Manage Channels, หมวดเต็ม 50 ห้อง):`, err.message);
            return; // เก็บข้อมูลไว้ จะลองใหม่ตอนบอทเริ่มรันครั้งถัดไป
        }
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

/** แปลงค่าใน REVIEW_REACTIONS เป็นอีโมจิที่ message.react() ใช้ได้ (ชื่ออีโมจิเซิร์ฟเวอร์ → หาจากชื่อ) */
async function resolveReactionEmoji(guild, input) {
    const raw = String(input).trim();
    if (!/^[A-Za-z0-9_]+$/.test(raw) || /^\d+$/.test(raw)) return raw; // อีโมจิยูนิโค้ด / <:ชื่อ:ไอดี> / ไอดีล้วน ใช้ตรงๆ

    const find = (emojis) => emojis.find(e => e.name === raw) || emojis.find(e => e.name?.toLowerCase() === raw.toLowerCase());
    let emoji = find(guild.emojis.cache) || find(client.emojis.cache);
    if (!emoji) {
        await guild.emojis.fetch().catch(() => {});
        emoji = find(guild.emojis.cache);
    }
    return emoji || null;
}

/** กดรีแอคชั่นทุกอันใน REVIEW_REACTIONS ใต้ข้อความในห้องรีวิว — ไม่โยน error ออกไป จะได้ไม่กระทบระบบนับรีวิว */
async function reactToReviewMessage(message) {
    for (const name of REVIEW_REACTIONS) {
        try {
            const emoji = await resolveReactionEmoji(message.guild, name);
            if (!emoji) {
                console.error(`❌ ไม่พบอีโมจิชื่อ "${name}" — เช็คว่าอีโมจิอยู่ในเซิร์ฟเวอร์ที่บอทอยู่ และสะกดชื่อถูก`);
                continue;
            }
            await message.react(emoji);
        } catch (err) {
            console.error(`❌ กดรีแอคชั่น "${name}" ในห้องรีวิวไม่ได้ (เช็คสิทธิ์ Add Reactions + Read Message History + Use External Emojis ของบอทในห้องนี้):`, err.message);
        }
    }
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
    if (!message.guild) return;

    // ── ห้องรีวิว: กดรีแอคชั่นให้ทุกข้อความ (ใครพิมพ์อะไรมาก็กด รวมแอดมินและบอทอื่น ยกเว้นข้อความของบอทเอง) ──
    if (message.channel.id === REVIEW_CHANNEL_ID && message.author.id !== client.user.id) {
        reactToReviewMessage(message); // ไม่ await — ไม่ให้การกดอีโมจิหน่วงระบบนับรีวิว
    }

    if (message.author.bot) return;

    // ── ระบบนับรีวิว (เช็คก่อนคำสั่ง เพื่อให้รีวิวที่ขึ้นต้นด้วย ! ก็นับ) ──
    if (message.channel.id === REVIEW_CHANNEL_ID) {
        if (message.member?.roles.cache.has(ADMIN_ROLE_ID)) {
            console.log('ℹ️ ข้อความของแอดมินในห้องรีวิว — ไม่นับ');
        } else {
            reviewCount++;
            saveReviewCount();
            console.log(`⭐ นับรีวิวใหม่ → ${reviewCount}`);
            scheduleReviewRename();
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
            return interaction.channel.setName(`🛠️-${data.qNum}`).catch(() => {});
        }

        if (interaction.isButton() && interaction.customId === 'btn_done') {
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            const isAdmin = interaction.member.roles.cache.has(ADMIN_ROLE_ID);
            if (!isAdmin && interaction.user.id !== data.userId)
                return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ปิดห้องนี้ครับ', ephemeral: true });

            if (data.closeAt)
                return interaction.reply({ content: '⏳ ห้องนี้ถูกปิดไปแล้ว กำลังรอย้ายเข้าหมวดเก็บงานครับ', ephemeral: true });

            // บันทึกเวลาปิดลงไฟล์ก่อน เผื่อบอทรีสตาร์ทระหว่างรอ แล้วตั้งเวลาย้าย+ซ่อน
            data.closeAt = Date.now() + CLOSE_DELAY_MS;
            saveTickets();
            scheduleClose(interaction.channel.id, CLOSE_DELAY_MS);

            const embed = new EmbedBuilder()
                .setColor('#2ECC71').setTitle('✅ ปิดห้องแล้ว')
                .setDescription(`ห้องนี้ถูกปิดแล้วครับ ระบบจะย้ายและซ่อนห้องภายใน ${CLOSE_DELAY_MS / 60000} นาที\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.reply({ embeds: [embed] });
            // ไม่ await: ถ้าติด rate limit ของการเปลี่ยนชื่อห้อง จะได้ไม่ขวางการย้ายห้อง
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