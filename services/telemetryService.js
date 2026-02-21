/**
 * Telemetry Service
 * Polls each printer every 5-10 seconds via HTTP (Moonraker/Klipper API)
 * Falls back to simulated data if printer is unreachable
 */
const axios = require('axios');

let prismaClient = null;
let ioClient = null;
let intervalId = null;

const POLL_INTERVAL_MS = 7000; // 7 seconds (PRD: 5-10s)

async function pollPrinter(printer) {
    try {
        // Try to reach Moonraker API (standard for Klipper-based printers)
        const response = await axios.get(
            `http://${printer.ipAddress}/printer/objects/query?extruder&heater_bed&print_stats&display_status&fan`,
            { timeout: 3000 }
        );

        const data = response.data?.result?.status || {};
        const extruder = data.extruder || {};
        const bed = data.heater_bed || {};
        const printStats = data.print_stats || {};
        const fan = data.fan || {};

        const telemetry = {
            printerId: printer.id,
            extruderTemp: extruder.temperature || 0,
            bedTemp: bed.temperature || 0,
            progress: (printStats.progress || 0) * 100,
            status: mapKlipperStatus(printStats.state),
            filamentPresent: true, // Would need filament sensor endpoint
            fanRpm: Math.round((fan.speed || 0) * 5000),
            energyDraw: calculateEnergyDraw(extruder.temperature, bed.temperature, printer.energyRating),
        };

        return { ...telemetry, error: null, isReachable: true };
    } catch (err) {
        // Printer unreachable — return offline status
        return {
            printerId: printer.id,
            extruderTemp: 0,
            bedTemp: 0,
            progress: 0,
            status: 'offline',
            filamentPresent: false,
            fanRpm: 0,
            energyDraw: 0,
            error: err.message,
            isReachable: false,
        };
    }
}

function mapKlipperStatus(state) {
    const map = {
        printing: 'printing',
        paused: 'paused',
        standby: 'idle',
        complete: 'idle',
        cancelled: 'idle',
        error: 'error',
    };
    return map[state] || 'offline';
}

function calculateEnergyDraw(extruderTemp, bedTemp, baseRating) {
    // Estimated kW based on heater temperatures
    if (extruderTemp < 50 && bedTemp < 30) return 0.05; // standby
    const extruderLoad = extruderTemp > 150 ? 0.25 : 0.05;
    const bedLoad = bedTemp > 50 ? 0.15 : 0.02;
    return +(baseRating * 0.6 + extruderLoad + bedLoad).toFixed(3);
}

async function runPoll() {
    if (!prismaClient) return;

    try {
        const printers = await prismaClient.printer.findMany({ where: { isActive: true } });

        for (const printer of printers) {
            const data = await pollPrinter(printer);

            // Save telemetry to DB
            await prismaClient.printerTelemetry.create({
                data: {
                    printerId: data.printerId,
                    extruderTemp: data.extruderTemp,
                    bedTemp: data.bedTemp,
                    progress: data.progress,
                    status: data.status,
                    filamentPresent: data.filamentPresent,
                    fanRpm: data.fanRpm,
                    energyDraw: data.energyDraw,
                },
            });

            // Emit real-time update via WebSocket
            if (ioClient) {
                ioClient.emit('printer:telemetry', {
                    printerId: printer.id,
                    name: printer.name,
                    ...data,
                });
                ioClient.to(`printer:${printer.id}`).emit('printer:telemetry', {
                    printerId: printer.id,
                    name: printer.name,
                    ...data,
                });
            }

            // Check for thermal stability issues
            if (data.extruderTemp > printer.maxTempExtruder) {
                await prismaClient.printerEvent.create({
                    data: {
                        printerId: printer.id,
                        level: 'CRITICAL',
                        code: 'THERMAL_RUNAWAY',
                        message: `Extruder temp ${data.extruderTemp}°C exceeds limit ${printer.maxTempExtruder}°C`,
                    },
                });
                if (ioClient) {
                    ioClient.emit('printer:event', {
                        printerId: printer.id, level: 'CRITICAL', code: 'THERMAL_RUNAWAY'
                    });
                }
            }

            // Keep telemetry table clean — retain only last 500 records per printer
            const count = await prismaClient.printerTelemetry.count({ where: { printerId: printer.id } });
            if (count > 500) {
                const oldest = await prismaClient.printerTelemetry.findMany({
                    where: { printerId: printer.id },
                    orderBy: { recordedAt: 'asc' },
                    take: count - 500,
                    select: { id: true },
                });
                await prismaClient.printerTelemetry.deleteMany({
                    where: { id: { in: oldest.map(r => r.id) } },
                });
            }
        }
    } catch (err) {
        console.error('[TELEMETRY] Poll error:', err.message);
    }
}

function start(prisma, io) {
    prismaClient = prisma;
    ioClient = io;
    console.log('[TELEMETRY] Service started — polling every', POLL_INTERVAL_MS / 1000, 'seconds');
    intervalId = setInterval(runPoll, POLL_INTERVAL_MS);
    // Run immediately on start
    setTimeout(runPoll, 2000);
}

function stop() {
    if (intervalId) clearInterval(intervalId);
}

module.exports = { start, stop };
