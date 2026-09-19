import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { captacionPublicLimiter, enlacePublicoLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/captacionController.js';

const router = Router();

// Headers de privacidad para todos los endpoints públicos
const privacyHeaders = (_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
};

// ── Endpoints públicos (sin auth — token como sesión) ─────────────────────────
router.get ('/pub/stand/:standToken',                     ctrl.pubGetStandSession);
router.post('/pub/stand/:standToken/iniciar',             ctrl.pubIniciarDesdeStand);

router.get ('/pub/enlace/:token',                          ctrl.pubGetEnlace);
router.post('/pub/enlace/:token/iniciar',                  enlacePublicoLimiter, ctrl.pubIniciarDesdeEnlace);

router.get ('/pub/empresas',                              ctrl.pubListarEmpresas);

router.use('/pub/:token', privacyHeaders, captacionPublicLimiter);

router.get ('/pub/:token',                                ctrl.pubGetProspecto);
router.post('/pub/:token/ping',                           ctrl.pubPing);
router.post('/pub/:token/step-up',                        ctrl.pubStepUp);
router.put ('/pub/:token/personal',                       ctrl.pubSeccionPersonal);
router.put ('/pub/:token/laboral',                        ctrl.pubSeccionLaboral);
router.put ('/pub/:token/pep',                            ctrl.pubSeccionPepHandler);
router.put ('/pub/:token/financiera',                     ctrl.pubSeccionFinanciera);
router.put ('/pub/:token/aportes',                        ctrl.pubSeccionAportes);
router.put ('/pub/:token/beneficiarios',                  ctrl.pubSeccionBeneficiarios);
router.put ('/pub/:token/referencias',                    ctrl.pubSeccionReferencias);
router.post('/pub/:token/firmar',                         ctrl.pubFirmar);
router.post('/pub/:token/documentos/:lado/solicitar',     ctrl.pubSolicitarUploadCedula);
router.patch('/pub/:token/documentos/:lado/confirmar',    ctrl.pubConfirmarUploadCedula);

// ── Endpoints internos (auth + ACL) ──────────────────────────────────────────
router.use(verifyToken);

router.post  ('/enlaces-publicos',                 checkPermission('captacion', 'WRITE'),    ctrl.obtenerEnlacePublico);
router.delete('/enlaces-publicos/:empresa',        checkPermission('captacion', 'WRITE'),    ctrl.desactivarEnlacePublico);
router.post('/stand-sessions',                 checkPermission('captacion', 'WRITE'),    ctrl.crearStandSession);
router.post('/prospectos/stand',               checkPermission('captacion', 'WRITE'),    ctrl.initStandProspecto);
router.post('/prospectos',                     checkPermission('captacion', 'WRITE'),    ctrl.crearProspecto);
router.get ('/prospectos',                     checkPermission('captacion', 'READ'),     ctrl.listarProspectos);
router.get ('/prospectos/resumen',             checkPermission('captacion', 'READ'),     ctrl.resumenProspectos);
router.get ('/prospectos/:id',                 checkPermission('captacion', 'READ'),     ctrl.getProspecto);
router.put ('/prospectos/:id',                 checkPermission('captacion', 'WRITE'),    ctrl.actualizarProspecto);
router.post('/prospectos/:id/toque',           checkPermission('captacion', 'WRITE'),    ctrl.registrarToque);
router.get ('/prospectos/:id/whatsapp',        checkPermission('captacion', 'WRITE'),    ctrl.whatsappUrl);

router.get ('/valores/:uuid',                  checkPermission('captacion', 'READ'),     ctrl.getValoresAsesor);

router.get ('/vinculaciones',                  checkPermission('captacion', 'READ'),     ctrl.listarVinculaciones);
router.get ('/vinculaciones/:id',              checkPermission('captacion', 'READ'),     ctrl.getVinculacion);
router.get ('/vinculaciones/:id/documentos',   checkPermission('captacion', 'READ'),     ctrl.getDocumentosVinculacion);
router.get ('/vinculaciones/:id/formato',      checkPermission('captacion', 'READ'),     ctrl.descargarFormato);
router.post ('/vinculaciones/:id/documentos/:lado/solicitar', checkPermission('captacion', 'WRITE'), ctrl.solicitarDocumentoAsesor);
router.patch('/vinculaciones/:id/documentos/:lado/confirmar', checkPermission('captacion', 'WRITE'), ctrl.confirmarDocumentoAsesor);
router.put ('/vinculaciones/:id/aportes',      checkPermission('captacion', 'WRITE'),    ctrl.asesorSeccionAportes);
router.put ('/vinculaciones/:id/valores',     checkPermission('captacion', 'WRITE'),    ctrl.actualizarValoresAsesor);
router.post('/vinculaciones/:id/entregar',     checkPermission('captacion', 'ENTREGAR'), ctrl.entregar);

export default router;
