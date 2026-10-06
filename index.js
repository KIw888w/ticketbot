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

const fs    = require('fs');
const axios = require('axios');

// ==========================================
// [ 3. Config / Constants ]
// ==========================================
// ⚠️ แก้ไอดีเหล่านี้ให้ตรงกับเซิร์ฟเวอร์ของคุณก่อนรันบอท
const ADMIN_ROLE_ID          = '1555146265958944878'; // Role แอดมินที่รับตั๋ว/สร้าง QR/ปิดห้องได้
const TICKET_CATEGORY_ID     = '1554881839422906495'; // Category สำหรับสร้างห้องตั๋ว
const REVIEW_CHANNEL_ID      = '1554881839745994883'; // ห้องรีวิว (เอาไว้นับจำนวน)
const SLIP_NOTIFY_CHANNEL_ID = '1555145911879864380'; // ห้องแจ้งเตือนเมื่อตรวจสอบสลิปผ่านแล้ว
const LOG_CHANNEL_ID         = '1555884270680145960'; // ห้อง log สรุปรายการของลูกค้า (ส่งก่อนลบห้องตั๋ว)

// อิโมจิ (ใส่เป็นไอดี) — อิโมจิต้องอยู่ในเซิร์ฟเวอร์ที่บอทอยู่ (หรืออัปโหลดเป็น Application Emoji)
// ถ้าบอทหาอิโมจิไม่เจอ ปุ่มจะใช้อิโมจิธรรมดาแทน และมีคำเตือนใน Console
const WORK_EMOJI_ID = '1556884242041020456'; // ปุ่ม "รับงาน" (blackverified)
const DONE_EMOJI_ID = '1285847714076033114'; // ปุ่ม "ปิดห้อง"
// อิโมจิที่บอทกดรีแอคชั่นให้ทุกข้อความในห้องรีวิว (REVIEW_CHANNEL_ID)
const REVIEW_REACTION_IDS = ['1556884242041020456', '1557040976973795438'];

const CLOSE_DELAY_MS = 10 * 60 * 1000;      // กดปิดห้องแล้ว รอ 10 นาที → ส่ง log แล้วลบห้อง
const AUTO_CLOSE_MS  = 24 * 60 * 60 * 1000; // ลูกค้าไม่พิมพ์ในตั๋วครบ 24 ชม. → ปิดอัตโนมัติ (ข้อความแอดมินไม่นับ)

const PROMPTPAY_NUMBER = '0621473585'; // เบอร์พร้อมเพย์รับเงิน
const SLIPOK_API_KEY   = process.env.SLIPOK_API_KEY;   // ⚠️ API Key จากหน้า SlipOK (slipok.com) ใส่ในไฟล์ .env
const SLIPOK_BRANCH_ID = process.env.SLIPOK_BRANCH_ID; // ⚠️ Branch ID (รหัสสาขา) จาก SlipOK ใส่ในไฟล์ .env

const QUEUE_FILE        = './queue.txt';
const TICKET_FILE       = './active_tickets.json';
const REVIEW_COUNT_FILE = './review_count.json';

// ==========================================
// [ 4. Runtime State ]
// ==========================================
// activeTicketData[channelId] = {
//   category, label, price, userId, qNum, payMethod, slipReceived, slipVerified, slipInfo,
//   payments[], openedAt, lastActivityAt, panelMessageId, acceptedBy, acceptedAt,
//   closeAt, closedBy, autoClosed, logged, closeTries
// }
let activeTicketData = {};
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

// เซฟแบบหน่วง (ใช้กับเวลาคุยล่าสุด จะได้ไม่เขียนไฟล์ทุกข้อความ)
let saveTicketsTimer = null;
function saveTicketsSoon() {
    if (saveTicketsTimer) return;
    saveTicketsTimer = setTimeout(() => { saveTicketsTimer = null; saveTickets(); }, 30 * 1000);
}

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

/**
 * ตรวจสอบสลิปโอนเงินจริงผ่าน SlipOK API (https://slipok.com)
 * ส่ง URL รูปสลิปพร้อมยอดที่ต้องชำระ (amount) และเปิด log เพื่อให้ SlipOK ตรวจสลิปซ้ำให้
 * @returns {Promise<{ok:boolean, reason:string, data?:object}>}
 */
