import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

// El ARN del tema debe existir antes de que se cargue la configuración
const TOPIC = 'arn:aws:sns:us-east-1:111122223333:kernel-ses-eventos';
process.env.SES_SNS_TOPIC_ARN = TOPIC;

const { createApp } = await import('../../src/createApp.js');
const { default: pool } = await import('../../src/db/database.js');
const { certificadosDePrueba, suscripcionesConfirmadasDePrueba } = await import('../../src/services/snsService.js');
const { enviarEmail, emailsDePrueba } = await import('../../src/services/emailService.js');

const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
certificadosDePrueba.set(CERT_URL, publicKey.export({ type: 'spki', format: 'pem' }));

// Construye un mensaje SNS firmado igual que lo hace AWS
const CAMPOS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};
const firmar = (msg, { version = '2', clave = privateKey } = {}) => {
  const aFirmar = CAMPOS[msg.Type].filter((k) => msg[k] !== undefined).map((k) => `${k}\n${msg[k]}\n`).join('');
  const firma = crypto.sign(version === '2' ? 'sha256' : 'sha1', Buffer.from(aFirmar), clave).toString('base64');
  return { ...msg, SignatureVersion: version, Signature: firma, SigningCertURL: CERT_URL };
};
const notificacion = (cuerpo, extra = {}) => firmar({
  Type: 'Notification', MessageId: crypto.randomUUID(), TopicArn: TOPIC, Timestamp: new Date().toISOString(),
  Message: JSON.stringify(cuerpo), ...extra,
});

let app;
const mailAdmin = 'email-test@icebreaker.com';
const pass = 'testpass123';
let adminUuid;
const direcciones = ['rebote-perm@ses-test.co', 'rebote-temp@ses-test.co', 'queja@ses-test.co', 'sin-suprimir@ses-test.co'];

