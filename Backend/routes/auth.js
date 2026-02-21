const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password, twoFaCode } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatch) {
            // Log failed attempt
            await prisma.auditLog.create({
                data: { action: 'LOGIN_FAILED', entity: 'User', entityId: String(user.id), ipAddress: req.ip }
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check 2FA if enabled
        if (user.twoFaEnabled) {
            if (!twoFaCode) {
                return res.status(200).json({ requiresTwoFa: true, message: '2FA code required' });
            }
            const verified = speakeasy.totp.verify({
                secret: user.twoFaSecret,
                encoding: 'base32',
                token: twoFaCode,
                window: 1,
            });
            if (!verified) {
                return res.status(401).json({ error: 'Invalid 2FA code' });
            }
        }

        // Generate JWT
        const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn }
        );

        // Save session to DB (for revocation support)
        const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours
        await prisma.session.create({ data: { token, userId: user.id, expiresAt } });

        // Audit log
        await prisma.auditLog.create({
            data: { userId: user.id, action: 'LOGIN', entity: 'User', entityId: String(user.id), ipAddress: req.ip }
        });

        res.json({
            token,
            user: { id: user.id, email: user.email, name: user.name, role: user.role, twoFaEnabled: user.twoFaEnabled },
        });
    } catch (err) {
        console.error('[AUTH] Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ─── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
    try {
        await prisma.session.update({
            where: { token: req.token },
            data: { revokedAt: new Date() },
        });
        await prisma.auditLog.create({
            data: { userId: req.user.id, action: 'LOGOUT', entity: 'User', entityId: String(req.user.id), ipAddress: req.ip }
        });
        res.json({ message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// ─── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
    const { id, email, name, role, twoFaEnabled } = req.user;
    res.json({ id, email, name, role, twoFaEnabled });
});

// ─── POST /api/auth/2fa/setup ─────────────────────────────────
router.post('/2fa/setup', authenticate, async (req, res) => {
    try {
        const secret = speakeasy.generateSecret({
            name: `${process.env.TWO_FA_APP_NAME || 'BlackCore'}:${req.user.email}`,
        });

        // Store secret temp (not enabled yet until verified)
        await prisma.user.update({
            where: { id: req.user.id },
            data: { twoFaSecret: secret.base32 },
        });

        const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);
        res.json({ secret: secret.base32, qrCode: qrCodeUrl });
    } catch (err) {
        res.status(500).json({ error: '2FA setup failed' });
    }
});

// ─── POST /api/auth/2fa/verify ────────────────────────────────
router.post('/2fa/verify', authenticate, async (req, res) => {
    try {
        const { code } = req.body;
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });

        const verified = speakeasy.totp.verify({
            secret: user.twoFaSecret,
            encoding: 'base32',
            token: code,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ error: 'Invalid 2FA code' });
        }

        // Enable 2FA
        await prisma.user.update({ where: { id: user.id }, data: { twoFaEnabled: true } });
        await prisma.auditLog.create({
            data: { userId: user.id, action: '2FA_ENABLED', entity: 'User', entityId: String(user.id) }
        });

        res.json({ message: '2FA enabled successfully' });
    } catch (err) {
        res.status(500).json({ error: '2FA verification failed' });
    }
});

// ─── POST /api/auth/2fa/disable ──────────────────────────────
router.post('/2fa/disable', authenticate, requireRole('owner'), async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.user.id },
            data: { twoFaEnabled: false, twoFaSecret: null },
        });
        res.json({ message: '2FA disabled' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

module.exports = router;