async function verifySlip(imageUrl, expectedAmount) {
    if (!SLIPOK_API_KEY || !SLIPOK_BRANCH_ID) {
        return { ok: false, reason: 'NO_API_KEY' };
    }

    const endpoint = `https://api.slipok.com/api/line/apikey/${SLIPOK_BRANCH_ID}`;

    try {
        const res = await axios.post(
            endpoint,
            {
                url: imageUrl,
                log: true,
                ...(expectedAmount > 0 ? { amount: expectedAmount } : {})
            },
            { headers: { 'x-authorization': SLIPOK_API_KEY, 'Content-Type': 'application/json' } }
        );

        const body = res.data;
        if (!body?.success || !body.data) {
            return { ok: false, reason: String(body?.code ?? 'UNKNOWN_ERROR') };
        }

        const slip = body.data;
        // เช็กยอดซ้ำอีกชั้น เผื่อ API ไม่ได้ตรวจให้
        if (expectedAmount > 0 && Number(slip.amount) !== Number(expectedAmount)) {
            return { ok: false, reason: '1013', data: slip };
        }

        return { ok: true, reason: 'VERIFIED', data: slip };
    } catch (err) {
        const code = err.response?.data?.code;
        if (code) return { ok: false, reason: String(code), data: err.response.data.data };
        console.error('❌ SlipOK API Error:', err.message);
        return { ok: false, reason: 'NETWORK_ERROR' };
    }
}

