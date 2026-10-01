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
const ADMIN_ROLE_ID              = '1555146265958944878'; // Role แอดมินที่รับออเดอร์/เรื่องสอบถามได้
const TICKET_CATEGORY_ID         = '1554881839422906496'; // Category สำหรับสร้างห้องออเดอร์ + ห้องสอบถาม
const DONE_CATEGORY_ID           = '1554881839745994884'; // Category ที่ย้ายห้องไปเก็บหลังจบงาน
const REVIEW_CHANNEL_ID          = '1554881839745994883'; // ห้องรีวิว (เอาไว้นับจำนวน + รีแอค)
const SLIP_NOTIFY_CHANNEL_ID = '1555145911879864380'; // ห้องแจ้งเตือนเมื่อตรวจสอบสลิปผ่านแล้ว (ทุกช่องทางการจ่าย)

const PROMPTPAY_NUMBER = '0621473585'; // เบอร์พร้อมเพย์รับเงิน
const TRUEMONEY_NUMBER = '0621473585'; // ⚠️ เบอร์ TrueMoney Wallet ที่รับโอน ถ้าคนละเบอร์กับพร้อมเพย์ให้แก้ตรงนี้
const EASYSLIP_API_KEY = process.env.EASYSLIP_API_KEY; // ⚠️ สมัครขอคีย์ที่ document.easyslip.com แล้วใส่ในไฟล์ .env

const QUEUE_FILE        = './queue.txt';
const TICKET_FILE       = './active_tickets.json';
const REVIEW_COUNT_FILE = './review_count.json';

