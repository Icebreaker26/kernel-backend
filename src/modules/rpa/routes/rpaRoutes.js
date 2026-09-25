import express, { Router } from 'express';
import pool from '../../../db/database.js';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/rpaController.js';
import { hashToken } from '../services/rpaService.js';

const router = Router();

// ── Agente: se autentica con su propio token (Authorization: Bearer rpa_…), no con la cookie de un empleado ──
// Solo ve la cola de trabajos que se le entregan; no tiene acceso a ninguna otra ruta de Kernel.
const verifyAgente = async (req, res, next) => {
  try {
    const token = /^Bearer (rpa_[\w-]{20,})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    const { rows: [a] } = await pool.query(
      `SELECT id, nombre FROM rpa_agentes WHERE token_hash = $1 AND is_active`, [hashToken(token)]);
    if (!a) return res.status(401).json({ error: 'Token de agente inválido' });
    req.agente = a;
    next();
  } catch (err) { next(err); }
};

router.post('/agente/latido',           verifyAgente, ctrl.agenteLatido);
router.post('/agente/reclamar',         verifyAgente, ctrl.agenteReclamar);
// Se autentica ANTES de leer el cuerpo: sin token válido no se procesan 12 MB de JSON
router.post('/agente/jobs/:id/resultado', verifyAgente, express.json({ limit: '12mb' }), ctrl.agenteResultado);

// ── Empleados (cookie + ACL) ──────────────────────────────────────────────────
router.use(verifyToken);

// El asesor titular sube su asociado desde la vinculación: se apoya en su permiso de captación (no necesita permisos rpa)
router.get ('/vinculaciones/:id/estado', checkPermission('captacion', 'READ'),  ctrl.estadoVinculacion);
router.post('/vinculaciones/:id/subir',  checkPermission('captacion', 'WRITE'), ctrl.subirVinculacion);

router.get ('/jobs',                  checkPermission('rpa', 'READ'),    ctrl.listarJobs);
router.get ('/jobs/:id',              checkPermission('rpa', 'READ'),    ctrl.getJob);
router.get ('/capturas/:id',          checkPermission('rpa', 'READ'),    ctrl.verCaptura);
router.post('/jobs',                  checkPermission('rpa', 'WRITE'),   ctrl.encolar);
router.post('/jobs/:id/reevaluar',    checkPermission('rpa', 'WRITE'),   ctrl.reevaluar);
router.post('/jobs/:id/cancelar',     checkPermission('rpa', 'WRITE'),   ctrl.cancelar);
router.post('/jobs/:id/aprobar',      checkPermission('rpa', 'APROBAR'), ctrl.aprobar);
router.post('/jobs/:id/resolver',     checkPermission('rpa', 'APROBAR'), ctrl.resolver);

router.get   ('/equivalencias',       checkPermission('rpa', 'READ'),    ctrl.listarEquivalencias);
router.post  ('/equivalencias',       checkPermission('rpa', 'WRITE'),   ctrl.crearEquivalencia);
router.put   ('/equivalencias/:id',   checkPermission('rpa', 'WRITE'),   ctrl.actualizarEquivalencia);
router.delete('/equivalencias/:id',   checkPermission('rpa', 'WRITE'),   ctrl.eliminarEquivalencia);

router.get('/asesores/cedulas-sugeridas', checkPermission('rpa', 'ADMIN'), ctrl.sugerirCedulas);
router.put('/usuarios/:id/cedula',        checkPermission('rpa', 'ADMIN'), ctrl.asignarCedula);

router.get ('/agentes',               checkPermission('rpa', 'READ'),    ctrl.listarAgentes);
router.post('/agentes',               checkPermission('rpa', 'ADMIN'),   ctrl.crearAgente);
router.put ('/agentes/:id',           checkPermission('rpa', 'ADMIN'),   ctrl.estadoAgente);

export default router;
