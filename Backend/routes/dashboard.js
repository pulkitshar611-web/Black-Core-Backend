const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/dashboard/stats
router.get('/stats', authenticate, async (req, res) => {
    try {
        const [
            printerCount,
            activePrinters,
            faultPrinters,
            activeJobs,
            queuedJobs,
            pendingOrders,
            criticalAlerts,
            energySettings,
            latestEnergy,
        ] = await Promise.all([
            prisma.printer.count({ where: { isActive: true } }),
            prisma.printerTelemetry.findMany({
                where: { status: 'printing' },
                distinct: ['printerId'],
            }),
            prisma.printerTelemetry.findMany({
                where: { status: 'error' },
                distinct: ['printerId'],
            }),
            prisma.job.count({ where: { status: 'printing' } }),
            prisma.queueItem.count({ where: { status: 'queued' } }),
            prisma.order.count({ where: { status: { in: ['incoming', 'quoted', 'won'] } } }),
            prisma.alertLog.count({ where: { status: 'pending', createdAt: { gte: new Date(Date.now() - 3600000) } } }),
            prisma.energySettings.findUnique({ where: { id: 1 } }),
            prisma.energyReading.findFirst({ orderBy: { recordedAt: 'desc' } }),
        ]);

        res.json({
            printerCount,
            activePrintersCount: activePrinters.length,
            faultCount: faultPrinters.length,
            activeJobs,
            queuedJobs,
            pendingOrders,
            criticalAlerts,
            energy: {
                currentKw: latestEnergy?.currentKw || 0,
                maxKw: energySettings?.maxLoadKw || 6,
                peakProtection: energySettings?.peakProtection || true,
            },
        });
    } catch (err) {
        console.error('[DASHBOARD] Stats error:', err);
        res.status(500).json({ error: 'Failed to load dashboard stats' });
    }
});

module.exports = router;