const enviarSns = (msg) => request(app).post('/api/email/ses-eventos').set('Content-Type', 'text/plain; charset=UTF-8').send(JSON.stringify(msg));

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Email Test', $1, $2, 'juridico', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [mailAdmin, hash]
  );
  adminUuid = u.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
      WHERE m.nombre = 'mailing' AND a.nombre IN ('READ','DELETE') ON CONFLICT DO NOTHING`, [adminUuid]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM email_ses_eventos WHERE email = ANY($1)', [direcciones]);
  await pool.query('DELETE FROM email_supresiones WHERE email = ANY($1)', [direcciones]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

describe('Email — eventos de SES por SNS', () => {
  test('rebote permanente → guarda el evento y suprime la dirección', async () => {
    const msg = notificacion({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bounceSubType: 'General', timestamp: new Date().toISOString(),
        bouncedRecipients: [{ emailAddress: 'Rebote-Perm@ses-test.co', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] },
    });
    const res = await enviarSns(msg);
    expect(res.status).toBe(200);

    const { rows: [s] } = await pool.query(`SELECT motivo, is_active, detalle FROM email_supresiones WHERE lower(email) = 'rebote-perm@ses-test.co'`);
    expect(s).toMatchObject({ motivo: 'rebote', is_active: true });
    expect(s.detalle.bounceType).toBe('Permanent');
    const { rows: ev } = await pool.query(`SELECT tipo, message_id FROM email_ses_eventos WHERE email = 'rebote-perm@ses-test.co'`);
    expect(ev).toEqual([{ tipo: 'rebote_permanente', message_id: msg.MessageId }]);
  });

  test('rebote temporal → solo queda en la bitácora, no se suprime', async () => {
    const res = await enviarSns(notificacion({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', bouncedRecipients: [{ emailAddress: 'rebote-temp@ses-test.co' }] },
    }));
    expect(res.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM email_supresiones WHERE email = 'rebote-temp@ses-test.co'`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM email_ses_eventos WHERE tipo = 'rebote_temporal' AND email = 'rebote-temp@ses-test.co'`)).rowCount).toBe(1);
  });

  test('queja → suprime la dirección', async () => {
    const res = await enviarSns(notificacion({
      notificationType: 'Complaint',
      complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'queja@ses-test.co' }] },
    }));
    expect(res.status).toBe(200);
    const { rows: [s] } = await pool.query(`SELECT motivo FROM email_supresiones WHERE email = 'queja@ses-test.co'`);
    expect(s.motivo).toBe('queja');
  });

  test('firma inválida (alterada o de otra llave) → 403 y no toca nada', async () => {
    const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const cuerpo = { notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'sin-suprimir@ses-test.co' }] } };
    expect((await enviarSns(notificacion(cuerpo, {}))).status).toBe(200); // control: válida
    await pool.query(`DELETE FROM email_supresiones WHERE email = 'sin-suprimir@ses-test.co'`);

    const deOtraLlave = firmar({ Type: 'Notification', MessageId: 'x', TopicArn: TOPIC, Timestamp: 't', Message: JSON.stringify(cuerpo) }, { clave: otra });
    expect((await enviarSns(deOtraLlave)).status).toBe(403);

    const alterada = notificacion(cuerpo);
    alterada.Message = JSON.stringify({ ...cuerpo, complaint: { complainedRecipients: [{ emailAddress: 'sin-suprimir@ses-test.co' }, { emailAddress: 'otra@ses-test.co' }] } });
    expect((await enviarSns(alterada)).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM email_supresiones WHERE email = 'sin-suprimir@ses-test.co'`)).rowCount).toBe(0);
  });

  test('certificado que no es de un host de SNS → 403', async () => {
    const msg = notificacion({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'sin-suprimir@ses-test.co' }] } });
    expect((await enviarSns({ ...msg, SigningCertURL: 'https://evil.example.com/cert.pem' })).status).toBe(403);
    expect((await enviarSns({ ...msg, SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem' })).status).toBe(403);
  });

  test('mensaje bien firmado pero de OTRO tema SNS → 403', async () => {
    const msg = firmar({
      Type: 'Notification', MessageId: 'y', TopicArn: 'arn:aws:sns:us-east-1:999999999999:atacante', Timestamp: 't',
      Message: JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'sin-suprimir@ses-test.co' }] } }),
    });
    expect((await enviarSns(msg)).status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM email_supresiones WHERE email = 'sin-suprimir@ses-test.co'`)).rowCount).toBe(0);
  });

  test('cuerpo que no es JSON → 400', async () => {
    const res = await request(app).post('/api/email/ses-eventos').set('Content-Type', 'text/plain').send('esto no es json');
    expect(res.status).toBe(400);
  });

  test('confirmación de suscripción → se confirma una sola vez y solo con URL de SNS', async () => {
    const url = 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc';
    const msg = firmar({ Type: 'SubscriptionConfirmation', MessageId: 'z', TopicArn: TOPIC, Timestamp: 't', Token: 'abc', SubscribeURL: url, Message: 'confirma' });
    const res = await enviarSns(msg);
    expect(res.status).toBe(200);
    expect(suscripcionesConfirmadasDePrueba).toContain(url);

    const mala = firmar({ Type: 'SubscriptionConfirmation', MessageId: 'z2', TopicArn: TOPIC, Timestamp: 't', Token: 'abc', SubscribeURL: 'https://evil.example.com/x', Message: 'm' });
    expect((await enviarSns(mala)).status).toBe(500);
    expect(suscripcionesConfirmadasDePrueba).not.toContain('https://evil.example.com/x');
  });
});

describe('Email — lista de supresión', () => {
  test('enviarEmail no escribe a una dirección suprimida (sin importar mayúsculas) y sí a las demás', async () => {
    const antes = emailsDePrueba.length;
    await expect(enviarEmail('REBOTE-PERM@ses-test.co', 'a', '<p>a</p>')).rejects.toMatchObject({ code: 'EMAIL_SUPRIMIDO' });
    expect(emailsDePrueba.length).toBe(antes);
    await enviarEmail('sin-suprimir@ses-test.co', 'a', '<p>a</p>');
    expect(emailsDePrueba.length).toBe(antes + 1);
  });

  test('GET /supresiones y DELETE — requieren sesión y permiso; reactivar deja escribirle otra vez', async () => {
    expect((await request(app).get('/api/email/supresiones')).status).toBe(401);

    const ag = request.agent(app);
    await ag.post('/api/auth/login').send({ email: mailAdmin, password: pass });
    const lista = await ag.get('/api/email/supresiones');
    expect(lista.status).toBe(200);
    const fila = lista.body.find((s) => s.email === 'rebote-perm@ses-test.co');
    expect(fila).toBeTruthy();

    expect((await ag.delete(`/api/email/supresiones/${fila.id}`)).status).toBe(200);
    expect((await ag.delete(`/api/email/supresiones/${fila.id}`)).status).toBe(404); // ya reactivada
    await enviarEmail('rebote-perm@ses-test.co', 'a', '<p>a</p>'); // ya no lanza
  });

  test('un rebote posterior vuelve a suprimir una dirección reactivada', async () => {
    await enviarSns(notificacion({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'rebote-perm@ses-test.co' }] },
    }));
    await expect(enviarEmail('rebote-perm@ses-test.co', 'a', '<p>a</p>')).rejects.toMatchObject({ code: 'EMAIL_SUPRIMIDO' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM email_supresiones WHERE lower(email) = 'rebote-perm@ses-test.co'`)).rows[0].n).toBe(1);
  });
});