/** แปลงรหัสข้อผิดพลาดของ SlipOK เป็นข้อความภาษาไทยที่เข้าใจง่าย */
function slipErrorMessage(reason) {
    const map = {
        NO_API_KEY: 'ยังไม่ได้ตั้งค่าระบบตรวจสลิปอัตโนมัติ (SLIPOK_API_KEY / SLIPOK_BRANCH_ID) — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        '1002':     'ระบบตรวจสลิปตั้งค่าไม่ถูกต้อง (API Key ผิด) — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        '1003':     'แพ็กเกจระบบตรวจสลิปหมดอายุ — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        '1004':     'โควต้าตรวจสลิปหมด — รอแอดมินตรวจสอบด้วยตนเองนะครับ',
        '1005':     'ไฟล์ที่ส่งมาไม่ใช่รูปภาพที่ถูกต้อง กรุณาส่งใหม่เป็นไฟล์ JPG/PNG',
        '1006':     'รูปภาพไม่ถูกต้อง กรุณาส่งรูปสลิปใหม่อีกครั้ง',
        '1007':     'ไม่พบ QR Code ในรูปภาพ กรุณาส่งรูปสลิปที่เห็น QR ชัดเจนอีกครั้ง',
        '1008':     'QR Code ในรูปไม่ใช่สลิปโอนเงิน กรุณาส่งรูปสลิปที่ถูกต้อง',
        '1009':     'ธนาคารยังไม่ตอบสนอง กรุณารอสักครู่แล้วส่งสลิปใหม่อีกครั้ง',
        '1010':     'สลิปยังไม่เข้าระบบธนาคาร กรุณารอประมาณ 5 นาทีแล้วส่งใหม่อีกครั้ง',
        '1011':     'ไม่พบข้อมูลสลิปนี้ หรือ QR Code หมดอายุ กรุณาตรวจสอบแล้วส่งใหม่อีกครั้ง',
        '1012':     'สลิปนี้เคยถูกใช้ยืนยันการชำระเงินไปแล้ว ไม่สามารถใช้ซ้ำได้ กรุณาติดต่อแอดมิน',
        '1013':     'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระ กรุณาตรวจสอบและโอนให้ครบ หรือแจ้งแอดมิน',
        '1014':     'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้าน กรุณาตรวจสอบว่าโอนถูกบัญชี หรือแจ้งแอดมิน',
        NETWORK_ERROR: 'ระบบตรวจสลิปขัดข้องชั่วคราว รอแอดมินตรวจสอบด้วยตนเองนะครับ'
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

// ── อิโมจิ ──
function findEmoji(id) {
    return client.emojis.cache.get(id) ?? client.application?.emojis?.cache?.get(id) ?? null;
}

const warnedEmoji = new Set();
function warnEmojiOnce(id, where) {
    if (warnedEmoji.has(id)) return;
    warnedEmoji.add(id);
    console.error(`⚠️ ไม่พบอิโมจิไอดี ${id} (${where}) — อิโมจิต้องอยู่ในเซิร์ฟเวอร์ที่บอทอยู่ หรืออัปโหลดเป็น Application Emoji`);
}

/** อิโมจิสำหรับปุ่ม: ใช้อิโมจิเซิร์ฟเวอร์ถ้าหาเจอ ไม่งั้นใช้ fallback (อิโมจิธรรมดา) */
function buttonEmoji(id, fallback) {
    const e = findEmoji(id);
    if (!e) { warnEmojiOnce(id, 'ปุ่ม'); return fallback; }
    return { id: e.id, name: e.name, animated: e.animated };
}

// ── กดรีแอคชั่นข้อความในห้องรีวิว (ข้ามอันที่บอทเคยกดแล้ว) ──
const reactErrorLogged = new Set();

async function reactToReview(message) {
    if (message.system) return false;
    let added = false;

    for (const id of REVIEW_REACTION_IDS) {
        if (message.reactions.cache.some(r => r.emoji.id === id && r.me)) continue; // เคยกดแล้ว

        const emoji = findEmoji(id);
        if (!emoji) { warnEmojiOnce(id, 'รีแอคชั่น'); continue; }

        try {
            await message.react(emoji);
            added = true;
        } catch (err) {
            if (err.code === 10008) return added; // ข้อความถูกลบไปแล้ว
            const key = String(err.code ?? err.message);
            if (!reactErrorLogged.has(key)) { // log ครั้งเดียวต่อชนิด error จะได้ไม่ท่วม Console
                reactErrorLogged.add(key);
                console.error('❌ กดรีแอคชั่นไม่ได้ (เช็คสิทธิ์ Add Reactions / Read Message History / Use External Emojis ของบอทในห้องรีวิว):', err.message);
            }
        }
    }
    return added;
}

/** ไล่กดรีแอคชั่นย้อนหลังทุกข้อความในห้องรีวิว (ทำเบื้องหลังตอนบอทเริ่มรัน) */
async function backfillReviewReactions() {
    const channel = await client.channels.fetch(REVIEW_CHANNEL_ID);
    if (!channel?.messages) {
        console.error('❌ ห้องรีวิวไม่ใช่ห้องข้อความ ย้อนกดรีแอคชั่นไม่ได้');
        return;
    }

    let before;
    let scanned = 0, reacted = 0;
    console.log('⏳ เริ่มย้อนกดรีแอคชั่นห้องรีวิว (ข้อความที่เคยกดแล้วจะข้าม)...');

    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;

        for (const msg of batch.values()) {
            scanned++;
            if (await reactToReview(msg)) reacted++;
        }
        before = batch.last().id; // ข้อความเก่าสุดในชุดนี้ ใช้ดึงชุดถัดไป
    }

    console.log(`✅ ย้อนกดรีแอคชั่นห้องรีวิวเสร็จ: สแกน ${scanned} ข้อความ / กดเพิ่ม ${reacted} ข้อความ`);
}

// ── ปิดตั๋ว: รอ 10 นาที → ส่ง log สรุปลูกค้าเข้าห้อง log → ลบห้องตั๋วทิ้ง ──
const closeTimers    = new Map(); // channelId -> timeout
const creatingTicket = new Set(); // userId ที่กำลังสร้างตั๋วอยู่ (กันกดรัว)

function scheduleClose(channelId, delayMs) {
    if (closeTimers.has(channelId)) return;
    const timer = setTimeout(() => {
        closeTimers.delete(channelId);
        closeTicket(channelId);
    }, Math.max(0, delayMs));
    closeTimers.set(channelId, timer);
}

/** เริ่มนับถอยหลังปิดตั๋ว (บันทึกลงไฟล์ เผื่อบอทรีสตาร์ท) — คืน false ถ้าตั๋วนี้ปิดไปแล้ว/ไม่ใช่ตั๋ว */
function beginClose(channelId, { closedBy = null, auto = false } = {}) {
    const data = activeTicketData[channelId];
    if (!data || data.category !== 'ticket' || data.closeAt) return false;

    data.closeAt    = Date.now() + CLOSE_DELAY_MS;
    data.closedBy   = closedBy;
    data.autoClosed = auto;
    saveTickets();
    scheduleClose(channelId, CLOSE_DELAY_MS);
    return true;
}

/** เอมเบดข้อความตอนปิดห้อง */
function buildCloseEmbed(auto) {
    const mins = CLOSE_DELAY_MS / 60000;
    const head = auto
        ? `ห้องนี้ถูกปิดอัตโนมัติ เนื่องจากลูกค้าไม่ตอบกลับในห้องครบ ${AUTO_CLOSE_MS / 3600000} ชั่วโมง\nห้องนี้จะถูกลบภายใน ${mins} นาที (ถ้ายังต้องการใช้บริการ เปิดตั๋วใหม่ได้หลังห้องนี้ถูกลบครับ)`
        : `ห้องนี้ถูกปิดแล้วครับ ห้องนี้จะถูกลบภายใน ${mins} นาที`;

    return new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('✅ ปิดห้องแล้ว')
        .setDescription(
`${head}

เมื่อ ADMIN กดของเสร็จแล้ว ลูกค้าอย่าลืมเปลี่ยน Password เพื่อความปลอดภัยของตัวลูกค้าเองนะคั้บบ

💖 ขอบคุณที่ใช้บริการครับ ฝากรีวิวได้ที่ <#${REVIEW_CHANNEL_ID}>`
        );
}

/** ส่ง log สรุปว่าลูกค้าคนนี้ทำรายการอะไรไปบ้าง เข้าห้อง LOG_CHANNEL_ID
 *  (ตั้งใจไม่เก็บข้อความแชทของลูกค้า เพราะอาจมีรหัสผ่าน/ข้อมูลส่วนตัวปนอยู่) */
async function sendTicketLog(data) {
    const ts = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

    let username = 'ไม่ทราบ';
    if (data.userId) {
        const user = await client.users.fetch(data.userId).catch(() => null);
        if (user) username = user.username;
    }

    // สรุปการชำระเงิน
    const payments = data.payments ?? [];
    let payText;
    if (payments.length > 0) {
        payText = payments.slice(0, 10).map(p =>
            `• **${Number(p.amount).toLocaleString()} บาท** — ผู้โอน: ${p.sender} — อ้างอิง: \`${p.transRef}\``
        ).join('\n');
    } else if (data.slipReceived) {
        payText = '⏳ ลูกค้าส่งสลิปมา แต่ระบบตรวจอัตโนมัติใช้ไม่ได้ (ให้แอดมินตรวจเอง)';
    } else if (data.price > 0) {
        payText = `แจ้งยอด ${Number(data.price).toLocaleString()} บาท แต่ยังไม่มีการชำระ`;
    } else {
        payText = 'ไม่มีการแจ้งยอด / ไม่มีการชำระเงิน';
    }

    const embed = new EmbedBuilder()
        .setColor('#2B2D31')
        .setTitle(`📋 Log ตั๋ว #${data.qNum}`)
        .addFields(
            { name: '👤 ลูกค้า',        value: data.userId ? `<@${data.userId}> (${username})\n\`${data.userId}\`` : 'ไม่ทราบ', inline: true },
            { name: '🎫 ตั๋ว',          value: `#${data.qNum}`, inline: true },
            { name: '🕒 เปิดเมื่อ',      value: data.openedAt ? ts(data.openedAt) : 'ไม่ทราบ', inline: false },
            { name: '🛠️ รับงานโดย',     value: data.acceptedBy ? `<@${data.acceptedBy}>` : 'ไม่มีผู้รับงาน', inline: true },
            { name: '🔒 ปิดโดย',        value: data.closedBy ? `<@${data.closedBy}>` : (data.autoClosed ? 'ระบบอัตโนมัติ (ลูกค้าไม่ตอบ 24 ชม.)' : 'ไม่ทราบ'), inline: true },
            { name: '💰 รายการชำระเงิน', value: payText.slice(0, 1024), inline: false }
        )
        .setTimestamp();

    try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
        await logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error('❌ ส่ง log เข้าห้อง LOG_CHANNEL_ID ไม่ได้ (เช็คไอดีห้อง และสิทธิ์ View/Send ของบอท):', err.message);
        console.log('📋 LOG สำรอง:', JSON.stringify(data));
    }
}

