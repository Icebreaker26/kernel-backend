import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { verifyAsociado }  from '../../../middlewares/authAsociado.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/sorteosController.js';
import {
  crearSorteoSchema,
  asignarDirectoSchema,
  retirarDirectoSchema,
  gestionarSolicitudSchema,
  registrarGanadorSchema,
  solicitarBonoSchema,
  solicitarRetiroSchema,
} from '../schemas/sorteosSchema.js';

const router = Router();

const validate = (schema) => (req, res, next) => {
  schema.parse(req.body);
  next();
};

// ── Portal asociados (verifyAsociado) ───────────────────────────────────────
router.get('/portal/activo',                  verifyAsociado, ctrl.portalActivo);
router.post('/portal/solicitar',              verifyAsociado, validate(solicitarBonoSchema),  ctrl.solicitarBono);
router.post('/portal/solicitar-retiro',       verifyAsociado, validate(solicitarRetiroSchema), ctrl.solicitarRetiro);
router.delete('/portal/solicitudes/:sid',     verifyAsociado, ctrl.cancelarSolicitud);

// ── Empleados (verifyToken + checkPermission) ───────────────────────────────
router.use(verifyToken);

router.get('/',
  checkPermission('sorteos', 'READ'), ctrl.listarSorteos);

router.post('/',
  checkPermission('sorteos', 'WRITE'), validate(crearSorteoSchema), ctrl.crearSorteo);

router.put('/:id/estado',
  checkPermission('sorteos', 'WRITE'), ctrl.toggleEstado);

router.post('/:id/empresas/:codigo',
  checkPermission('sorteos', 'WRITE'), ctrl.toggleEmpresa);

router.get('/:id/boletos',
  checkPermission('sorteos', 'READ'), ctrl.listarBoletos);

router.post('/:id/boletos/asignar',
  checkPermission('sorteos', 'WRITE'), validate(asignarDirectoSchema), ctrl.asignarDirecto);

router.post('/:id/boletos/retirar',
  checkPermission('sorteos', 'WRITE'), validate(retirarDirectoSchema), ctrl.retirarDirecto);

router.get('/:id/solicitudes',
  checkPermission('sorteos', 'READ'), ctrl.listarSolicitudes);

router.post('/:id/solicitudes/:sid/aprobar',
  checkPermission('sorteos', 'WRITE'), validate(gestionarSolicitudSchema), ctrl.aprobarSolicitud);

router.post('/:id/solicitudes/:sid/rechazar',
  checkPermission('sorteos', 'WRITE'), validate(gestionarSolicitudSchema), ctrl.rechazarSolicitud);

router.post('/:id/ganador',
  checkPermission('sorteos', 'WRITE'), validate(registrarGanadorSchema), ctrl.registrarGanador);

router.get('/:id/ganadores',
  checkPermission('sorteos', 'READ'), ctrl.listarGanadores);

router.get('/:id/estadisticas',
  checkPermission('sorteos', 'READ'), ctrl.estadisticasSorteo);

router.get('/:id/asociados',
  checkPermission('sorteos', 'READ'), ctrl.listarAsociadosSorteo);

router.get('/:id/reporte-participantes',
  checkPermission('sorteos', 'READ'), ctrl.reporteParticipantes);

router.get('/:id/asociados/:codigo/historial',
  checkPermission('sorteos', 'READ'), ctrl.historialAsociadoSorteo);

router.get('/:id/logs',
  checkPermission('sorteos', 'READ'), ctrl.listarLogs);

export default router;
