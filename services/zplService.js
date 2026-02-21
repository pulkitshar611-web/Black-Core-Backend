/**
 * ZPL (Zebra Programming Language) Service
 * Generates ZPL code from templates and sends to Zebra ZT411 via TCP:9100
 */
const net = require('net');

// Generate ZPL by replacing template placeholders
function generateZpl(template, variables) {
    let zpl = template;
    for (const [key, value] of Object.entries(variables)) {
        zpl = zpl.replace(new RegExp(`{{${key}}}`, 'g'), String(value || ''));
    }
    return zpl;
}

// Send ZPL code to Zebra printer via TCP
function sendToZebra(zpl, printerIp, port = 9100) {
    return new Promise((resolve) => {
        const timeout = 8000; // 8 second timeout
        let resolved = false;

        const client = new net.Socket();

        const resolveOnce = (result) => {
            if (!resolved) {
                resolved = true;
                resolve(result);
            }
        };

        client.setTimeout(timeout);

        client.connect(port, printerIp, () => {
            client.write(zpl, 'binary', (err) => {
                if (err) {
                    client.destroy();
                    resolveOnce({ success: false, error: `Write error: ${err.message}` });
                } else {
                    client.end();
                    resolveOnce({ success: true });
                }
            });
        });

        client.on('error', (err) => {
            resolveOnce({ success: false, error: `Connection error: ${err.message}` });
        });

        client.on('timeout', () => {
            client.destroy();
            resolveOnce({ success: false, error: `Connection timeout after ${timeout}ms` });
        });

        client.on('close', () => {
            resolveOnce({ success: true });
        });
    });
}

// Generate a simple test ZPL label
function generateTestLabel() {
    return `^XA
^FO50,50^A0N,40,40^FDBLACK CORE TEST LABEL^FS
^FO50,110^A0N,25,25^FDPrint farm operational^FS
^FO50,150^BY2^BCN,80,Y,N,N^FDTEST-001^FS
^FO50,260^A0N,20,20^FD${new Date().toISOString()}^FS
^XZ`;
}

module.exports = { generateZpl, sendToZebra, generateTestLabel };