async function closeTicket(channelId) {
    const data = activeTicketData[channelId];
    if (!data || data.category !== 'ticket') return; // กันลบห้องที่ไม่ใช่ห้องตั๋ว

    // 1) ส่ง log (ครั้งเดียว ถึงลบห้องไม่สำเร็จแล้วลองใหม่ก็ไม่ส่งซ้ำ)
    if (!data.logged) {
        await sendTicketLog(data);
        data.logged = true;
        saveTickets();
    }

    // 2) ลบห้องตั๋ว
    try {
        const chan = await client.channels.fetch(channelId);
        await chan.delete(`ตั๋ว #${data.qNum} ครบเวลาปิดห้อง`);
        console.log(`🗑️ ลบตั๋ว #${data.qNum} เรียบร้อย`);
    } catch (err) {
        if (err.code !== 10003) { // 10003 = Unknown Channel (ห้องถูกลบไปแล้ว ก็ถือว่าเสร็จ)
            data.closeTries = (data.closeTries || 0) + 1;
            saveTickets();
            console.error(`❌ ลบตั๋ว #${data.qNum} ไม่สำเร็จ (เช็คสิทธิ์ Manage Channels ของบอท):`, err.message);
            if (data.closeTries < 5) scheduleClose(channelId, 2 * 60 * 1000); // ลองใหม่ใน 2 นาที
            return;
        }
    }

    delete activeTicketData[channelId];
    saveTickets();
}

