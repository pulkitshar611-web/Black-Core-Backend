const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const zplService = require('../services/zplService');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/labels/templates
router.get('/templates', authenticate, async (req, res) => {
    try {
        const templates = await prisma.labelTemplate.findMany({ orderBy: { createdAt: 'asc' } });
        res.json(templates);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load templates' });
    }
});

// POST /api/labels/generate — Generate ZPL (accepts templateId + variables OR real orderId)
router.post('/generate', authenticate, async (req, res) => {
    try {
        const { orderId, templateId, variables } = req.body;

        let template;
        if (templateId) {
            template = await prisma.labelTemplate.findUnique({ where: { id: +templateId } });
        } else {
            template = await prisma.labelTemplate.findFirst({ where: { isDefault: true } });
        }
        if (!template) return res.status(404).json({ error: 'No label template found' });

        let mergeVars = variables || {};
        if (orderId && !isNaN(orderId)) {
            const order = await prisma.order.findUnique({ where: { id: +orderId } });
            if (order) {
                mergeVars = {
                    ORDER_ID: order.orderId,
                    MARKETPLACE: order.marketplaceSource?.toUpperCase(),
                    BARCODE: order.orderId,
                    ...mergeVars,
                };
            }
        }

        const zpl = zplService.generateZpl(template.zplContent, mergeVars);
        res.json({ zpl, templateId: template.id });
    } catch (err) {
        console.error('[LABELS] Generate error:', err);
        res.status(500).json({ error: 'ZPL generation failed' });
    }
});

// POST /api/labels/print — Send ZPL to Zebra printer (flexible: by logId OR templateId+variables)
router.post('/print', authenticate, async (req, res) => {
    try {
        const { logId, templateId, variables, quantity } = req.body;

        if (logId) {
            // Existing log entry
            const logEntry = await prisma.labelPrintLog.findUnique({ where: { id: +logId } });
            if (!logEntry) return res.status(404).json({ error: 'Print job not found' });
            if (logEntry.status === 'printed') {
                return res.status(409).json({ error: 'Label already printed. Use /reprint.' });
            }
            const result = await zplService.sendToZebra(logEntry.zplGenerated, logEntry.printerIp);
            await prisma.labelPrintLog.update({
                where: { id: logEntry.id },
                data: { status: result.success ? 'printed' : 'failed', printedAt: new Date(), errorMsg: result.error || null },
            });
            return res.json({ success: result.success, message: result.success ? 'Label sent to printer' : result.error });
        }

        // Direct print from templateId + variables
        let template;
        if (templateId) {
            template = await prisma.labelTemplate.findUnique({ where: { id: +templateId } });
        } else {
            template = await prisma.labelTemplate.findFirst({ where: { isDefault: true } });
        }
        if (!template) return res.status(404).json({ error: 'No label template found' });

        const zpl = zplService.generateZpl(template.zplContent, variables || {});
        const result = await zplService.sendToZebra(zpl, process.env.ZEBRA_PRINTER_IP || '192.168.1.100');
        res.json({ success: result.success, message: result.success ? 'Label sent to printer' : result.error });
    } catch (err) {
        res.status(500).json({ error: 'Print failed' });
    }
});

// POST /api/labels/reprint/:id
router.post('/reprint/:id', authenticate, async (req, res) => {
    try {
        const logEntry = await prisma.labelPrintLog.findUnique({ where: { id: +req.params.id } });
        if (!logEntry) return res.status(404).json({ error: 'Print log not found' });

        const result = await zplService.sendToZebra(logEntry.zplGenerated, logEntry.printerIp);
        await prisma.labelPrintLog.update({
            where: { id: logEntry.id },
            data: { status: result.success ? 'printed' : 'failed', printedAt: new Date() },
        });

        res.json({ success: result.success, message: result.success ? 'Reprint sent' : result.error });
    } catch (err) {
        res.status(500).json({ error: 'Reprint failed' });
    }
});

// GET /api/labels/queue
router.get('/queue', authenticate, async (req, res) => {
    try {
        const queue = await prisma.labelPrintLog.findMany({
            where: { status: { in: ['pending', 'failed'] } },
            include: { order: true },
            orderBy: { createdAt: 'desc' },
        });
        res.json(queue);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load queue' });
    }
});

// DELETE /api/labels/queue — Clear print queue
router.delete('/queue', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const result = await prisma.labelPrintLog.deleteMany({
            where: { status: { in: ['pending', 'failed'] } },
        });
        res.json({ cleared: result.count });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear queue' });
    }
});

// GET /api/labels/log
router.get('/log', authenticate, async (req, res) => {
    try {
        const log = await prisma.labelPrintLog.findMany({
            include: { order: { select: { orderId: true, customerName: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json(log);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load print log' });
    }
});

module.exports = router;
