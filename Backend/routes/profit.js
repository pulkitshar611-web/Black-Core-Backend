const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/profit/config
router.get('/config', authenticate, requireRole('owner'), async (req, res) => {
    try {
        let config = await prisma.profitConfig.findUnique({ where: { id: 1 } });
        if (!config) config = await prisma.profitConfig.create({ data: { id: 1 } });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load profit config' });
    }
});

// PUT /api/profit/config
router.put('/config', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { materialCostPerGram, energyCostPerKwh, depreciationPerHour, minMarginPercent, laborCostPerHour } = req.body;
        const config = await prisma.profitConfig.update({
            where: { id: 1 },
            data: {
                ...(materialCostPerGram !== undefined && { materialCostPerGram }),
                ...(energyCostPerKwh !== undefined && { energyCostPerKwh }),
                ...(depreciationPerHour !== undefined && { depreciationPerHour }),
                ...(minMarginPercent !== undefined && { minMarginPercent }),
                ...(laborCostPerHour !== undefined && { laborCostPerHour }),
            },
        });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profit config' });
    }
});

// POST /api/profit/calculate — Calculate profit score for a job
router.post('/calculate', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { weightGrams, estimatedTimeMinutes, salePrice, currency } = req.body;
        const config = await prisma.profitConfig.findUnique({ where: { id: 1 } });

        const hours = estimatedTimeMinutes / 60;
        const materialCost = weightGrams * config.materialCostPerGram;
        const energyCost = hours * 0.4 * config.energyCostPerKwh; // 0.4kW avg per printer
        const depreciation = hours * config.depreciationPerHour;
        const labor = hours * config.laborCostPerHour;
        const totalCost = materialCost + energyCost + depreciation + labor;
        const profit = salePrice - totalCost;
        const marginPercent = salePrice > 0 ? (profit / salePrice) * 100 : 0;
        const isProfitable = marginPercent >= config.minMarginPercent;

        res.json({
            breakdown: {
                materialCost: +materialCost.toFixed(3),
                energyCost: +energyCost.toFixed(3),
                depreciation: +depreciation.toFixed(3),
                labor: +labor.toFixed(3),
                totalCost: +totalCost.toFixed(3),
            },
            salePrice,
            profit: +profit.toFixed(3),
            marginPercent: +marginPercent.toFixed(1),
            isProfitable,
            recommendation: isProfitable ? 'ACCEPT' : 'REJECT',
            minMarginRequired: config.minMarginPercent,
        });
    } catch (err) {
        res.status(500).json({ error: 'Profit calculation failed' });
    }
});

module.exports = router;