/** ปิดตั๋วอัตโนมัติเมื่อไม่มีใครตอบในห้องครบ 24 ชม. */
async function autoCloseTicket(channelId) {
    const data = activeTicketData[channelId];
    if (!beginClose(channelId, { closedBy: null, auto: true })) return;

    const chan = await client.channels.fetch(channelId).catch(() => null);
    if (!chan) return; // ห้องหาย — ตัวจับเวลา/ChannelDelete จะเคลียร์เอง

    if (data.panelMessageId) {
        chan.messages.fetch(data.panelMessageId).then(m => m.edit({ components: [] })).catch(() => {});
    }
    await chan.send({
        content: data.userId ? `<@${data.userId}>` : undefined,
        embeds: [buildCloseEmbed(true)]
    }).catch(() => {});
    chan.setName(`✅-${data.qNum}`).catch(() => {});
}

async function checkInactiveTickets() {
    const now = Date.now();
    for (const [channelId, data] of Object.entries(activeTicketData)) {
        if (data.category !== 'ticket' || data.closeAt) continue;

        const last = data.lastActivityAt ?? data.openedAt;
        if (!last) { // ตั๋วเก่าที่ยังไม่มีบันทึกเวลา → เริ่มนับจากตอนนี้
            data.lastActivityAt = now;
            saveTickets();
            continue;
        }
        if (now - last >= AUTO_CLOSE_MS) {
            console.log(`⏰ ตั๋ว #${data.qNum} ลูกค้าไม่ตอบครบ 24 ชม. → ปิดอัตโนมัติ`);
            await autoCloseTicket(channelId);
        }
    }
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

    // ตรวจตั๋วที่เงียบครบ 24 ชม. ทุก 5 นาที
    checkInactiveTickets().catch(err => console.error('❌ checkInactiveTickets:', err));
    setInterval(() => checkInactiveTickets().catch(err => console.error('❌ checkInactiveTickets:', err)), 5 * 60 * 1000);

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

    // โหลดอิโมจิของแอป (ถ้ามี) แล้วย้อนกดรีแอคชั่นทุกข้อความเก่าในห้องรีวิว (ทำเบื้องหลัง ไม่ขวางบอท)
    await client.application?.emojis?.fetch().catch(() => {});
    backfillReviewReactions().catch(err => console.error('❌ ย้อนกดรีแอคชั่นห้องรีวิวไม่สำเร็จ:', err.message));
});

// ห้องตั๋วถูกลบ (โดยบอทหรือแอดมินลบมือ) → เคลียร์ข้อมูล ลูกค้าจะได้เปิดตั๋วใหม่ได้
client.on(Events.ChannelDelete, (channel) => {
    if (!activeTicketData[channel.id]) return;
    const timer = closeTimers.get(channel.id);
    if (timer) { clearTimeout(timer); closeTimers.delete(channel.id); }
    delete activeTicketData[channel.id];
    saveTickets();
});

