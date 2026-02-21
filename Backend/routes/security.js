const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/security/users
router.get('/users', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: { id: true, email: true, name: true, role: true, twoFaEnabled: true, isActive: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

// POST /api/security/users — Create user
router.post('/users', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { email, password, name, role } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
        const validRoles = ['owner', 'operator', 'maintenance'];
        if (!validRoles.includes(role)) return res.status(400).json({ error: `Role must be: ${validRoles.join(', ')}` });

        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: { email, passwordHash, name, role },
            select: { id: true, email: true, name: true, role: true },
        });

        await prisma.auditLog.create({
            data: { userId: req.user.id, action: 'USER_CREATED', entity: 'User', entityId: String(user.id), details: JSON.stringify({ email, role }) }
        });

        res.status(201).json(user);
    } catch (err) {
        if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// PUT /api/security/users/:id — Update role or revoke
router.put('/users/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { role, isActive } = req.body;
        const updateData = {};
        if (role !== undefined) updateData.role = role;
        if (isActive !== undefined) updateData.isActive = isActive;

        const user = await prisma.user.update({
            where: { id: +req.params.id },
            data: updateData,
            select: { id: true, email: true, name: true, role: true, isActive: true },
        });

        // If deactivating, revoke all sessions
        if (isActive === false) {
            await prisma.session.updateMany({
                where: { userId: +req.params.id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        }

        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: isActive === false ? 'USER_REVOKED' : 'USER_UPDATED',
                entity: 'User', entityId: String(user.id)
            }
        });

        res.json(user);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// GET /api/security/settings
router.get('/settings', authenticate, requireRole('owner'), async (req, res) => {
    try {
        let settings = await prisma.securitySettings.findUnique({ where: { id: 1 } });
        if (!settings) settings = await prisma.securitySettings.create({ data: { id: 1 } });
        res.json({ ...settings, ipWhitelist: JSON.parse(settings.ipWhitelist || '[]') });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load security settings' });
    }
});

// PUT /api/security/settings
router.put('/settings', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const { ipWhitelistEnabled, ipWhitelist, sessionTimeoutMin, twoFaEnforced, maxLoginAttempts } = req.body;
        const settings = await prisma.securitySettings.update({
            where: { id: 1 },
            data: {
                ...(ipWhitelistEnabled !== undefined && { ipWhitelistEnabled }),
                ...(ipWhitelist !== undefined && { ipWhitelist: JSON.stringify(ipWhitelist) }),
                ...(sessionTimeoutMin !== undefined && { sessionTimeoutMin }),
                ...(twoFaEnforced !== undefined && { twoFaEnforced }),
                ...(maxLoginAttempts !== undefined && { maxLoginAttempts }),
            },
        });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// GET /api/security/audit (and /audit-logs alias)
router.get(['/audit', '/audit-logs'], authenticate, requireRole('owner'), async (req, res) => {
    try {
        const logs = await prisma.auditLog.findMany({
            include: { user: { select: { email: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 200,
        });
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load audit log' });
    }
});

module.exports = router;
