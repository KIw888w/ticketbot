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
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, PermissionFlagsBits,
    ButtonBuilder, ButtonStyle
} = require('discord.js');

const fs    = require('fs');
const axios = require('axios');

// ==========================================
// [ 3. Config / Constants ]
// ==========================================
// ⚠️ แก้ไอดีเหล่านี้ให้ตรงกับเซิร์ฟเวอร์ของคุณก่อนรันบอท
const ADMIN_ROLE_ID      = '1512646616321097818'; // Role แอดมินที่รับออเดอร์ได้
const TICKET_CATEGORY_ID = '1551990531113099335'; // Category สำหรับสร้างห้องออเดอร์
const DONE_CATEGORY_ID   = '1551991162724683827'; // Category ที่ย้ายห้องไปเก็บหลังจบงาน
const REVIEW_CHANNEL_ID  = '1551991014854762638'; // ห้องรีวิว

const PROMPTPAY_NUMBER   = '0621473585'; // เบอร์พร้อมเพย์รับเงิน
const EASYSLIP_API_KEY   = process.env.EASYSLIP_API_KEY; // ⚠️ สมัครขอคีย์ที่ document.easyslip.com แล้วใส่ในไฟล์ .env

const QUEUE_FILE  = './queue.txt';
const TICKET_FILE = './active_tickets.json';

// ==========================================
// [ 4. Packages Data ]
// ==========================================
// ตารางแพ็กเกจโรบัค (ตั้งราคาเป็น 0 ไว้ก่อนตามที่สั่ง — แก้ราคาได้ด้วยคำสั่ง !setrobuxprice)
let ROBUX_PACKAGES = [
    { id: 'ro_40',    ro: 40,    price: 0 },
    { id: 'ro_80',    ro: 80,    price: 0 },
    { id: 'ro_400',   ro: 400,   price: 0 },
    { id: 'ro_800',   ro: 800,   price: 0 },
    { id: 'ro_1200',  ro: 1200,  price: 0 },
    { id: 'ro_1700',  ro: 1700,  price: 0 },
    { id: 'ro_3150',  ro: 3150,  price: 0 },
    { id: 'ro_4500',  ro: 4500,  price: 0 },
    { id: 'ro_10000', ro: 10000, price: 0 },
    { id: 'ro_22500', ro: 22500, price: 0 }
];

// แพ็กเกจ Discord Nitro
let NITRO_PACKAGES = [
    { id: 'nitro_basic_1m', label: 'Nitro Basic — 1 เดือน', price: 50   },
    { id: 'nitro_basic_1y', label: 'Nitro Basic — 1 ปี',    price: 550  },
    { id: 'nitro_full_1m',  label: 'Nitro (ปกติ) — 1 เดือน', price: 150  },
    { id: 'nitro_full_1y',  label: 'Nitro (ปกติ) — 1 ปี',    price: 1400 }
];

// ==========================================
// [ 5. Runtime State ]
// ==========================================
let orderFlow        = {}; // orderFlow[userId] = { category: 'robux'|'nitro', pkg, username }
let activeTicketData = {};
let queueCount        = 1;

// ==========================================
// [ 6. Helpers ]
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
}

function saveTickets() { fs.writeFileSync(TICKET_FILE, JSON.stringify(activeTicketData, null, 2)); }
function saveQueue()   { fs.writeFileSync(QUEUE_FILE, queueCount.toString()); }

loadPersistentData();

async function getRobloxPfp(username) {
    try {
        const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
            usernames: [username], excludeBannedUsers: true
        });
        if (!userRes.data.data.length) throw new Error('User not found');
        const userId   = userRes.data.data[0].id;
        const thumbRes = await axios.get(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
        );
        return { pfp: thumbRes.data.data[0].imageUrl, valid: true, userId };
    } catch (err) {
        console.error('❌ Roblox API Error:', err.message);
        return { pfp: 'https://tr.rbxcdn.com/38c6ed8c63333055ae701358385392e2/420/420/AvatarHeadshot/Png', valid: false, userId: null };
    }
}

