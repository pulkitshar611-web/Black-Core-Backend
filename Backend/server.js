require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// ─── Socket.io Setup ─────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:5173',
    'https://blackcore.kiaantechnology.com',
    'http://blackcore.kiaantechnology.com',
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
    },
});

// Make io accessible in routes
app.set('io', io);
app.set('prisma', prisma);

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
app.use('/api/auth/login', authLimiter);

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/printers', require('./routes/printers'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/energy', require('./routes/energy'));
app.use('/api/profit', require('./routes/profit'));
app.use('/api/marketplaces', require('./routes/marketplaces'));
app.use('/api/labels', require('./routes/labels'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/security', require('./routes/security'));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        system: 'BLACK CORE',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

// ─── WebSocket Events ─────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    socket.on('subscribe:printer', (printerId) => {
        socket.join(`printer:${printerId}`);
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Client disconnected: ${socket.id}`);
    });
});

// Make io available to services
global.io = io;

// ─── Background Services ──────────────────────────────────────
const telemetryService = require('./services/telemetryService');
const energyEngine = require('./services/energyEngine');
const marketplacePoller = require('./services/marketplacePoller');
const queueEngine = require('./services/queueEngine');

telemetryService.start(prisma, io);
energyEngine.start(prisma, io);
marketplacePoller.start(prisma, io);
queueEngine.start(prisma);

// ─── 404 Handler ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ─── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error',
    });
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
    console.log(`
  ██████╗ ██╗      █████╗  ██████╗██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗
  ██╔══██╗██║     ██╔══██╗██╔════╝██║ ██╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██████╔╝██║     ███████║██║     █████╔╝     ██║     ██║   ██║██████╔╝█████╗  
  ██╔══██╗██║     ██╔══██║██║     ██╔═██╗     ██║     ██║   ██║██╔══██╗██╔══╝  
  ██████╔╝███████╗██║  ██║╚██████╗██║  ██╗    ╚██████╗╚██████╔╝██║  ██║███████╗
  ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝
  
  BLACK CORE Industrial 3D Farm Orchestrator — v1.0.0
  Backend running on port ${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Graceful shutdown initiated...');
    await prisma.$disconnect();
    process.exit(0);
});

module.exports = { app, io, prisma };
