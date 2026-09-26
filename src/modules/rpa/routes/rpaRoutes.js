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
// Flexible del maestro de cartera: tareas del agente que no son de una vinculación. El CSV llega como cuerpo crudo (hasta 40 MB), tras autenticar
router.post('/agente/tareas/reclamar',       verifyAgente, ctrl.agenteTareaReclamar);
router.post('/agente/flexibles/:id/archivo', verifyAgente, express.raw({ type: () => true, limit: '40mb' }), ctrl.agenteFlexibleArchivo);
router.post('/agente/flexibles/:id/fallo',   verifyAgente, express.json({ limit: '20kb' }), ctrl.agenteFlexibleFallo);

// ── Empleados (cookie + ACL) ──────────────────────────────────────────────────
router.use(verifyToken);

// El asesor titular sube su asociado desde la vinculación: se apoya en su permiso de captación (no necesita permisos rpa)
router.get ('/vinculaciones/:id/estado', checkPermission('captacion', 'READ'),  ctrl.estadoVinculacion);
router.post('/vinculaciones/:id/subir',  checkPermission('captacion', 'WRITE'), ctrl.subirVinculacion);

// Flexible: pedirlo y verlo (rpa), y aprobarlo = aplicar el sync de asociados (rpa APROBAR + asociados WRITE)
router.get ('/flexibles',                 checkPermission('rpa', 'READ'),    ctrl.listarFlexibles);
router.post('/flexibles',                 checkPermission('rpa', 'WRITE'),   ctrl.solicitarFlexible);
router.get ('/flexibles/:id',             checkPermission('rpa', 'READ'),    ctrl.getFlexible);
router.post('/flexibles/:id/cancelar',    checkPermission('rpa', 'WRITE'),   ctrl.cancelarFlexible);
router.get ('/flexibles/:id/analisis',    checkPermission('rpa', 'APROBAR'), checkPermission('asociados', 'READ'),  ctrl.analizarFlexible);
router.get ('/flexibles/:id/archivo',     checkPermission('rpa', 'APROBAR'), ctrl.descargarFlexible);
router.post('/flexibles/:id/aplicar',     checkPermission('rpa', 'APROBAR'), checkPermission('asociados', 'WRITE'), ctrl.aplicarFlexible);
router.post('/flexibles/:id/rechazar',    checkPermission('rpa', 'APROBAR'), ctrl.rechazarFlexible);

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