// ==========================================
// [ 4. Packages Data ]
// ==========================================
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
let orderFlow        = {}; // orderFlow[userId] = { category: 'nitro'|'inquiry', pkg, price, question }
let activeTicketData = {};
let queueCount        = 1;
let reviewCount        = 0;

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
 * ตรวจสอบสลิปโอนเงินจริงผ่าน EasySlip API (https://document.easyslip.com)
 * ใช้ endpoint ต่างกันตามช่องทางจ่าย: ธนาคาร/พร้อมเพย์ ใช้ /verify/bank, TrueMoney ใช้ /verify/truewallet
 * @returns {Promise<{ok:boolean, reason:string, data?:object}>}
 */
async function verifySlip(imageUrl, expectedAmount, method = 'bank') {
    if (!EASYSLIP_API_KEY) {
        return { ok: false, reason: 'NO_API_KEY' };
    }

    const endpoint = method === 'truemoney'
        ? 'https://api.easyslip.com/v2/verify/truewallet'
        : 'https://api.easyslip.com/v2/verify/bank';

    try {
        const res = await axios.post(
            endpoint,
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

/** แทนที่/เติมเลขรีวิวในชื่อห้อง รูปแบบ 〔1074〕 — ไม่แตะข้อความอื่นในชื่อห้อง */
function buildReviewChannelName(currentName, count) {
    if (/〔\d+〕/.test(currentName)) {
        return currentName.replace(/〔\d+〕/, `〔${count}〕`);
    }
    return `${currentName}〔${count}〕`;
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
// [ 8. Message Handler: ตรวจจับสลิป + นับรีวิว + คำสั่งแอดมิน ]
// ==========================================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    // ── ระบบนับรีวิว ─────────────────────────────────────────────
    if (message.channel.id === REVIEW_CHANNEL_ID) {
        const isAdmin = message.member?.roles.cache.has(ADMIN_ROLE_ID);
        if (!isAdmin) {
            reviewCount++;
            saveReviewCount();

            const newName = buildReviewChannelName(message.channel.name, reviewCount);
            if (newName !== message.channel.name) {
                await message.channel.setName(newName).catch(err => {
                    console.error('⚠️ เปลี่ยนชื่อห้องรีวิวไม่ได้ (อาจติด rate limit ของ Discord):', err.message);
                });
            }

        }
        return;
    }

    // ── ตรวจจับ + ตรวจสอบสลิปอัตโนมัติในห้อง Ticket (เฉพาะห้องที่ต้องชำระเงิน) ──
    const ticketData = activeTicketData[message.channel.id];
    if (ticketData && message.channel.parentId === TICKET_CATEGORY_ID) {
        const isAdmin   = message.member.roles.cache.has(ADMIN_ROLE_ID);
        const isPayment = ticketData.category !== 'inquiry'; // ห้องสอบถามไม่ต้องเช็คสลิป
        const image     = message.attachments.find(a => (a.contentType || '').startsWith('image/'));

        if (isPayment && !isAdmin && image && !ticketData.slipVerified) {
            const checkingMsg = await message.reply('🔍 กำลังตรวจสอบสลิป กรุณารอสักครู่นะครับ...');

            const result = await verifySlip(image.url, ticketData.price, ticketData.payMethod);

            if (result.ok) {
                ticketData.slipVerified = true;
                ticketData.slipReceived = true;
                ticketData.slipInfo = {
                    transRef: result.data.rawSlip?.transRef ?? '-',
                    amount:   result.data.rawSlip?.amount?.amount ?? ticketData.price,
                    sender:   result.data.rawSlip?.sender?.account?.name?.th ?? 'ไม่ทราบชื่อ'
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

                // แจ้งเตือนที่ห้องแจ้งสลิปกลาง ทุกช่องทางการจ่าย (ไม่ใช่แค่ TrueMoney)
                const notifyChannel = client.channels.cache.get(SLIP_NOTIFY_CHANNEL_ID);
                if (notifyChannel) {
                    const methodLabel = ticketData.payMethod === 'truemoney' ? '💙 TrueMoney Wallet' : '💳 PromptPay';
                    await notifyChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor('#2ECC71')
                            .setTitle(`✅ มีการจ่ายผ่าน ${methodLabel} — ตรวจสอบสลิปผ่านแล้ว`)
                            .addFields(
                                { name: '👤 ลูกค้า',   value: `<@${ticketData.userId}>`, inline: true },
                                { name: '📦 รายการ',   value: ticketData.label ?? '-', inline: true },
                                { name: '💰 ยอดโอน',   value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                                { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false },
                                { name: '📍 ห้องออเดอร์', value: `<#${message.channel.id}>`, inline: false }
                            )]
                    }).catch(() => {});
                }
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

    const ADMIN_COMMANDS = ['!setupshop', '!setnitroprice'];
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
`╭━━━━━━━━━━━━━━━━━━━━━━╮
✨ **เลือกบริการที่ต้องการด้านล่างนี้ครับ**
╰━━━━━━━━━━━━━━━━━━━━━━╯

🚀 **เติมดิสคอร์ดไนโตร (Nitro)** — จ่ายได้ทั้ง PromptPay QR และ TrueMoney Wallet
❓ **สอบถามข้อมูล / ติดต่อแอดมิน**

💡 กดปุ่มเพื่อเริ่มใช้งานทันที`
            )
            .setColor('#00B2FF')
            .setFooter({ text: 'ระบบร้านค้าอัตโนมัติ' });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('start_nitro').setLabel('เติมไนโตร').setEmoji('🚀').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('start_inquiry').setLabel('สอบถาม').setEmoji('❓').setStyle(ButtonStyle.Secondary)
        );

        return message.channel.send({ embeds: [embed], components: [buttons] });
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
//  Step 1 ► start_nitro / start_inquiry → เปิดเมนู/modal
//  Step 2 ► sel_nitro_pkg      → เลือกวิธีจ่าย (PromptPay / TrueMoney)
//           modal_inquiry_submit → สร้างห้องสอบถามทันที (ไม่มีขั้นตอนชำระเงิน)
//  Step 3 ► pay_promptpay / pay_truemoney → สร้างห้องชำระเงิน
//
//  ADMIN: btn_work → btn_done  |  btn_cancel
// ════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
    try {
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

        // ─────────────────────────────────────────────────────────
        //  STEP 1  start_inquiry → เปิด modal กรอกคำถาม
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'start_inquiry') {
            const modal = new ModalBuilder()
                .setCustomId('modal_inquiry_submit')
                .setTitle('❓ สอบถามข้อมูล / ติดต่อแอดมิน');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('question_input')
                        .setLabel('คำถาม / เรื่องที่ต้องการสอบถาม')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('พิมพ์รายละเอียดที่ต้องการสอบถามได้เลยครับ')
                        .setRequired(true)
                        .setMaxLength(1000)
                )
            );

            return interaction.showModal(modal);
        }

        // ── ยกเลิกออเดอร์ ────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'cancel_order') {
            delete orderFlow[interaction.user.id];
            return interaction.update({ content: '❌ ยกเลิกการสั่งซื้อเรียบร้อยครับ', embeds: [], components: [] });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 2 (Nitro)  เลือกแพ็กเกจ → เลือกวิธีจ่ายเงิน
        // ─────────────────────────────────────────────────────────
        if (interaction.isStringSelectMenu() && interaction.customId === 'sel_nitro_pkg') {
            const pkg  = NITRO_PACKAGES.find(p => p.id === interaction.values[0]);
            const flow = orderFlow[interaction.user.id];
            if (!pkg || !flow) return interaction.reply({ content: '❌ ไม่พบออเดอร์ กรุณาเริ่มใหม่', ephemeral: true });

            flow.pkg   = pkg;
            flow.price = pkg.price;

            const embed = new EmbedBuilder()
                .setTitle('💳 เลือกวิธีชำระเงิน')
                .setColor('#F1C40F')
                .setDescription(`แพ็กเกจที่เลือก: **${pkg.label}**\nยอดชำระ: **${pkg.price.toLocaleString()} บาท**\n\nกรุณาเลือกวิธีชำระเงินด้านล่างนี้ครับ`);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pay_promptpay').setLabel('PromptPay QR').setEmoji('💳').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('pay_truemoney').setLabel('TrueMoney Wallet').setEmoji('💙').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('cancel_order').setLabel('ยกเลิก').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 2 (Inquiry)  กรอกคำถามเสร็จ → สร้างห้องสอบถามทันที
        // ─────────────────────────────────────────────────────────
        if (interaction.isModalSubmit() && interaction.customId === 'modal_inquiry_submit') {
            const question = interaction.fields.getTextInputValue('question_input').trim();

            await interaction.deferReply({ ephemeral: true });

            const channel = await interaction.guild.channels.create({
                name:   `ถาม-${queueCount}`,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                    { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            activeTicketData[channel.id] = {
                category: 'inquiry',
                question,
                price:    0,
                userId:   interaction.user.id,
                qNum:     queueCount,
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const embed = new EmbedBuilder()
                .setTitle(`❓ เรื่องสอบถาม (คิวที่ ${queueCount})`)
                .setColor('#5865F2')
                .setDescription(`สวัสดีครับ <@${interaction.user.id}>\n\n**คำถาม:**\n${question}\n\nรอแอดมินเข้ามาตอบกลับสักครู่นะครับ`);

            const btns = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_work').setLabel('รับเรื่อง').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_done').setLabel('ปิดห้อง').setEmoji('✅').setStyle(ButtonStyle.Success)
            );

            await channel.send({ content: `🔔 <@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [btns] });

            queueCount++;
            saveQueue();

            return interaction.editReply({ content: `✅ ส่งคำถามเรียบร้อยแล้ว! แตะที่นี่เพื่อดูคำตอบ 👉 ${channel}` });
        }

        // ─────────────────────────────────────────────────────────
        //  STEP 3  pay_promptpay / pay_truemoney → สร้างห้องชำระเงิน
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && (interaction.customId === 'pay_promptpay' || interaction.customId === 'pay_truemoney')) {
            const flow = orderFlow[interaction.user.id];
            if (!flow || !flow.price) return interaction.reply({ content: '❌ หมดเวลาทำรายการ กรุณาเริ่มใหม่', ephemeral: true });

            await interaction.deferReply({ ephemeral: true });

            const payMethod = interaction.customId === 'pay_truemoney' ? 'truemoney' : 'promptpay';

            const channel = await interaction.guild.channels.create({
                name:   `คิว-ไนโตร-${queueCount}`,
                parent: TICKET_CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                    { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            activeTicketData[channel.id] = {
                category:  'nitro',
                payMethod,
                label:     flow.pkg.label,
                price:     flow.price,
                userId:    interaction.user.id,
                qNum:      queueCount,
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const paymentInstructions = payMethod === 'truemoney'
                ? `📌 **วิธีชำระเงิน (TrueMoney Wallet):**\nเปิดแอป TrueMoney แล้วโอนเข้าเบอร์: \`${TRUEMONEY_NUMBER}\`\nยอดโอน: **${flow.price.toLocaleString()} บาท**`
                : `📌 **วิธีชำระเงิน (PromptPay):**\nสแกน QR พร้อมเพย์ด้านล่างนี้ หรือโอนมาที่เบอร์: \`${PROMPTPAY_NUMBER}\``;

            const embed = new EmbedBuilder()
                .setTitle(`🧾 หน้าชำระเงิน (คิวที่ ${queueCount})`)
                .setColor('#2ECC71')
                .setDescription(
`สวัสดีครับ <@${interaction.user.id}>

**ข้อมูลออเดอร์:**
🚀 แพ็กเกจ: **${flow.pkg.label}**
💰 ยอดชำระ: **${flow.price.toLocaleString()} บาท**

${paymentInstructions}

📸 **เมื่อโอนเสร็จแล้ว ให้ส่งรูปสลิปลงในห้องนี้ได้เลยครับ!**`
                )
                .setFooter({ text: 'เมื่อส่งสลิปแล้ว บอทจะตรวจสอบและตอบกลับอัตโนมัติ' });

            if (payMethod === 'promptpay') embed.setImage(buildQrUrl(flow.price));

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

            const text = data.category === 'inquiry'
                ? `👨‍💻 <@${interaction.user.id}> รับเรื่องสอบถามแล้ว กำลังตอบกลับให้ครับ <@${data.userId}>`
                : `👨‍💻 <@${interaction.user.id}> ได้เข้ามารับงานแล้ว! กำลังตรวจสอบสลิปและดำเนินการให้ครับ <@${data.userId}>`;

            await interaction.reply({ content: text });
            return interaction.channel.setName(`🛠️-รับงาน-${data.qNum}`).catch(() => {});
        }

        if (interaction.isButton() && interaction.customId === 'btn_done') {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) return;
            const data = activeTicketData[interaction.channel.id];
            if (!data) return;

            const doneText = data.category === 'inquiry'
                ? `✅ เรื่องสอบถามของ <@${data.userId}> ได้รับการตอบกลับและปิดห้องแล้วครับ`
                : `✅ <@${data.userId}> ได้รับ **${data.label}** เรียบร้อยแล้ว!`;

            const completionEmbed = new EmbedBuilder()
                .setColor('#2ECC71').setTitle('🎉 ทำรายการเสร็จสิ้นแล้ว')
                .setDescription(`${doneText}\n\n💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`);

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