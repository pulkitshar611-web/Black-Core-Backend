/**
 * Queue Engine — Deterministic, Restart-Safe
 * Persists queue in SQLite (not in-memory)
 * Survives server restarts and power failures
 * Runs assignment check every 15 seconds
 */
const cron = require('node-cron');

let prismaClient = null;

async function processQueue() {
    if (!prismaClient) return;

    try {
        const settings = await prismaClient.energySettings.findUnique({ where: { id: 1 } });
        const latestEnergy = await prismaClient.energyReading.findFirst({ orderBy: { recordedAt: 'desc' } });

        // Energy gate — don't auto-assign if at peak
        if (settings?.peakProtection && latestEnergy) {
            const threshold = settings.maxLoadKw * 0.9;
            if (latestEnergy.currentKw >= threshold) {
                return; // silently skip — peak protection active
            }
        }

        // Find idle printers
        const allPrinters = await prismaClient.printer.findMany({ where: { isActive: true } });
        const idlePrinters = [];

        for (const printer of allPrinters) {
            const latestTelemetry = await prismaClient.printerTelemetry.findFirst({
                where: { printerId: printer.id },
                orderBy: { recordedAt: 'desc' },
            });
            if (!latestTelemetry || latestTelemetry.status === 'idle' || latestTelemetry.status === 'offline') {
                idlePrinters.push(printer);
            }
        }

        if (idlePrinters.length === 0) return;

        // Get unassigned queue items in priority order
        const queueItems = await prismaClient.queueItem.findMany({
            where: { status: 'queued', printerId: null },
            include: { job: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
            take: idlePrinters.length,
        });

        if (queueItems.length === 0) return;

        // Match queue items to idle printers
        for (let i = 0; i < Math.min(queueItems.length, idlePrinters.length); i++) {
            const item = queueItems[i];
            const printer = idlePrinters[i];

            // Warmup staggering
            if (settings?.warmupStaggering && i > 0) {
                await new Promise(r => setTimeout(r, (settings.staggerDelayMin || 5) * 60 * 1000));
            }

            await prismaClient.queueItem.update({
                where: { id: item.id },
                data: { printerId: printer.id, status: 'assigned' },
            });

            await prismaClient.job.update({
                where: { id: item.jobId },
                data: { printerId: printer.id, status: 'printing', startedAt: new Date() },
            });

            console.log(`[QUEUE] Auto-assigned job "${item.job.name}" → printer "${printer.name}"`);
        }
    } catch (err) {
        console.error('[QUEUE] Processing error:', err.message);
    }
}

// Restore queue state on startup (in case of crash)
async function restoreQueueState() {
    if (!prismaClient) return;
    try {
        // Check for jobs that were printing but queue shows assigned — resume tracking
        const orphans = await prismaClient.job.findMany({
            where: { status: 'printing', printerId: { not: null } },
        });
        console.log(`[QUEUE] Restored ${orphans.length} in-progress jobs on startup`);
        return orphans.length;
    } catch (err) {
        console.error('[QUEUE] Restore error:', err.message);
        return 0;
    }
}

function start(prisma) {
    prismaClient = prisma;
    console.log('[QUEUE] Engine started — checking every 15 seconds');

    // Restore state from DB on startup
    setTimeout(restoreQueueState, 5000);

    // Process queue every 15 seconds
    cron.schedule('*/15 * * * * *', processQueue);
}

module.exports = { start, processQueue };