// ==========================================
// [ 7. Message Handler: คำสั่งแอดมิน + ตรวจจับสลิป + นับรีวิว ]
// ==========================================
client.on('messageCreate', async (message) => {
    // ── กดรีแอคชั่นทุกข้อความใหม่ในห้องรีวิว (เช็คก่อนกรองบอท เพื่อให้ได้ทุกข้อความ ยกเว้นของบอทเราเอง) ──
    if (message.guild && message.channel.id === REVIEW_CHANNEL_ID && message.author.id !== client.user.id) {
        reactToReview(message); // ไม่ await เพื่อไม่ขวางการนับรีวิว (ฟังก์ชันจับ error เองแล้ว)
    }

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
            return;
        }
    }

    // ── บันทึกเวลาที่ "ลูกค้า" พิมพ์ล่าสุดในตั๋ว ไว้ใช้ปิดอัตโนมัติ 24 ชม. (แอดมินพิมพ์/แท็กไม่นับ) ──
    const activity = activeTicketData[message.channel.id];
    if (activity && activity.category === 'ticket' && !activity.closeAt && message.author.id === activity.userId) {
        activity.lastActivityAt = Date.now();
        saveTicketsSoon();
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

            // ...existing เพื่อคงข้อมูลตั๋วเดิมไว้ (เวลาเปิด, ผู้รับงาน, ประวัติชำระเงิน ฯลฯ)
            activeTicketData[targetId] = {
                ...existing,
                category:     existing?.category ?? 'manual',
                label:        existing?.label ?? 'ชำระเงิน',
                price:        amount,
                userId:       existing?.userId ?? null,
                qNum,
                payMethod:    'promptpay',
                slipReceived: false,
                slipVerified: false
            };
            saveTickets();

            const qrEmbed = new EmbedBuilder()
                .setTitle('🧾 แจ้งยอดชำระเงิน')
                .setColor('#2ECC71')
                .setDescription(
`💰 ยอดชำระ: **${amount.toLocaleString()} บาท**

📌 สแกน QR พร้อมเพย์ด้านล่างนี้ หรือโอนมาที่เบอร์: \`${PROMPTPAY_NUMBER}\`

📸 **เมื่อโอนเสร็จแล้ว ให้ส่งรูปสลิปลงในห้องนี้ได้เลยครับ!**`
                )
                .setImage(buildQrUrl(amount))
                .setFooter({ text: 'เมื่อส่งสลิปแล้ว บอทจะตรวจสอบและตอบกลับอัตโนมัติ' });

            await targetChannel.send({ embeds: [qrEmbed] });
            return message.reply(`✅ สร้าง QR ยอด **${amount.toLocaleString()} บาท** ส่งไปที่ ${targetChannel} แล้วครับ`);
        }

        return;
    }

    // ── ตรวจจับ + ตรวจสอบสลิปอัตโนมัติ (ห้องไหนก็ได้ที่มีการแจ้งยอดด้วย !qr หรือเป็นห้องตั๋ว) ──
    const ticketData = activeTicketData[message.channel.id];
    if (ticketData) {
        const isAdmin = message.member.roles.cache.has(ADMIN_ROLE_ID);
        const image   = message.attachments.find(a => (a.contentType || '').startsWith('image/'));

        if (ticketData.price > 0 && !isAdmin && image && !ticketData.slipVerified) {
            const checkingMsg = await message.reply('🔍 กำลังตรวจสอบสลิป กรุณารอสักครู่นะครับ...');

            const result = await verifySlip(image.url, ticketData.price);

            if (result.ok) {
                ticketData.slipVerified = true;
                ticketData.slipReceived = true;
                ticketData.slipInfo = {
                    transRef: result.data.transRef ?? '-',
                    amount:   Number(result.data.amount) || ticketData.price,
                    sender:   result.data.sender?.displayName ?? result.data.sender?.name ?? 'ไม่ทราบชื่อ'
                };
                // เก็บประวัติการชำระเงินไว้สรุปใน log ตอนปิดตั๋ว
                if (!Array.isArray(ticketData.payments)) ticketData.payments = [];
                ticketData.payments.push({ ...ticketData.slipInfo, at: Date.now() });
                saveTickets();

                const verifiedEmbed = new EmbedBuilder()
                    .setColor('#2ECC71')
                    .setTitle('✅ ตรวจสอบสลิปสำเร็จ — รับยอดครับ')
                    .addFields(
                        { name: '👤 ผู้โอน',    value: ticketData.slipInfo.sender, inline: true },
                        { name: '💰 ยอดโอน',    value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                        { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false }
                    )
                    .setFooter({ text: 'ตรวจสอบผ่าน SlipOK • รอแอดมินดำเนินการต่อ' });

                await checkingMsg.edit({ content: null, embeds: [verifiedEmbed] });
                await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าโอนเงินแล้ว **ตรวจสอบสลิปผ่าน ✅** (คิวที่ ${ticketData.qNum})`);

                // แจ้งเตือนที่ห้องแจ้งสลิปกลาง
                const notifyChannel = client.channels.cache.get(SLIP_NOTIFY_CHANNEL_ID);
                if (notifyChannel) {
                    await notifyChannel.send({
                        embeds: [new EmbedBuilder()
                            .setColor('#2ECC71')
                            .setTitle('✅ มีการชำระเงิน — ตรวจสอบสลิปผ่านแล้ว')
                            .addFields(
                                { name: '👤 ลูกค้า',    value: ticketData.userId ? `<@${ticketData.userId}>` : 'ไม่ทราบ', inline: true },
                                { name: '💰 ยอดโอน',    value: `${ticketData.slipInfo.amount.toLocaleString()} บาท`, inline: true },
                                { name: '🔖 เลขอ้างอิง', value: `\`${ticketData.slipInfo.transRef}\``, inline: false },
                                { name: '📍 ห้องออเดอร์', value: `<#${message.channel.id}>`, inline: false }
                            )]
                    }).catch(() => {});
                }
            } else {
                // สลิปยังไม่ผ่าน — ไม่ mark ว่ารับยอดแล้ว ให้ลูกค้าส่งใหม่ได้
                await checkingMsg.edit({ content: `❌ ${slipErrorMessage(result.reason)}` });

                // กรณีระบบขัดข้อง/ไม่ได้ตั้งค่าคีย์ ให้แจ้งแอดมินมาตรวจเองแทน จะได้ไม่ตกหล่น
                if (['NO_API_KEY', 'NETWORK_ERROR', '1002', '1003', '1004'].includes(result.reason) && !ticketData.slipReceived) {
                    ticketData.slipReceived = true;
                    saveTickets();
                    await message.channel.send(`🔔 <@&${ADMIN_ROLE_ID}> ลูกค้าส่งสลิปมาแต่ระบบตรวจอัตโนมัติใช้งานไม่ได้ กรุณาตรวจสอบด้วยตนเองครับ (คิวที่ ${ticketData.qNum})`);
                }
            }
        }
    }
});

