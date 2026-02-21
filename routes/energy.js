const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/energy/settings
router.get('/settings', authenticate, async (req, res) => {
    try {
        let settings = await prisma.energySettings.findUnique({ where: { id: 1 } });
        if (!settings) {
            settings = await prisma.energySettings.create({ data: { id: 1 } });
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load energy settings' });
    }
});

// PUT /api/energy/settings
router.put('/settings', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { maxLoadKw, peakProtection, warmupStaggering, staggerDelayMin, baseLoadKw } = req.body;
        const settings = await prisma.energySettings.update({
            where: { id: 1 },
            data: {
                ...(maxLoadKw !== undefined && { maxLoadKw }),
                ...(peakProtection !== undefined && { peakProtection }),
                ...(warmupStaggering !== undefined && { warmupStaggering }),
                ...(staggerDelayMin !== undefined && { staggerDelayMin }),
                ...(baseLoadKw !== undefined && { baseLoadKw }),
            },
        });
        const io = req.app.get('io');
        io.emit('energy:reading', { type: 'SETTINGS_UPDATED', settings });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update energy settings' });
    }
});

// GET /api/energy/readings — Historical chart data
router.get('/readings', authenticate, async (req, res) => {
    try {
        const readings = await prisma.energyReading.findMany({
            orderBy: { recordedAt: 'desc' },
            take: 100,
        });
        res.json(readings.reverse()); // chronological order
    } catch (err) {
        res.status(500).json({ error: 'Failed to load energy readings' });
    }
});

// GET /api/energy/events — Power spike logs
router.get('/events', authenticate, async (req, res) => {
    try {
        const events = await prisma.powerEvent.findMany({
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json(events);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load power events' });
    }
});

module.exports = router;
