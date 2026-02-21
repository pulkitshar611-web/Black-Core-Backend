const express = require('express');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();
const BACKUP_DIR = path.join(__dirname, '../backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// POST /api/backup/snapshot — Create backup
router.post('/snapshot', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `blackcore-backup-${timestamp}.db`;
        const sourcePath = path.join(__dirname, '../prisma/blackcore.db');
        const destPath = path.join(BACKUP_DIR, filename);

        if (!fs.existsSync(sourcePath)) {
            return res.status(404).json({ error: 'Database file not found' });
        }

        fs.copyFileSync(sourcePath, destPath);
        const stat = fs.statSync(destPath);

        const snapshot = await prisma.backupSnapshot.create({
            data: { filename, filePath: destPath, sizeBytes: stat.size, notes: req.body.notes || null },
        });

        await prisma.auditLog.create({
            data: { userId: req.user.id, action: 'BACKUP_CREATED', entity: 'BackupSnapshot', entityId: String(snapshot.id) }
        });

        res.status(201).json(snapshot);
    } catch (err) {
        console.error('[BACKUP] Snapshot error:', err);
        res.status(500).json({ error: 'Backup failed' });
    }
});

// GET /api/backup/list (and /snapshots alias)
router.get(['/list', '/snapshots'], authenticate, requireRole('owner'), async (req, res) => {
    try {
        const snapshots = await prisma.backupSnapshot.findMany({ orderBy: { createdAt: 'desc' } });
        // Add computed sizeMb for frontend display
        const enriched = snapshots.map(s => ({ ...s, sizeMb: s.sizeBytes ? (s.sizeBytes / 1024 / 1024).toFixed(1) : null }));
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

// GET /api/backup/download/:id — Download backup file
router.get('/download/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const snapshot = await prisma.backupSnapshot.findUnique({ where: { id: +req.params.id } });
        if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
        if (!fs.existsSync(snapshot.filePath)) return res.status(404).json({ error: 'Backup file not found on disk' });
        res.download(snapshot.filePath, snapshot.filename);
    } catch (err) {
        res.status(500).json({ error: 'Download failed' });
    }
});

// POST /api/backup/restore/:id
router.post('/restore/:id', authenticate, requireRole('owner'), async (req, res) => {
    try {
        const snapshot = await prisma.backupSnapshot.findUnique({ where: { id: +req.params.id } });
        if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
        if (!fs.existsSync(snapshot.filePath)) return res.status(404).json({ error: 'Backup file missing' });

        await prisma.backupSnapshot.update({ where: { id: snapshot.id }, data: { status: 'restoring' } });

        const destPath = path.join(__dirname, '../prisma/blackcore.db');
        fs.copyFileSync(snapshot.filePath, destPath);

        await prisma.auditLog.create({
            data: {
                userId: req.user.id, action: 'BACKUP_RESTORED', entity: 'BackupSnapshot',
                entityId: String(snapshot.id), details: JSON.stringify({ filename: snapshot.filename })
            }
        });

        res.json({ message: 'Restore successful. Please restart the server.', snapshot: snapshot.filename });
    } catch (err) {
        console.error('[BACKUP] Restore error:', err);
        res.status(500).json({ error: 'Restore failed' });
    }
});

module.exports = router;
