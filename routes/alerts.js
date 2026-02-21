const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');
const alertService = require('../services/alertService');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/alerts/rules
router.get('/rules', authenticate, async (req, res) => {
    try {
        const rules = await prisma.alertRule.findMany({ orderBy: { createdAt: 'asc' } });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load alert rules' });
    }
});

// POST /api/alerts/rules
router.post('/rules', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { name, trigger, severity, channel, redundancy } = req.body;
        if (!name || !trigger || !severity || !channel) {
            return res.status(400).json({ error: 'name, trigger, severity, channel required' });
        }
        const rule = await prisma.alertRule.create({
            data: { name, trigger, severity, channel, redundancy: redundancy || false },
        });
        res.status(201).json(rule);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create alert rule' });
    }
});

// PUT /api/alerts/rules/:id — Enable/disable
router.put('/rules/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { isEnabled, redundancy } = req.body;
        const rule = await prisma.alertRule.update({
            where: { id: +req.params.id },
            data: {
                ...(isEnabled !== undefined && { isEnabled }),
                ...(redundancy !== undefined && { redundancy }),
            },
        });
        res.json(rule);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update rule' });
    }
});

// GET /api/alerts/log (and /logs alias)
router.get(['/log', '/logs'], authenticate, async (req, res) => {
    try {
        const logs = await prisma.alertLog.findMany({
            include: { rule: { select: { name: true, trigger: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load alert log' });
    }
});

// POST /api/alerts/test — Send test alert (all channels)
router.post('/test', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { channel } = req.body;
        await alertService.sendAlert(channel || 'telegram', '🧪 BLACK CORE Test Alert — System online and operational.');
        res.json({ message: 'Test alert sent', channel });
    } catch (err) {
        res.status(500).json({ error: 'Test alert failed', detail: err.message });
    }
});

// POST /api/alerts/test/:id — Test specific alert rule
router.post('/test/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const rule = await prisma.alertRule.findUnique({ where: { id: +req.params.id } });
        if (!rule) return res.status(404).json({ error: 'Rule not found' });
        await alertService.sendAlert(rule.channel, `🧪 Test for rule: ${rule.name}`);
        res.json({ message: 'Test alert sent', ruleId: rule.id, channel: rule.channel });
    } catch (err) {
        res.status(500).json({ error: 'Test alert failed', detail: err.message });
    }
});

module.exports = router;
