const nodemailer = require('nodemailer');

export default async function handler(req, res) {
    // Manejo de CORS por si acaso
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ exito: false, mensaje: 'Método no permitido' });
    }

    const { correo, codigo, nombre_completo } = req.body;

    if (!correo || !codigo) {
        return res.status(400).json({ exito: false, mensaje: 'Faltan datos' });
    }

    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"Book Center" <${process.env.EMAIL_USER}>`,
            to: correo,
            subject: '🔑 Código de verificación — Book Center',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                    <div style="background: #1e40af; padding: 24px; text-align: center;">
                        <h2 style="color: white; margin: 0; font-size: 20px;">📚 Book Center</h2>
                        <p style="color: #bfdbfe; margin: 4px 0 0 0; font-size: 13px;">Sistema de Librería</p>
                    </div>
                    <div style="padding: 32px 24px;">
                        <p style="color: #1e293b; font-size: 15px;">Hola, <strong>${nombre_completo || 'Usuario'}</strong>.</p>
                        <p style="color: #475569; font-size: 14px;">Recibimos una solicitud para restablecer tu contraseña. Usa el siguiente código de verificación:</p>
                        <div style="background: #f1f5f9; border-radius: 10px; padding: 24px; text-align: center; margin: 24px 0;">
                            <span style="font-size: 42px; font-weight: 900; letter-spacing: 8px; color: #1e40af; font-family: monospace;">${codigo}</span>
                        </div>
                        <p style="color: #64748b; font-size: 13px;">⏱️ Este código expira en <strong>15 minutos</strong>.</p>
                        <p style="color: #94a3b8; font-size: 12px;">Si no solicitaste restablecer tu contraseña, ignora este correo.</p>
                    </div>
                    <div style="background: #f8fafc; padding: 16px; text-align: center; border-top: 1px solid #e2e8f0;">
                        <p style="color: #94a3b8; font-size: 11px; margin: 0;">Book Center © 2026 — No responder este correo</p>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json({ exito: true, mensaje: 'Correo enviado correctamente' });
    } catch (error) {
        console.error('Error enviando correo en Vercel:', error);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(500).json({ exito: false, mensaje: 'Error interno SMTP en Vercel', detalle: error.message });
    }
}