/** ลิงก์รูป QR Code พร้อมเพย์ตามยอดเงิน (PromptPay.io) */
function buildQrUrl(amount) {
    return `https://promptpay.io/${PROMPTPAY_NUMBER}/${amount}.png`;
}

/**
 * ตรวจสอบสลิปโอนเงินจริงผ่าน EasySlip API (https://document.easyslip.com)
 * ส่งลิงก์รูปสลิปไปตรวจกับธนาคาร เทียบว่าโอนจริงไหม + ยอดตรงไหม + เคยใช้สลิปนี้ยืนยันไปแล้วหรือยัง
 * @returns {Promise<{ok:boolean, reason:string, data?:object}>}
 */
async function verifySlip(imageUrl, expectedAmount) {
    if (!EASYSLIP_API_KEY) {
        return { ok: false, reason: 'NO_API_KEY' };
    }

    try {
        const res = await axios.post(
            'https://api.easyslip.com/v2/verify/bank',
            {
                url: imageUrl,
                matchAmount: expectedAmount > 0 ? expectedAmount : undefined,
                checkDuplicate: true
            },
            { headers: { Authorization: `Bearer ${EASYSLIP_API_KEY}` } }
        );

        const body = res.data;
        if (!body.success) {
            return { ok: false, reason: body.error?.code || 'UNKNOWN_ERROR' };
        }

        const slip = body.data;
        if (slip.isDuplicate) {
            return { ok: false, reason: 'DUPLICATE_SLIP', data: slip };
        }
        if (expectedAmount > 0 && slip.isAmountMatched === false) {
            return { ok: false, reason: 'AMOUNT_MISMATCH', data: slip };
        }

        return { ok: true, reason: 'VERIFIED', data: slip };
    } catch (err) {
        const code = err.response?.data?.error?.code;
        if (code) return { ok: false, reason: code };
        console.error('❌ EasySlip API Error:', err.message);
        return { ok: false, reason: 'NETWORK_ERROR' };
    }
}

/** แปลงรหัสข้อผิดพลาดของ EasySlip เป็นข้อความภาษาไทยที่เข้าใจง่าย */
function slipErrorMessage(reason) {
    const map = {
        NO_API_KEY:       'ยังไม่ได้ตั้งค่าระบบตรวจสลิปอัตโนมัติ (EASYSLIP_API_KEY) — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        SLIP_NOT_FOUND:   'ไม่พบ QR Code ในรูปภาพ กรุณาส่งรูปสลิปที่เห็น QR ชัดเจนอีกครั้ง',
        SLIP_PENDING:     'สลิปธนาคารกรุงเทพยังไม่เข้าระบบ กรุณารอสักครู่แล้วส่งใหม่อีกครั้ง',
        INVALID_IMAGE_FORMAT: 'ไฟล์ที่ส่งมาไม่ใช่รูปภาพที่ถูกต้อง กรุณาส่งใหม่เป็นไฟล์ JPG/PNG',
        IMAGE_SIZE_TOO_LARGE: 'ไฟล์รูปใหญ่เกินไป (เกิน 4MB) กรุณาส่งรูปที่มีขนาดเล็กลง',
        DUPLICATE_SLIP:   'สลิปนี้เคยถูกใช้ยืนยันการชำระเงินไปแล้ว ไม่สามารถใช้ซ้ำได้ กรุณาติดต่อแอดมิน',
        AMOUNT_MISMATCH:  'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ กรุณาตรวจสอบและโอนให้ครบ หรือแจ้งแอดมิน',
        NETWORK_ERROR:    'ระบบตรวจสลิปขัดข้องชั่วคราว รอแอดมินตรวจสอบด้วยตนเองนะครับ'
    };
    return map[reason] || 'ตรวจสอบสลิปไม่สำเร็จ กรุณาลองส่งใหม่อีกครั้ง หรือรอแอดมินตรวจสอบด้วยตนเอง';
}