// ════════════════════════════════════════════════════════════
//  TICKET FLOW
//
//  create_ticket → สร้างห้องตั๋วทันที (ลูกค้า 1 คนมีตั๋วเปิดได้ทีละ 1 ห้อง จนกว่าห้องเก่าจะถูกลบ)
//  แอดมินใช้ !qr [ยอด] [ห้อง] เพื่อแจ้งยอด+สร้าง QR เมื่อไหร่ก็ได้ ห้องไหนก็ได้
//  ADMIN เท่านั้น: btn_work (รับงาน)  |  btn_done (ปิดห้อง)
//  ปิดห้องแล้ว 10 นาที → ส่ง log เข้าห้อง LOG_CHANNEL_ID → ลบห้อง
//  ลูกค้าไม่พิมพ์ในตั๋วครบ 24 ชม. → ปิดอัตโนมัติ (เข้าขั้นตอนเดียวกับปิดห้อง)
// ════════════════════════════════════════════════════════════

client.on('interactionCreate', async (interaction) => {
    try {
        // ─────────────────────────────────────────────────────────
        //  create_ticket → สร้างห้องตั๋วทันที
        // ─────────────────────────────────────────────────────────
        if (interaction.isButton() && interaction.customId === 'create_ticket') {
            await interaction.deferReply({ ephemeral: true });

            const userId = interaction.user.id;
            if (creatingTicket.has(userId))
                return interaction.editReply({ content: '⏳ กำลังสร้างตั๋วให้คุณอยู่ กรุณารอสักครู่ครับ' });

            creatingTicket.add(userId);
            try {
                // ลูกค้ายังมีตั๋วเก่าที่ไม่ถูกลบ → เปิดใหม่ไม่ได้
                const oldId = Object.keys(activeTicketData).find(id =>
                    activeTicketData[id].category === 'ticket' && activeTicketData[id].userId === userId
                );
                if (oldId) {
                    const oldChan = await interaction.guild.channels.fetch(oldId)
                        .catch(err => (err.code === 10003 ? null : undefined)); // null = ห้องถูกลบแล้ว, undefined = เช็คไม่ได้
                    if (oldChan === undefined)
                        return interaction.editReply({ content: '❌ ตรวจสอบตั๋วเก่าของคุณไม่ได้ในตอนนี้ กรุณาลองใหม่อีกครั้งครับ' });
                    if (oldChan)
                        return interaction.editReply({ content: `❌ คุณมีตั๋วที่ยังไม่ถูกลบอยู่ ${oldChan}\nต้องรอให้ตั๋วเดิมถูกลบก่อน จึงจะเปิดตั๋วใหม่ได้ครับ` });

                    // ห้องเก่าไม่อยู่แล้ว เคลียร์ข้อมูลค้าง
                    delete activeTicketData[oldId];
                    saveTickets();
                }

                const qNum = queueCount++;
                saveQueue();

                const channel = await interaction.guild.channels.create({
                    name:   `ticket-${qNum}`,
                    parent: TICKET_CATEGORY_ID,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
                        { id: userId,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
                        { id: ADMIN_ROLE_ID,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });

                const now = Date.now();
                activeTicketData[channel.id] = {
                    category:       'ticket',
                    label:          'Ticket',
                    price:          0,
                    userId,
                    qNum,
                    payMethod:      'promptpay',
                    slipReceived:   false,
                    slipVerified:   false,
                    openedAt:       now,
                    lastActivityAt: now
                };
                saveTickets();

                const embed = new EmbedBuilder()
                    .setTitle(`🎫 Ticket #${qNum}`)
                    .setColor('#5865F2')
                    .setDescription(`สวัสดีครับ <@${userId}>\n\nแจ้งรายละเอียดที่ต้องการได้เลยครับ รอแอดมินเข้ามาดำเนินการและแจ้งยอดชำระให้สักครู่นะครับ`);

                // ปุ่มสีดำ (ใน Discord ใกล้เคียงสุดคือ Secondary สีเทาเข้ม) — กดได้เฉพาะแอดมิน
                const btns = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_work').setLabel('รับงาน').setEmoji(buttonEmoji(WORK_EMOJI_ID, '✅')).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('btn_done').setLabel('ปิดห้อง').setEmoji(buttonEmoji(DONE_EMOJI_ID, '❌')).setStyle(ButtonStyle.Secondary)
                );

                const panel = await channel.send({ content: `🔔 <@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [btns] });
                activeTicketData[channel.id].panelMessageId = panel.id;
                saveTickets();

                return interaction.editReply({ content: `✅ สร้างตั๋วเรียบร้อยแล้ว! แตะที่นี่ได้เลย 👉 ${channel}` });
            } finally {
                creatingTicket.delete(userId);
            }
        }

        // ════════════════════════════════════════════════════════════
        //  ADMIN TICKET BUTTONS (กดได้เฉพาะแอดมิน)
        // ════════════════════════════════════════════════════════════

        if (interaction.isButton() && (interaction.customId === 'btn_work' || interaction.customId === 'btn_done')) {
            if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID))
                return interaction.reply({ content: '❌ ปุ่มนี้ใช้ได้เฉพาะแอดมินเท่านั้นครับ', ephemeral: true });

            const data = activeTicketData[interaction.channel.id];
            if (!data)
                return interaction.reply({ content: '❌ ไม่พบข้อมูลตั๋วนี้ในระบบ (อาจถูกปิดไปแล้ว)', ephemeral: true });

            // ── รับงาน ──
            if (interaction.customId === 'btn_work') {
                if (data.acceptedBy)
                    return interaction.reply({ content: `ℹ️ ตั๋วนี้ถูกรับงานโดย <@${data.acceptedBy}> แล้วครับ`, ephemeral: true });

                data.acceptedBy     = interaction.user.id;
                data.acceptedAt     = Date.now();
                saveTickets();

                await interaction.reply({ content: `👨‍💻 <@${interaction.user.id}> รับงานนี้แล้วครับ กำลังดำเนินการให้${data.userId ? ` <@${data.userId}>` : ''}` });
                return interaction.channel.setName(`🛠️-${data.qNum}`).catch(() => {});
            }

            // ── ปิดห้อง ──
            if (data.closeAt)
                return interaction.reply({ content: '⏳ ห้องนี้ถูกปิดไปแล้ว กำลังรอลบห้องครับ', ephemeral: true });

            beginClose(interaction.channel.id, { closedBy: interaction.user.id });

            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.reply({ embeds: [buildCloseEmbed(false)] });
            // ไม่ await: ถ้าติด rate limit ของการเปลี่ยนชื่อห้อง จะได้ไม่ขวางการลบห้อง
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
