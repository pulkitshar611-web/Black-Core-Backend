/**
 * Alert Service — Triple Redundancy
 * Channels: Telegram (free), WhatsApp (Twilio), SMS (Twilio)
 * Logs every delivery attempt to DB
 */
const axios = require('axios');

let prismaClient = null;

// ─── Telegram ─────────────────────────────────────────────────
async function sendTelegram(message) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        return { success: false, error: 'Telegram not configured' };
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' },
            { timeout: 5000 }
        );
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── WhatsApp via Twilio ──────────────────────────────────────
async function sendWhatsApp(message) {
    if (!process.env.TWILIO_ACCOUNT_SID) {
        return { success: false, error: 'Twilio not configured' };
    }
    try {
        const { Twilio } = require('twilio');
        const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
            body: message,
            from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
            to: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── SMS via Twilio ───────────────────────────────────────────
async function sendSms(message) {
    if (!process.env.TWILIO_ACCOUNT_SID) {
        return { success: false, error: 'Twilio not configured' };
    }
    try {
        const { Twilio } = require('twilio');
        const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: process.env.ALERT_SMS_TO || process.env.TWILIO_PHONE_NUMBER,
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── Send to Single Channel ───────────────────────────────────
async function sendAlert(channel, message, ruleId = null) {
    const channels = {
        telegram: sendTelegram,
        whatsapp: sendWhatsApp,
        sms: sendSms,
    };

    const sender = channels[channel];
    if (!sender) return { success: false, error: `Unknown channel: ${channel}` };

    const result = await sender(message);

    // Log delivery attempt
    if (prismaClient) {
        try {
            await prismaClient.alertLog.create({
                data: {
                    ruleId: ruleId || null,
                    channel,
                    message,
                    status: result.success ? 'sent' : 'failed',
                    sentAt: result.success ? new Date() : null,
                    errorMsg: result.error || null,
                },
            });
        } catch { }
    }

    return result;
}

// ─── Trigger Alert with Redundancy ────────────────────────────
async function triggerAlert(triggerType, context = {}) {
    if (!prismaClient) return;

    try {
        const rules = await prismaClient.alertRule.findMany({
            where: { trigger: triggerType, isEnabled: true },
        });

        for (const rule of rules) {
            const msgParts = [
                `🔔 <b>BLACK CORE ALERT</b>`,
                `Trigger: ${rule.trigger}`,
                `Severity: ${rule.severity.toUpperCase()}`,
            ];

            if (context.jobName) msgParts.push(`Job: ${context.jobName}`);
            if (context.printer) msgParts.push(`Printer: ${context.printer}`);
            if (context.message) msgParts.push(context.message);

            const message = msgParts.join('\n');

            if (rule.channel === 'all' || rule.redundancy) {
                // Triple redundancy — send on all channels
                await Promise.allSettled([
                    sendAlert('telegram', message, rule.id),
                    sendAlert('whatsapp', message, rule.id),
                    sendAlert('sms', message, rule.id),
                ]);
            } else {
                await sendAlert(rule.channel, message, rule.id);
            }

            // Emit WebSocket event
            if (global.io) {
                global.io.emit('alert:triggered', { rule: rule.name, trigger: triggerType, severity: rule.severity });
            }
        }
    } catch (err) {
        console.error('[ALERTS] Trigger error:', err.message);
    }
}

function init(prisma) {
    prismaClient = prisma;
}

module.exports = { sendAlert, triggerAlert, sendTelegram, sendWhatsApp, sendSms, init };
