const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding BLACK CORE database...');

    // ─── Default Admin User ──────────────────────────────────
    const passwordHash = await bcrypt.hash('blackcore2024', 10);

    const admin = await prisma.user.upsert({
        where: { email: 'admin@blackcore.local' },
        update: {},
        create: {
            email: 'admin@blackcore.local',
            passwordHash,
            name: 'System Administrator',
            role: 'owner',
        },
    });
    console.log('  ✅ Admin user created:', admin.email);

    // Operator user
    const opHash = await bcrypt.hash('operator2024', 10);
    await prisma.user.upsert({
        where: { email: 'operator@blackcore.local' },
        update: {},
        create: {
            email: 'operator@blackcore.local',
            passwordHash: opHash,
            name: 'Floor Operator',
            role: 'operator',
        },
    });
    console.log('  ✅ Operator user created');

    // ─── Default Printers ────────────────────────────────────
    const printers = [
        { name: 'MAX4-ALPHA', ipAddress: '192.168.1.101', model: 'MAX4 Pro', firmware: 'v2.4.12' },
        { name: 'MAX4-BETA', ipAddress: '192.168.1.102', model: 'MAX4 Pro', firmware: 'v2.4.12' },
        { name: 'MAX4-GAMMA', ipAddress: '192.168.1.103', model: 'MAX4 Pro', firmware: 'v2.4.12' },
        { name: 'PRO-101', ipAddress: '192.168.1.104', model: 'PRO Series', firmware: 'v2.1.0' },
        { name: 'PRO-102', ipAddress: '192.168.1.105', model: 'PRO Series', firmware: 'v2.1.0' },
        { name: 'PRO-103', ipAddress: '192.168.1.106', model: 'PRO Series', firmware: 'v2.1.0' },
    ];

    for (const p of printers) {
        await prisma.printer.upsert({
            where: { name: p.name },
            update: {},
            create: p,
        });
    }
    console.log(`  ✅ ${printers.length} printers seeded`);

    // ─── Energy Settings (default) ───────────────────────────
    await prisma.energySettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, maxLoadKw: 6.0, peakProtection: true, warmupStaggering: true },
    });
    console.log('  ✅ Energy settings initialized');

    // ─── Profit Config (default) ─────────────────────────────
    await prisma.profitConfig.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, materialCostPerGram: 0.025, energyCostPerKwh: 0.28, depreciationPerHour: 0.15, minMarginPercent: 20 },
    });
    console.log('  ✅ Profit config initialized');

    // ─── Marketplace Integrations ────────────────────────────
    const platforms = [
        { name: 'xometry', displayName: 'Xometry', apiUrl: 'https://api.xometry.com/v1' },
        { name: 'treatstock', displayName: 'Treatstock', apiUrl: 'https://api.treatstock.com' },
        { name: 'craftcloud', displayName: 'Craftcloud', apiUrl: 'https://api.craftcloud3d.com' },
    ];
    for (const p of platforms) {
        await prisma.marketplaceIntegration.upsert({
            where: { name: p.name },
            update: {},
            create: p,
        });
    }
    console.log('  ✅ Marketplace integrations seeded');

    // ─── Default Alert Rules ─────────────────────────────────
    const alertRules = [
        { name: 'Printer Critical Failure', trigger: 'PRINTER_ERROR', severity: 'critical', channel: 'telegram', redundancy: true },
        { name: 'Energy Overload Warning', trigger: 'ENERGY_OVERLOAD', severity: 'warning', channel: 'telegram' },
        { name: 'Job Completed', trigger: 'JOB_COMPLETE', severity: 'info', channel: 'telegram' },
        { name: 'Smoke Sensor Triggered', trigger: 'SMOKE', severity: 'critical', channel: 'all', redundancy: true },
        { name: 'Material Low', trigger: 'MATERIAL_LOW', severity: 'warning', channel: 'telegram', isEnabled: false },
    ];
    for (const rule of alertRules) {
        const exists = await prisma.alertRule.findFirst({ where: { name: rule.name } });
        if (!exists) await prisma.alertRule.create({ data: rule });
    }
    console.log('  ✅ Alert rules seeded');

    // ─── Default Label Template ──────────────────────────────
    const zplTemplate = `^XA
^FO50,50^A0N,30,30^FD{{MARKETPLACE}}^FS
^FO50,90^A0N,50,50^FDORD-{{ORDER_ID}}^FS
^FO50,160^BY3^BCN,100,Y,N,N^FD{{BARCODE}}^FS
^FO50,280^A0N,20,20^FDFACILITY: BLACK CORE PRODUCTION^FS
^FO50,310^A0N,20,20^FDSTATION: {{PRINTER_NAME}}^FS
^FO50,340^A0N,20,20^FDDATE: {{DATE}}^FS
^XZ`;

    await prisma.labelTemplate.upsert({
        where: { name: 'Carrier Industrial v1' },
        update: {},
        create: {
            name: 'Carrier Industrial v1',
            description: 'Standard carrier label for all marketplaces',
            zplContent: zplTemplate,
            isDefault: true,
        },
    });
    console.log('  ✅ Default label template seeded');

    // ─── Security Settings ───────────────────────────────────
    await prisma.securitySettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
    });
    console.log('  ✅ Security settings initialized');

    console.log('\n🎉 Database seeded successfully!');
    console.log('   Admin login: admin@blackcore.local / blackcore2024');
    console.log('   Operator login: operator@blackcore.local / operator2024');
}

main()
    .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
