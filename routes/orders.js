const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/orders — All orders (optional filter by status)
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, search } = req.query;
        const where = {};
        if (status) where.status = status;
        if (search) {
            where.OR = [
                { orderId: { contains: search } },
                { customerName: { contains: search } },
            ];
        }
        const orders = await prisma.order.findMany({
            where,
            include: { statusLogs: { orderBy: { createdAt: 'desc' }, take: 3 } },
            orderBy: { createdAt: 'desc' },
            take: 200,
        });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

// GET /api/orders/:id — Full order detail
router.get('/:id', authenticate, async (req, res) => {
    try {
        const order = await prisma.order.findUnique({
            where: { id: +req.params.id },
            include: {
                statusLogs: { orderBy: { createdAt: 'desc' } },
                jobs: { include: { printer: true } },
            },
        });
        if (!order) return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load order' });
    }
});

// POST /api/orders — Manual order creation
router.post('/', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { customerName, customerEmail, items, totalValue, currency, notes } = req.body;
        if (!customerName) return res.status(400).json({ error: 'Customer name required' });

        const orderId = `ORD-${Date.now()}`;
        const order = await prisma.order.create({
            data: {
                orderId,
                marketplaceSource: 'manual',
                customerName,
                customerEmail: customerEmail || null,
                items: items || 1,
                totalValue: totalValue || 0,
                currency: currency || 'EUR',
                notes: notes || null,
                statusLogs: {
                    create: { toStatus: 'incoming', actor: req.user.email }
                },
            },
        });

        const io = req.app.get('io');
        io.emit('order:statusChanged', { orderId: order.id, newStatus: 'incoming' });

        res.status(201).json(order);
    } catch (err) {
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// PUT /api/orders/:id/status — Move through lifecycle
router.put('/:id/status', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { status, reason } = req.body;
        const validStatuses = ['incoming', 'quoted', 'won', 'rejected', 'printing', 'completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Valid: ${validStatuses.join(', ')}` });
        }

        const current = await prisma.order.findUnique({ where: { id: +req.params.id } });
        if (!current) return res.status(404).json({ error: 'Order not found' });

        const [order] = await prisma.$transaction([
            prisma.order.update({
                where: { id: +req.params.id },
                data: { status },
            }),
            prisma.orderStatusLog.create({
                data: {
                    orderId: +req.params.id,
                    fromStatus: current.status,
                    toStatus: status,
                    actor: req.user.email,
                    reason: reason || null,
                },
            }),
        ]);

        const io = req.app.get('io');
        io.emit('order:statusChanged', { orderId: order.id, newStatus: status });

        res.json(order);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update order status' });
    }
});

// GET /api/orders/export — CSV download
router.get('/export/csv', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
        const csv = [
            'Order ID,Marketplace,Customer,Items,Total,Currency,Status,Created At',
            ...orders.map(o =>
                `${o.orderId},${o.marketplaceSource},${o.customerName},${o.items},${o.totalValue},${o.currency},${o.status},${o.createdAt}`
            ),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: 'Export failed' });
    }
});

module.exports = router;
