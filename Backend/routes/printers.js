const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/printers — All printers with latest telemetry
router.get('/', authenticate, async (req, res) => {
    try {
        const printers = await prisma.printer.findMany({
            where: { isActive: true },
            orderBy: { name: 'asc' },
        });

        // Get latest telemetry for each printer
        const withTelemetry = await Promise.all(printers.map(async (p) => {
            const telemetry = await prisma.printerTelemetry.findFirst({
                where: { printerId: p.id },
                orderBy: { recordedAt: 'desc' },
            });
            const activeJob = await prisma.job.findFirst({
                where: { printerId: p.id, status: 'printing' },
            });
            return {
                ...p,
                telemetry: telemetry || { status: 'offline', extruderTemp: 0, bedTemp: 0, progress: 0, energyDraw: 0 },
                currentJob: activeJob?.name || null,
            };
        }));

        res.json(withTelemetry);
    } catch (err) {
        console.error('[PRINTERS] GET error:', err);
        res.status(500).json({ error: 'Failed to load printers' });
    }
});

// POST /api/printers — Add new printer (Admin only)
router.post('/', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { name, ipAddress, model, firmware, energyRating, maxTempExtruder, maxTempBed } = req.body;
        if (!name || !ipAddress) {
            return res.status(400).json({ error: 'Name and IP address required' });
        }

        const printer = await prisma.printer.create({
            data: {
                name, ipAddress, model: model || 'Generic', firmware: firmware || 'unknown',
                energyRating: energyRating || 0.4, maxTempExtruder: maxTempExtruder || 260,
                maxTempBed: maxTempBed || 110
            },
        });

        // Create initial telemetry record
        await prisma.printerTelemetry.create({
            data: { printerId: printer.id, status: 'offline' },
        });

        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: 'PRINTER_ADDED', entity: 'Printer',
                entityId: String(printer.id), details: JSON.stringify({ name, ipAddress })
            }
        });

        const io = req.app.get('io');
        io.emit('queue:updated', { type: 'PRINTER_ADDED', printer });

        res.status(201).json(printer);
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ error: 'Printer name already exists' });
        console.error('[PRINTERS] POST error:', err);
        res.status(500).json({ error: 'Failed to add printer' });
    }
});

// GET /api/printers/:id — Single printer detail
router.get('/:id', authenticate, async (req, res) => {
    try {
        const printer = await prisma.printer.findUnique({ where: { id: +req.params.id } });
        if (!printer) return res.status(404).json({ error: 'Printer not found' });

        const telemetry = await prisma.printerTelemetry.findFirst({
            where: { printerId: printer.id },
            orderBy: { recordedAt: 'desc' },
        });
        const activeJob = await prisma.job.findFirst({ where: { printerId: printer.id, status: 'printing' } });

        res.json({ ...printer, telemetry, currentJob: activeJob });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load printer' });
    }
});

// GET /api/printers/:id/telemetry — Recent telemetry history
router.get('/:id/telemetry', authenticate, async (req, res) => {
    try {
        const records = await prisma.printerTelemetry.findMany({
            where: { printerId: +req.params.id },
            orderBy: { recordedAt: 'desc' },
            take: 100,
        });
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load telemetry' });
    }
});

// GET /api/printers/:id/events — Error logs
router.get('/:id/events', authenticate, async (req, res) => {
    try {
        const events = await prisma.printerEvent.findMany({
            where: { printerId: +req.params.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json(events);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load events' });
    }
});

// POST /api/printers/:id/command — Send control command
router.post('/:id/command', authenticate, requireRole('owner', 'operator'), async (req, res) => {
    try {
        const { command } = req.body; // start | pause | resume | halt | maintenance
        const validCommands = ['start', 'pause', 'resume', 'halt', 'maintenance'];
        if (!validCommands.includes(command)) {
            return res.status(400).json({ error: `Invalid command. Valid: ${validCommands.join(', ')}` });
        }

        const printer = await prisma.printer.findUnique({ where: { id: +req.params.id } });
        if (!printer) return res.status(404).json({ error: 'Printer not found' });

        // Map command to status
        const statusMap = {
            start: 'printing',
            pause: 'paused',
            resume: 'printing',
            halt: 'idle',
            maintenance: 'maintenance',
        };
        const newStatus = statusMap[command];

        // Update latest telemetry record
        const latest = await prisma.printerTelemetry.findFirst({
            where: { printerId: printer.id },
            orderBy: { recordedAt: 'desc' },
        });
        if (latest) {
            await prisma.printerTelemetry.update({
                where: { id: latest.id },
                data: { status: newStatus },
            });
        }

        // Log command as event
        await prisma.printerEvent.create({
            data: {
                printerId: printer.id,
                level: command === 'halt' ? 'WARN' : 'INFO',
                code: `CMD_${command.toUpperCase()}`,
                message: `Command '${command}' sent by ${req.user.name}`,
            },
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: `PRINTER_${command.toUpperCase()}`,
                entity: 'Printer', entityId: String(printer.id), ipAddress: req.ip
            }
        });

        // Emit real-time update
        const io = req.app.get('io');
        io.emit('printer:telemetry', { printerId: printer.id, status: newStatus });
        io.to(`printer:${printer.id}`).emit('printer:event', {
            printerId: printer.id, command, newStatus, operator: req.user.name
        });

        res.json({ success: true, printerId: printer.id, command, newStatus });
    } catch (err) {
        console.error('[PRINTERS] Command error:', err);
        res.status(500).json({ error: 'Command failed' });
    }
});

// DELETE /api/printers/:id — Remove printer
router.delete('/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        await prisma.printer.update({ where: { id: +req.params.id }, data: { isActive: false } });
        res.json({ message: 'Printer deactivated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove printer' });
    }
});

module.exports = router;