async function closeTicket(channelId, userId) {
    const chan = client.channels.cache.get(channelId);
    if (!chan) return;
    await chan.setParent(DONE_CATEGORY_ID, { lockPermissions: false }).catch(() => {});
    await chan.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
    delete activeTicketData[channelId];
    saveTickets();
}

// ==========================================
// [ 7. Client ]
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ==========================================
// [ 8. Message Handler: ตรวจจับสลิป + คำสั่งแอดมิน ]
// ==========================================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    // ── ตรวจจับ + ตรวจสอบสลิปอัตโนมัติในห้อง Ticket ─────────────
    const ticketData = activeTicketData[message.channel.id];
    if (ticketData && message.channel.parentId === TICKET_CATEGORY_ID) {
        const isAdmin = message.member.roles.cache.has(ADMIN_ROLE_ID);
        const image   = message.attachments.find(a => (a.contentType || '').startsWith('image/'));

        if (!isAdmin && image && !ticketData.slipVerified) {
            const checkingMsg = await message.reply('🔍 กำลังตรวจสอบสลิป กรุณารอสักครู่นะครับ...');

            const result = await verifySlip(image.url, ticketData.price);

            if (result.ok) {
                ticketData.slipVerified = true;
                ticketData.slipReceived = true;
                ticketData.slipInfo = {
                    transRef: result.data.rawSlip.transRef,
                    amount:   result.data.rawSlip.amount.amount,
                    sender:   result.data.rawSlip.sender?.account?.name?.th ?? 'ไม่ทราบชื่อ'
                };
                saveTickets();

                const verifiedEmbed = new EmbedBuilder()
                    .setColor('#2ECC71')
                    .setTitle('✅ ตรวจสอบสลิปสำเร็จ — รับยอดครับ')
                    .addFields(
                        { name: '👤 ผู้โอน',    value: ticketData.slipInfo.sender, inline: true },
                        { name: '💰 ยอดโอน',    value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                        { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false }
                    )
                    .setFooter({ text: 'ตรวจสอบผ่าน EasySlip • รอแอดมินดำเนินการต่อ' });

                await checkingMsg.edit({ content: null, embeds: [verifiedEmbed] });
                await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าโอนเงินแล้ว **ตรวจสอบสลิปผ่าน ✅** (คิวที่ ${ticketData.qNum})`);
            } else {
                // สลิปยังไม่ผ่าน — ไม่ mark ว่ารับยอดแล้ว ให้ลูกค้าส่งใหม่ได้
                await checkingMsg.edit({ content: `❌ ${slipErrorMessage(result.reason)}` });

                // กรณีระบบขัดข้อง/ไม่ได้ตั้งค่าคีย์ ให้แจ้งแอดมินมาตรวจเองแทน จะได้ไม่ตกหล่น
                if (['NO_API_KEY', 'NETWORK_ERROR'].includes(result.reason) && !ticketData.slipReceived) {
                    ticketData.slipReceived = true;
                    saveTickets();
                    await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าส่งสลิปมาแต่ระบบตรวจอัตโนมัติใช้งานไม่ได้ กรุณาตรวจสอบด้วยตนเองครับ (คิวที่ ${ticketData.qNum})`);
                }
            }
        }
        return;
    }

    // ── คำสั่งแอดมิน ────────────────────────────────────────────
    const args    = message.content.trim().split(/ +/);
    const command = args[0].toLowerCase();

    const ADMIN_COMMANDS = ['!setupshop', '!setrobuxprice', '!setnitroprice'];
    if (!ADMIN_COMMANDS.includes(command)) return;

    // แจ้งเตือนชัดเจนแทนการเงียบ เผื่อ role ไม่ตรง จะได้รู้ทันทีว่าปัญหาคืออะไร
    if (!message.member || !message.member.roles.cache.has(ADMIN_ROLE_ID)) {
        return message.reply(`❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้ครับ (ต้องมี role ไอดี \`${ADMIN_ROLE_ID}\`)`);
    }

    // !setupshop → โพสต์เมนูร้านค้าหลัก
    if (command === '!setupshop') {
        const embed = new EmbedBuilder()
            .setAuthor({ name: '🛒 SHOP', iconURL: client.user.displayAvatarURL() })
            .setTitle('🛍️ ยินดีต้อนรับสู่ร้านค้า')
            .setDescription(
`╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
✨ **เลือกบริการที่ต้องการเติมด้านล่างนี้ครับ**
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

💎 **เติมโรบัค (Robux)**
🚀 **เติมดิสคอร์ดไนโตร (Nitro)**

💡 กดปุ่มเพื่อเริ่มใช้งานทันที`
            )
            .setColor('#00B2FF')
            .setFooter({ text: 'ระบบร้านค้าอัตโนมัติ' });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_robux').setLabel('เติมโรบัค').setEmoji('💎').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('start_nitro').setLabel('เติมไนโตร').setEmoji('🚀').setStyle(ButtonStyle.Primary)
        );

        return message.channel.send({ embeds: [embed], components: [buttons] });
    }

    // !setrobuxprice [ro] [price]  → ตั้งราคาแพ็กเกจโรบัค
    if (command === '!setrobuxprice') {
        const ro    = parseInt(args[1]);
        const price = parseFloat(args[2]);
        const pkg   = ROBUX_PACKAGES.find(p => p.ro === ro);

        if (!pkg || isNaN(price) || price < 0)
            return message.reply('❌ รูปแบบไม่ถูกต้อง\nรูปแบบ: `!setrobuxprice [จำนวนro] [ราคาบาท]`\nตัวอย่าง: `!setrobuxprice 400 79`');

        pkg.price = price;
        return message.reply(`✅ ตั้งราคา **${pkg.ro.toLocaleString()} Robux** เป็น **${price} บาท** แล้วครับ`);
    }

    // !setnitroprice [id] [price]  → ตั้งราคาแพ็กเกจไนโตร
    if (command === '!setnitroprice') {
        const id    = args[1];
        const price = parseFloat(args[2]);
        const pkg   = NITRO_PACKAGES.find(p => p.id === id);

        if (!pkg || isNaN(price) || price < 0)
            return message.reply('❌ รูปแบบไม่ถูกต้อง\nรูปแบบ: `!setnitroprice [id] [ราคาบาท]`\nid ที่ใช้ได้: `nitro_basic_1m`, `nitro_basic_1y`, `nitro_full_1m`, `nitro_full_1y`');

        pkg.price = price;
        return message.reply(`✅ ตั้งราคา **${pkg.label}** เป็น **${price} บาท** แล้วครับ`);
    }
});

