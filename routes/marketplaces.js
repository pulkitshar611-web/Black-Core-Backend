const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/marketplaces — All integrations
router.get('/', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const integrations = await prisma.marketplaceIntegration.findMany({
            include: {
                syncLogs: { orderBy: { createdAt: 'desc' }, take: 5 },
            },
        });
        // Mask API keys
        const masked = integrations.map(i => ({
            ...i,
            apiKey: i.apiKey ? `***${i.apiKey.slice(-4)}` : null,
            apiSecret: i.apiSecret ? '***hidden***' : null,
        }));
        res.json(masked);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load integrations' });
    }
});

// PUT /api/marketplaces/:name — Update integration settings
router.put('/:name', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { apiKey, apiSecret, pollIntervalSec, isEnabled } = req.body;
        const integration = await prisma.marketplaceIntegration.updateMany({
            where: { name: req.params.name },
            data: {
                ...(apiKey !== undefined && { apiKey }),
                ...(apiSecret !== undefined && { apiSecret }),
                ...(pollIntervalSec !== undefined && { pollIntervalSec }),
                ...(isEnabled !== undefined && { isEnabled }),
                status: isEnabled ? 'active' : 'offline',
            },
        });
        res.json({ message: 'Integration updated', updated: integration.count });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update integration' });
    }
});

// POST /api/marketplaces/:name/sync — Force sync now
router.post('/:name/sync', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const marketplacePoller = require('../services/marketplacePoller');
        const result = await marketplacePoller.syncOne(req.params.name, prisma);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Sync failed', detail: err.message });
    }
});

// GET /api/marketplaces/logs — Sync history (and /logs/all alias)
router.get(['/logs', '/logs/all'], authenticate, async (req, res) => {
    try {
        const logs = await prisma.marketplaceSyncLog.findMany({
            include: { integration: { select: { name: true, displayName: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load logs' });
    }
});

module.exports = router;
