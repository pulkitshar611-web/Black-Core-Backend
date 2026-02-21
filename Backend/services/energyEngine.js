/**
 * Energy Engine
 * Monitors real-time kW load, enforces peak protection
 * Records readings every 30 seconds
 * Optionally reads from Modbus device if configured
 */
const cron = require('node-cron');

let prismaClient = null;
let ioClient = null;

async function readEnergyLoad() {
    if (!prismaClient) return null;

    try {
        // Try Modbus first if configured
        if (process.env.MODBUS_HOST) {
            try {
                const ModbusRTU = require('modbus-serial');
                const client = new ModbusRTU();
                await client.connectTCP(process.env.MODBUS_HOST, { port: +process.env.MODBUS_PORT || 502 });
                client.setID(+process.env.MODBUS_UNIT_ID || 1);
                const data = await client.readHoldingRegisters(0, 2);
                await client.close();
                // Assuming register 0 = kW * 100
                return { currentKw: data.data[0] / 100, source: 'modbus' };
            } catch {
                // Modbus unavailable — fall through to calculation
            }
        }

        // Calculate from printer telemetry
        const settings = await prismaClient.energySettings.findUnique({ where: { id: 1 } });
        const latest = await prismaClient.printerTelemetry.findMany({
            distinct: ['printerId'],
            orderBy: { recordedAt: 'desc' },
        });

        const printerLoad = latest.reduce((sum, t) => sum + (t.energyDraw || 0), 0);
        const currentKw = +((settings?.baseLoadKw || 1.2) + printerLoad).toFixed(2);

        return { currentKw, source: 'calculated' };
    } catch (err) {
        console.error('[ENERGY] Read error:', err.message);
        return null;
    }
}

async function checkPeakProtection(currentKw) {
    if (!prismaClient) return;

    try {
        const settings = await prismaClient.energySettings.findUnique({ where: { id: 1 } });
        if (!settings?.peakProtection) return;

        const threshold = settings.maxLoadKw * 0.9;
        if (currentKw >= threshold) {
            // Log power event
            await prismaClient.powerEvent.create({
                data: {
                    type: 'PEAK_TRIGGERED',
                    currentKw,
                    limitKw: settings.maxLoadKw,
                    action: 'New job assignment blocked by peak protection',
                },
            });

            if (ioClient) {
                ioClient.emit('energy:reading', {
                    type: 'PEAK_WARNING',
                    currentKw,
                    maxKw: settings.maxLoadKw,
                    percentage: ((currentKw / settings.maxLoadKw) * 100).toFixed(1),
                });
            }
        }
    } catch (err) {
        console.error('[ENERGY] Peak check error:', err.message);
    }
}

async function recordReading() {
    const reading = await readEnergyLoad();
    if (!reading) return;

    try {
        const settings = await prismaClient.energySettings.findUnique({ where: { id: 1 } });
        const activeCount = await prismaClient.printerTelemetry.count({
            where: { status: 'printing' },
        });

        const savedReading = await prismaClient.energyReading.create({
            data: {
                currentKw: reading.currentKw,
                maxKw: settings?.maxLoadKw || 6.0,
                activeCount,
                source: reading.source,
            },
        });

        // Emit real-time energy update
        if (ioClient) {
            ioClient.emit('energy:reading', {
                currentKw: reading.currentKw,
                maxKw: settings?.maxLoadKw || 6.0,
                percentage: ((reading.currentKw / (settings?.maxLoadKw || 6.0)) * 100).toFixed(1),
                activeCount,
                timestamp: savedReading.recordedAt,
            });
        }

        await checkPeakProtection(reading.currentKw);

        // Keep only last 1000 readings
        const count = await prismaClient.energyReading.count();
        if (count > 1000) {
            const oldest = await prismaClient.energyReading.findMany({
                orderBy: { recordedAt: 'asc' }, take: count - 1000, select: { id: true },
            });
            await prismaClient.energyReading.deleteMany({ where: { id: { in: oldest.map(r => r.id) } } });
        }
    } catch (err) {
        console.error('[ENERGY] Record error:', err.message);
    }
}

function start(prisma, io) {
    prismaClient = prisma;
    ioClient = io;
    console.log('[ENERGY] Engine started — recording every 30 seconds');
    // Record every 30 seconds
    cron.schedule('*/30 * * * * *', recordReading);
    // Run immediately
    setTimeout(recordReading, 3000);
}

module.exports = { start, readEnergyLoad };