// ════════════════════════════════════════════════════════════
//  ORDER FLOW
//
//  Step 1 ► start_robux / start_nitro  → เลือกแพ็กเกจจากเมนู
//  Step 2 ► sel_robux_pkg              → เปิด modal ถามชื่อ Roblox
//           sel_nitro_pkg              → ไปสรุปออเดอร์ทันที (ไม่ต้องกรอกชื่อ)
//  Step 3 ► modal_robux_submit         → สรุปออเดอร์ + ปุ่มยืนยัน/ยกเลิก
//  Step 4 ► flow_confirm               → สร้างห้องชำระเงิน + QR พร้อมเพย์
//
//  ADMIN: btn_work → btn_done  |  btn_cancel
// ════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
    try {
        // ─────────────────────────────────────────────────────────
        //  STEP 1  start_robux → เมนูเลือกแพ็กเกจโรบัค
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'start_robux') {
            orderFlow[interaction.user.id] = { category: 'robux' };

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('sel_robux_pkg')
                .setPlaceholder('เลือกแพ็กเกจโรบัคที่ต้องการ...')
                .setMinValues(1)
                .setMaxValues(1);

            ROBUX_PACKAGES.forEach(pkg => {
                selectMenu.addOptions({
                    label:       `${pkg.ro.toLocaleString()} Robux`,
                    description: `ราคา: ${pkg.price.toLocaleString()} บาท`,
                    value:       pkg.id,
                    emoji:       '💎'
                });
            });

            const embed = new EmbedBuilder()
                .setTitle('💎 เลือกแพ็กเกจโรบัค')
                .setColor('#00B2FF')
                .setDescription('กรุณาเลือกจำนวนโรบัคที่ต้องการเติมจากเมนูด้านล่างนี้ครับ');

            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 1  start_nitro → เมนูเลือกแพ็กเกจไนโตร
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'start_nitro') {
            orderFlow[interaction.user.id] = { category: 'nitro' };

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('sel_nitro_pkg')
                .setPlaceholder('เลือกแพ็กเกจไนโตรที่ต้องการ...')
                .setMinValues(1)
                .setMaxValues(1);

            NITRO_PACKAGES.forEach(pkg => {
                selectMenu.addOptions({
                    label:       pkg.label,
                    description: `ราคา: ${pkg.price.toLocaleString()} บาท`,
                    value:       pkg.id,
                    emoji:       '🚀'
                });
            });

            const embed = new EmbedBuilder()
                .setTitle('🚀 เลือกแพ็กเกจ Discord Nitro')
                .setColor('#F47FFF')
                .setDescription('กรุณาเลือกแพ็กเกจไนโตรที่ต้องการจากเมนูด้านล่างนี้ครับ');

            const row = new ActionRowBuilder().addComponents(selectMenu);
            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // ── ยกเลิกออเดอร์ ────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'cancel_order') {
            delete orderFlow[interaction.user.id];
            return interaction.update({ content: '❌ ยกเลิกการสั่งซื้อเรียบร้อยครับ', embeds: [], components: [] });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 2 (Robux)  เลือกแพ็กเกจ → เปิด modal ถามชื่อ Roblox
        // ─────────────────────────────────────────────────────────
        if (interaction.isStringSelectMenu() && interaction.customId === 'sel_robux_pkg') {
            const pkg  = ROBUX_PACKAGES.find(p => p.id === interaction.values[0]);
            const flow = orderFlow[interaction.user.id];
            if (!pkg || !flow) return interaction.reply({ content: '❌ ไม่พบออเดอร์ กรุณาเริ่มใหม่', ephemeral: true });

            flow.pkg = pkg;

            const modal = new ModalBuilder()
                .setCustomId('modal_robux_submit')
                .setTitle('🎮 ระบุชื่อผู้ใช้ Roblox');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('username_input')
                        .setLabel('ชื่อผู้ใช้ Roblox (Username)')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('เช่น PlayerXYZ (ระบุให้ถูกต้อง)')
                        .setRequired(true)
                )
            );

            return interaction.showModal(modal);
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 2 (Nitro)  เลือกแพ็กเกจ → สรุปออเดอร์ทันที
        // ─────────────────────────────────────────────────────────
        if (interaction.isStringSelectMenu() && interaction.customId === 'sel_nitro_pkg') {
            const pkg  = NITRO_PACKAGES.find(p => p.id === interaction.values[0]);
            const flow = orderFlow[interaction.user.id];
            if (!pkg || !flow) return interaction.reply({ content: '❌ ไม่พบออเดอร์ กรุณาเริ่มใหม่', ephemeral: true });

            flow.pkg = pkg;

            const embed = new EmbedBuilder()
                .setTitle('🧾 สรุปการสั่งซื้อ Nitro')
                .setColor('#F1C40F')
                .setDescription('กรุณาตรวจสอบข้อมูลก่อนกดยืนยันเพื่อไปหน้าชำระเงินครับ')
                .addFields(
                    { name: '🚀 แพ็กเกจ', value: pkg.label, inline: true },
                    { name: '💰 ยอดชำระ', value: `**${pkg.price.toLocaleString()} บาท**`, inline: true }
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('flow_confirm').setLabel('✅ ยืนยันเพื่อชำระเงิน').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('cancel_order').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 3 (Robux)  กรอกชื่อเสร็จ → สรุปออเดอร์
        // ─────────────────────────────────────────────────────────
        if (interaction.isModalSubmit() && interaction.customId === 'modal_robux_submit') {
            const flow = orderFlow[interaction.user.id];
            if (!flow || !flow.pkg) return interaction.reply({ content: '❌ ไม่พบออเดอร์ กรุณาเริ่มใหม่', ephemeral: true });

            flow.username = interaction.fields.getTextInputValue('username_input').trim();

            const embed = new EmbedBuilder()
                .setTitle('🧾 สรุปการสั่งซื้อโรบัค')
                .setColor('#F1C40F')
                .setDescription('กรุณาตรวจสอบข้อมูลก่อนกดยืนยันเพื่อไปหน้าชำระเงินครับ')
                .addFields(
                    { name: '🎮 Username', value: `\`${flow.username}\``, inline: true },
                    { name: '💎 จำนวนโรบัค', value: `**${flow.pkg.ro.toLocaleString()}** R$`, inline: true },
                    { name: '💰 ยอดชำระ', value: `**${flow.pkg.price.toLocaleString()} บาท**`, inline: false }
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('flow_confirm').setLabel('✅ ยืนยันเพื่อชำระเงิน').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('cancel_order').setLabel('❌ ยกเลิก').setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 4  flow_confirm → สร้างห้องชำระเงิน + QR พร้อมเพย์
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'flow_confirm') {
            const flow = orderFlow[interaction.user.id];
            if (!flow || !flow.pkg) return interaction.reply({ content: '❌ หมดเวลาทำรายการ กรุณาเริ่มใหม่', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });

            const isRobux = flow.category === 'robux';
            let pfp = null;

            if (isRobux) {
                const res = await getRobloxPfp(flow.username);
                if (!res.valid) {
                    return interaction.editReply({ content: `❌ ไม่พบผู้ใช้ Roblox ชื่อ **${flow.username}** กรุณาตรวจสอบชื่อแล้วลองใหม่ครับ` });
                }
                pfp = res.pfp;
            }

            const channel = await interaction.guild.channels.create({
                name:   isRobux ? `คิว-โรบัค-${queueCount}` : `คิว-ไนโตร-${queueCount}`,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                    { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            activeTicketData[channel.id] = {
                category: flow.category,
                username: flow.username ?? null,
                label:    isRobux ? `${flow.pkg.ro.toLocaleString()} Robux` : flow.pkg.label,
                amount:   isRobux ? flow.pkg.ro : null,
                price:    flow.pkg.price,
                userId:   interaction.user.id,
                pfp,
                qNum:     queueCount,
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const qrUrl = buildQrUrl(flow.pkg.price);

            const embed = new EmbedBuilder()
                .setTitle(`🧾 หน้าชำระเงิน (คิวที่ ${queueCount})`)
                .setColor('#2ECC71')
                .setDescription(
`สวัสดีครับ <@${interaction.user.id}>

**ข้อมูลออเดอร์:**
${isRobux ? `🎮 Username: \`${flow.username}\`\n💎 จำนวนที่เติม: **${flow.pkg.ro.toLocaleString()} Robux**` : `🚀 แพ็กเกจ: **${flow.pkg.label}**`}
💰 ยอดชำระ: **${flow.pkg.price.toLocaleString()} บาท**

📌 **วิธีชำระเงิน:**
สแกน QR พร้อมเพย์ด้านล่างนี้ หรือโอนมาที่เบอร์: \`${PROMPTPAY_NUMBER}\`

📸 **เมื่อโอนเสร็จแล้ว ให้ส่งรูปสลิปลงในห้องนี้ได้เลยครับ!**`
                )
                .setImage(qrUrl);

            if (pfp) embed.setThumbnail(pfp);
            embed.setFooter({ text: 'เมื่อส่งสลิปแล้ว บอทจะตอบกลับอัตโนมัติ' });

            const btns = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_work').setLabel('แอดมินรับงาน').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_done').setLabel('สำเร็จ').setEmoji('✅').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('btn_cancel').setLabel('ยกเลิก').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );

            await channel.send({ content: `<@${interaction.user.id}> กรุณาชำระเงินและส่งสลิปครับ 💸`, embeds: [embed], components: [btns] });

            queueCount++;
            saveQueue();
            delete orderFlow[interaction.user.id];

            return interaction.editReply({ content: `✅ สร้างหน้าชำระเงินเรียบร้อยแล้ว! แตะที่นี่เพื่อชำระเงิน 👉 ${channel}` });
        }

        // ════════════════════════════════════════════════════════════
        //  ADMIN TICKET BUTTONS
        // ════════════════════════════════════════════════════════════

        if (interaction.isButton() && interaction.customId === 'btn_work') {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return;
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            await interaction.reply({ content: `👨‍💻 <@${interaction.user.id}> ได้เข้ามารับงานแล้ว! กำลังตรวจสอบสลิปและดำเนินการให้ครับ <@${data.userId}>` });
            return interaction.channel.setName(`🛠️-รับงาน-${data.qNum}`).catch(() => {});
        }

        if (interaction.isButton() && interaction.customId === 'btn_done') {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return;
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            const doneText = data.category === 'robux'
                ? `✅ <@${data.userId}> ได้รับโรบัค **${data.amount.toLocaleString()} R$** เรียบร้อยแล้ว!`
                : `✅ <@${data.userId}> ได้รับ **${data.label}** เรียบร้อยแล้ว!`;

            const completionEmbed = new EmbedBuilder()
                .setColor('#2ECC71').setTitle('🎉 ทำรายการเสร็จสิ้นแล้ว')
                .setDescription(`${doneText}\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

            if (data.pfp) completionEmbed.setThumbnail(data.pfp);

            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.reply({ content: `<@${data.userId}>`, embeds: [completionEmbed] });
            await interaction.channel.setName(`✅-เสร็จงาน-${data.qNum}`).catch(() => {});

            setTimeout(() => closeTicket(interaction.channel.id, data.userId), 30 * 60 * 1000);
            return;
        }

        if (interaction.isButton() && interaction.customId === 'btn_cancel') {
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            if (interaction.user.id !== data.userId && !interaction.member.roles.cache.has(ADMIN_ROLE_ID))
                return interaction.reply({ content: '❌ คุณไม่มีสิทธิ์ยกเลิกออเดอร์นี้ครับ', ephemeral: true });

            const cancelEmbed = new EmbedBuilder()
                .setColor('#E74C3C').setTitle('❌ ยกเลิกออเดอร์')
                .setDescription('ออเดอร์นี้ถูกยกเลิกแล้วครับ ห้องจะถูกปิดอัตโนมัติในอีกสักครู่');

            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.reply({ embeds: [cancelEmbed] });
            await interaction.channel.setName(`❌-ยกเลิก-${data.qNum}`).catch(() => {});

            setTimeout(() => closeTicket(interaction.channel.id, data.userId), 15 * 60 * 1000);
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
// [ 11. Login ]
// ==========================================
// ⚠️ ห้ามเขียนโทเคนตรงๆ ในโค้ด — ใส่ไว้ในไฟล์ .env เป็น TOKEN=your_token_here
client.login(process.env.TOKEN);