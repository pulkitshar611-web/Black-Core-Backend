const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('🏗️ Generating Industrial Demo Data...');

    // 0. Cleanup existing demo data (Optional but helpful for repeated runs)
    await prisma.queueItem.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.order.deleteMany({});
    console.log('  🗑️ Old demo data cleared');

    // 1. Create Sample Orders
    const orders = [
        {
            orderId: 'XOM-2024-88A',
            customerName: 'AeroSpace Dynamics',
            marketplaceSource: 'xometry',
            items: 1, // Count of items
            totalValue: 450.00,
            status: 'won',
        },
        {
            orderId: 'TS-99212',
            customerName: 'Medical Robotics Ltd',
            marketplaceSource: 'treatstock',
            items: 1,
            totalValue: 1200.00,
            status: 'in_production',
        },
        {
            orderId: 'MANUAL-101',
            customerName: 'Local Prototyping',
            marketplaceSource: 'manual',
            items: 1,
            totalValue: 85.00,
            status: 'quoted',
        }
    ];

    for (const o of orders) {
        await prisma.order.upsert({
            where: { orderId: o.orderId },
            update: {},
            create: o
        });
    }
    console.log('  ✅ 3 Sample Orders created');

    // 2. Create Sample Jobs (linked to orders)
    const o2 = await prisma.order.findFirst({ where: { orderId: 'TS-99212' } });
    const o1 = await prisma.order.findFirst({ where: { orderId: 'XOM-2024-88A' } });

    const job1 = await prisma.job.create({
        data: {
            jobCode: 'JOB-7701',
            name: 'Turbine_Blade_Batch_A',
            order: { connect: { id: o1.id } },
            material: 'PLA Platinum',
            weightGrams: 145.5,
            status: 'queued',
            priority: 'high',
            estimatedTime: 480, // 8 hours
        }
    });

    const job2 = await prisma.job.create({
        data: {
            jobCode: 'JOB-7702',
            name: 'Surgical_Guide_Set_1',
            order: { connect: { id: o2.id } },
            material: 'Tough Resin',
            weightGrams: 42.0,
            status: 'printing',
            priority: 'critical',
            estimatedTime: 120, // 2 hours
        }
    });
    console.log('  ✅ 2 Production Jobs created');

    // 3. Populate Queue
    const printer = await prisma.printer.findFirst({ where: { name: 'MAX4-ALPHA' } });

    await prisma.queueItem.create({
        data: {
            job: { connect: { id: job1.id } },
            status: 'queued',
            priority: 2,
        }
    });

    await prisma.queueItem.create({
        data: {
            job: { connect: { id: job2.id } },
            printer: { connect: { id: printer.id } },
            status: 'printing',
            priority: 1,
        }
    });
    console.log('  ✅ Global Queue populated');

    // 4. Create a sample Label Log
    await prisma.labelPrintLog.create({
        data: {
            order: { connect: { id: o1.id } },
            zplGenerated: '^XA^FO50,50^A0N,30,30^FDXOMETRY^FS^XZ',
            printerIp: '192.168.1.100',
            status: 'SUCCESS'
        }
    });
    console.log('  ✅ 1 Label Print Log created');

    // 5. Sample Audit Logs
    await prisma.auditLog.create({
        data: {
            userId: 1, // Admin
            action: 'DEMO_DATA_GENERATION',
            details: 'Populated system with industrial sample data for walkthrough.'
        }
    });

    console.log('\n🚀 Demo Data Ready! Refresh your browser to see the system in action.');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
