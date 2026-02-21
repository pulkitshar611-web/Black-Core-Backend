const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/jobs — All jobs
router.get('/', authenticate, async (req, res) => {
    try {
        const { status } = req.query;
        const where = status ? { status } : {};
        const jobs = await prisma.job.findMany({
            where,
            include: { printer: true, order: true },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load jobs' });
    }
});

// PUT /api/jobs/:id/status — Update job status
router.put('/:id/status', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['queued', 'printing', 'paused', 'completed', 'failed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Valid: ${validStatuses.join(', ')}` });
        }

        const updateData = { status };
        if (status === 'completed') updateData.completedAt = new Date();

        const job = await prisma.job.update({
            where: { id: +req.params.id },
            data: updateData,
            include: { printer: true },
        });

        // If completed, check if label should be auto-printed
        if (status === 'completed' && job.orderId) {
            const io = req.app.get('io');
            io.emit('printer:event', { type: 'JOB_COMPLETE', job });
            // Trigger alert service via event
            require('../services/alertService').triggerAlert('JOB_COMPLETE', {
                jobName: job.name, printer: job.printer?.name
            });
        }

        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: `JOB_STATUS_${status.toUpperCase()}`,
                entity: 'Job', entityId: String(job.id)
            }
        });

        res.json(job);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update job status' });
    }
});

module.exports = router;
