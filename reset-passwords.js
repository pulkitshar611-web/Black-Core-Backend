/**
 * BLACK CORE — Force password reset for dev/debug
 * Run: node reset-passwords.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function reset() {
    console.log('🔑 Resetting passwords...');

    const adminHash = await bcrypt.hash('blackcore2024', 10);
    const opHash = await bcrypt.hash('operator2024', 10);

    // Force update passwords regardless of existing state
    const admin = await prisma.user.upsert({
        where: { email: 'admin@blackcore.local' },
        update: { passwordHash: adminHash, isActive: true },
        create: {
            email: 'admin@blackcore.local',
            passwordHash: adminHash,
            name: 'System Administrator',
            role: 'owner',
        },
    });
    console.log('  ✅ Admin password reset:', admin.email);

    const op = await prisma.user.upsert({
        where: { email: 'operator@blackcore.local' },
        update: { passwordHash: opHash, isActive: true },
        create: {
            email: 'operator@blackcore.local',
            passwordHash: opHash,
            name: 'Floor Operator',
            role: 'operator',
        },
    });
    console.log('  ✅ Operator password reset:', op.email);

    // Clear all old sessions
    await prisma.session.deleteMany({});
    console.log('  ✅ Old sessions cleared');

    // Verify bcrypt works
    const testOk = await bcrypt.compare('blackcore2024', adminHash);
    console.log('  ✅ bcrypt verify test:', testOk ? 'PASS' : 'FAIL');

    console.log('\n🎉 Done!');
    console.log('   Admin:    admin@blackcore.local / blackcore2024');
    console.log('   Operator: operator@blackcore.local / operator2024');
}

reset()
    .catch(e => { console.error('❌ Failed:', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
