/**
 * Marketplace Poller
 * Polls Xometry, Treatstock etc. every 60 seconds (anti-ban)
 * Uses idempotency keys to prevent duplicate order import
 */
const cron = require('node-cron');
const axios = require('axios');

let prismaClient = null;
let ioClient = null;

// ─── Xometry Poller ───────────────────────────────────────────
async function pollXometry(integration) {
    if (!integration.apiKey) {
        return { result: 'auth_fail', message: 'No API key configured' };
    }
    try {
        const response = await axios.get(`${integration.apiUrl}/quotes?status=open`, {
            headers: { Authorization: `Bearer ${integration.apiKey}` },
            timeout: 10000,
        });
        const orders = response.data?.quotes || [];
        return { result: 'success', ordersFound: orders.length, rawOrders: orders };
    } catch (err) {
        if (err.response?.status === 401) return { result: 'auth_fail', message: 'Invalid API key' };
        if (err.response?.status === 429) return { result: 'error', message: 'Rate limited — backing off' };
        return { result: 'error', message: err.message };
    }
}

// ─── Treatstock Poller ────────────────────────────────────────
async function pollTreatstock(integration) {
    if (!integration.apiKey) {
        return { result: 'auth_fail', message: 'No API key configured' };
    }
    try {
        const response = await axios.get(`${integration.apiUrl}/orders?status=pending`, {
            headers: { 'X-API-Key': integration.apiKey },
            timeout: 10000,
        });
        const orders = response.data?.orders || [];
        return { result: 'success', ordersFound: orders.length, rawOrders: orders };
    } catch (err) {
        if (err.response?.status === 401) return { result: 'auth_fail', message: 'Invalid API key' };
        return { result: 'error', message: err.message };
    }
}

// ─── Import Orders from Marketplace ─────────────────────────
async function importOrders(orders, marketplaceSource, prisma) {
    let imported = 0;
    for (const raw of orders) {
        const externalId = String(raw.id || raw.quote_id || raw.order_id);
        const idempotencyKey = `${marketplaceSource}-${externalId}`;

        // Check idempotency — never import same order twice
        const exists = await prisma.order.findUnique({ where: { externalId } });
        if (exists) continue;

        await prisma.order.create({
            data: {
                orderId: idempotencyKey,
                externalId,
                marketplaceSource,
                customerName: raw.customer_name || raw.buyer_name || 'Unknown',
                customerEmail: raw.customer_email || raw.email || null,
                items: raw.quantity || raw.parts?.length || 1,
                totalValue: parseFloat(raw.price || raw.total_price || 0),
                currency: raw.currency || 'EUR',
                status: 'incoming',
                rawPayload: JSON.stringify(raw),
                statusLogs: {
                    create: { toStatus: 'incoming', actor: 'system' }
                },
            },
        });
        imported++;
    }
    return imported;
}

// ─── Sync One Marketplace ─────────────────────────────────────
async function syncOne(name, prisma) {
    const integration = await prisma.marketplaceIntegration.findUnique({ where: { name } });
    if (!integration || !integration.isEnabled) {
        return { result: 'skipped', message: 'Integration disabled or not found' };
    }

    let pollResult = { result: 'error', message: 'Unknown marketplace', ordersFound: 0 };

    if (name === 'xometry') pollResult = await pollXometry(integration);
    else if (name === 'treatstock') pollResult = await pollTreatstock(integration);
    else pollResult = { result: 'error', message: `No poller configured for ${name}` };

    let importedCount = 0;
    if (pollResult.result === 'success' && pollResult.rawOrders?.length) {
        importedCount = await importOrders(pollResult.rawOrders, name, prisma);
        if (ioClient && importedCount > 0) {
            ioClient.emit('order:statusChanged', { source: name, newOrders: importedCount });
        }
    }

    // Log result
    await prisma.marketplaceSyncLog.create({
        data: {
            integrationId: integration.id,
            result: pollResult.result,
            ordersFound: importedCount,
            message: pollResult.message || null,
        },
    });

    // Update lastSyncAt
    await prisma.marketplaceIntegration.update({
        where: { id: integration.id },
        data: {
            lastSyncAt: new Date(),
            status: pollResult.result === 'success' ? 'active' : pollResult.result === 'auth_fail' ? 'error' : 'offline',
        },
    });

    return { ...pollResult, importedCount };
}

// ─── Main Polling Loop ────────────────────────────────────────
async function runPoll() {
    if (!prismaClient) return;
    try {
        const integrations = await prismaClient.marketplaceIntegration.findMany({ where: { isEnabled: true } });
        for (const integration of integrations) {
            // Anti-ban: stagger each platform by 10 seconds
            await new Promise(r => setTimeout(r, 10000));
            await syncOne(integration.name, prismaClient);
        }
    } catch (err) {
        console.error('[MARKETPLACE] Poll error:', err.message);
    }
}

function start(prisma, io) {
    prismaClient = prisma;
    ioClient = io;
    console.log('[MARKETPLACE] Poller started — every 60 seconds');
    // Poll every 60 seconds
    cron.schedule('0 * * * * *', runPoll);
}

module.exports = { start, syncOne };
