const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/queue — Full queue
router.get('/', authenticate, async (req, res) => {
    try {
        const items = await prisma.queueItem.findMany({
            include: { job: true, printer: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        });
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load queue' });
    }
});

// POST /api/queue — Add job to queue manually
router.post('/', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { name, material, weightGrams, estimatedTime, priority, orderId } = req.body;
        if (!name) return res.status(400).json({ error: 'Job name required' });

        const jobCode = `JOB-${Date.now().toString().slice(-6)}`;
        const priorityMap = { high: 1, medium: 5, low: 10 };

        const job = await prisma.job.create({
            data: {
                jobCode,
                name,
                material: material || 'PLA',
                weightGrams: weightGrams || 0,
                estimatedTime: estimatedTime || 0,
                priority: priority || 'medium',
                orderId: orderId || null,
            },
        });

        const queueItem = await prisma.queueItem.create({
            data: {
                jobId: job.id,
                priority: priorityMap[priority] || 5,
            },
            include: { job: true },
        });

        const io = req.app.get('io');
        io.emit('queue:updated', { type: 'JOB_ADDED', item: queueItem });

        res.status(201).json(queueItem);
    } catch (err) {
        console.error('[QUEUE] POST error:', err);
        res.status(500).json({ error: 'Failed to add job to queue' });
    }
});

// PUT /api/queue/:id/assign — Assign job to printer (with energy check)
router.put('/:id/assign', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { printerId } = req.body;
        const queueItemId = +req.params.id;

        // Check energy limits before assigning
        const energySettings = await prisma.energySettings.findUnique({ where: { id: 1 } });
        const latestEnergy = await prisma.energyReading.findFirst({ orderBy: { recordedAt: 'desc' } });

        if (energySettings?.peakProtection && latestEnergy) {
            const threshold = energySettings.maxLoadKw * 0.9;
            if (latestEnergy.currentKw >= threshold) {
                await prisma.powerEvent.create({
                    data: {
                        type: 'OVERLOAD_PREVENTED', currentKw: latestEnergy.currentKw,
                        limitKw: energySettings.maxLoadKw, action: `Job assignment blocked`
                    }
                });
                return res.status(409).json({
                    error: 'PEAK PROTECTION ACTIVE: Energy load too high to start new job',
                    currentKw: latestEnergy.currentKw,
                    maxKw: energySettings.maxLoadKw,
                });
            }
        }

        const printer = await prisma.printer.findUnique({ where: { id: +printerId } });
        if (!printer) return res.status(404).json({ error: 'Printer not found' });

        // Check printer is idle
        const printerTelemetry = await prisma.printerTelemetry.findFirst({
            where: { printerId: +printerId }, orderBy: { recordedAt: 'desc' },
        });
        if (printerTelemetry?.status === 'printing') {
            return res.status(409).json({ error: 'Printer is currently busy' });
        }

        // Assign job
        const updated = await prisma.queueItem.update({
            where: { id: queueItemId },
            data: { printerId: +printerId, status: 'assigned' },
            include: { job: true, printer: true },
        });

        // Update job
        await prisma.job.update({
            where: { id: updated.jobId },
            data: { printerId: +printerId, status: 'printing', startedAt: new Date() },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: 'JOB_ASSIGNED', entity: 'QueueItem',
                entityId: String(queueItemId), details: JSON.stringify({ printerId })
            }
        });

        const io = req.app.get('io');
        io.emit('queue:updated', { type: 'JOB_ASSIGNED', item: updated });

        res.json(updated);
    } catch (err) {
        console.error('[QUEUE] Assign error:', err);
        res.status(500).json({ error: 'Failed to assign job' });
    }
});

// PUT /api/queue/:id/priority — Change priority
router.put('/:id/priority', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { priority } = req.body; // high | medium | low
        const priorityMap = { high: 1, medium: 5, low: 10 };
        const updated = await prisma.queueItem.update({
            where: { id: +req.params.id },
            data: { priority: priorityMap[priority] || 5 },
            include: { job: true },
        });
        const io = req.app.get('io');
        io.emit('queue:updated', { type: 'PRIORITY_CHANGED', item: updated });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update priority' });
    }
});

// DELETE /api/queue/:id — Remove from queue
router.delete('/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const item = await prisma.queueItem.findUnique({ where: { id: +req.params.id } });
        if (!item) return res.status(404).json({ error: 'Queue item not found' });

        await prisma.queueItem.delete({ where: { id: +req.params.id } });
        await prisma.job.update({ where: { id: item.jobId }, data: { status: 'cancelled' } });

        const io = req.app.get('io');
        io.emit('queue:updated', { type: 'JOB_REMOVED', itemId: +req.params.id });

        res.json({ message: 'Removed from queue' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove from queue' });
    }
});

module.exports = router;
