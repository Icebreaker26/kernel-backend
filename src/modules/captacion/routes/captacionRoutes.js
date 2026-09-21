import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { captacionPublicLimiter, enlacePublicoLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/captacionController.js';
import * as listas from '../controllers/consultaListasController.js';

const router = Router();
const auditarPub = ctrl.auditarCambioPosteriorAFirma('prospecto');
const exigirHabeas = ctrl.exigirHabeasData;
const auditarAsesor = ctrl.auditarCambioPosteriorAFirma('asesor');

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

// Página pública /asociate (enlace único para el sitio web de la cooperativa)
router.get ('/pub/presencia',                             enlacePublicoLimiter, ctrl.pubPresencia);
router.get ('/pub/sitio',                                  enlacePublicoLimiter, ctrl.pubSitio);
router.get ('/pub/web',                                   ctrl.pubGetWeb);
router.post('/pub/web/visita',                            enlacePublicoLimiter, ctrl.pubVisitaWeb);
router.post('/pub/web/iniciar',                           enlacePublicoLimiter, ctrl.pubIniciarDesdeWeb);

router.use('/pub/:token', privacyHeaders, captacionPublicLimiter);

router.get ('/pub/:token',                                ctrl.pubGetProspecto);
router.post('/pub/:token/ping',                           ctrl.pubPing);
router.post('/pub/:token/habeas-data',                    ctrl.pubAceptarHabeasData);
router.post('/pub/:token/otp',                            exigirHabeas, ctrl.pubSolicitarOtp);
router.post('/pub/:token/step-up',                        exigirHabeas, ctrl.pubStepUp);
router.put ('/pub/:token/personal',                       exigirHabeas, auditarPub, ctrl.pubSeccionPersonal);
router.put ('/pub/:token/laboral',                        exigirHabeas, auditarPub, ctrl.pubSeccionLaboral);
router.put ('/pub/:token/pep',                            exigirHabeas, auditarPub, ctrl.pubSeccionPepHandler);
router.put ('/pub/:token/financiera',                     exigirHabeas, auditarPub, ctrl.pubSeccionFinanciera);
router.put ('/pub/:token/aportes',                        exigirHabeas, auditarPub, ctrl.pubSeccionAportes);
router.put ('/pub/:token/beneficiarios',                  exigirHabeas, auditarPub, ctrl.pubSeccionBeneficiarios);
router.put ('/pub/:token/referencias',                    exigirHabeas, auditarPub, ctrl.pubSeccionReferencias);
router.post('/pub/:token/subsanacion/resolver',           exigirHabeas, ctrl.pubResolverSubsanacion);
router.post('/pub/:token/firmar',                         exigirHabeas, ctrl.pubFirmar);
router.post('/pub/:token/documentos/:lado/solicitar',     exigirHabeas, ctrl.pubSolicitarUploadCedula);
router.patch('/pub/:token/documentos/:lado/confirmar',    exigirHabeas, auditarPub, ctrl.pubConfirmarUploadCedula);

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

// Configuración de la página pública /asociate (el asesor se elige aquí, no en variables de entorno)
router.get ('/config/web',                     checkPermission('captacion', 'READ'),       ctrl.getConfigWeb);
router.put ('/config/web',                     checkPermission('captacion', 'CONFIGURAR'), ctrl.actualizarConfigWeb);

router.get ('/config/validacion-voz',          checkPermission('captacion', 'READ'),       ctrl.getExigenciaVoz);
router.put ('/config/validacion-voz',          checkPermission('captacion', 'CONFIGURAR'), ctrl.actualizarExigenciaVoz);

router.get ('/vinculaciones',                  checkPermission('captacion', 'READ'),     ctrl.listarVinculaciones);
router.get ('/vinculaciones/:id',              checkPermission('captacion', 'READ'),     ctrl.getVinculacion);
// Consulta en listas restrictivas y fuentes abiertas: la hace el asesor; el Oficial de Cumplimiento valida que se hizo bien
router.get ('/vinculaciones/:id/consulta-listas', checkPermission('captacion', 'READ'),  listas.getConsultaListas);
router.post('/vinculaciones/:id/consulta-listas', checkPermission('captacion', 'WRITE'), listas.iniciarConsultaListas);
router.put ('/consultas-listas/:cid',             checkPermission('captacion', 'WRITE'), listas.guardarConsultaListas);
router.post('/consultas-listas/:cid/buscar',      checkPermission('captacion', 'WRITE'), listas.buscarWebConsulta);
router.post('/consultas-listas/:cid/cerrar',      checkPermission('captacion', 'WRITE'), listas.cerrarConsultaListas);
router.get ('/consultas-listas/:cid/pdf',         checkPermission('captacion', 'READ'),  listas.pdfConsultaAsesor);
router.get ('/cumplimiento/consultas',            checkPermission('captacion', 'VALIDAR'), listas.listarConsultasCumplimiento);
router.get ('/cumplimiento/consultas/:cid',       checkPermission('captacion', 'VALIDAR'), listas.getConsultaCumplimiento);
router.get ('/cumplimiento/consultas/:cid/pdf',   checkPermission('captacion', 'VALIDAR'), listas.pdfConsultaOficial);
router.post('/cumplimiento/consultas/:cid/validar', checkPermission('captacion', 'VALIDAR'), listas.validarConsulta);
router.get ('/cumplimiento/listas',               checkPermission('captacion', 'VALIDAR'), listas.getEstadoListas);
router.post('/cumplimiento/listas/actualizar',    checkPermission('captacion', 'VALIDAR'), listas.actualizarListasAhora);
router.get ('/listas/estado',                     checkPermission('captacion', 'READ'),  listas.getEstadoListas);
router.get ('/config/reglas-entrega',             checkPermission('captacion', 'READ'),  listas.getReglasEntrega);
router.put ('/config/reglas-entrega',             checkPermission('captacion', 'CONFIGURAR'), listas.actualizarReglasEntrega);

router.get ('/vinculaciones/:id/correcciones',   checkPermission('captacion', 'READ'),   ctrl.getCorrecciones);
router.post('/vinculaciones/:id/verificacion-identidad', checkPermission('captacion', 'WRITE'), ctrl.verificarIdentidad);
router.put ('/vinculaciones/:id/identidad',      checkPermission('captacion', 'WRITE'),  ctrl.corregirIdentidad);
router.get ('/vinculaciones/:id/subsanacion',    checkPermission('captacion', 'READ'),   ctrl.getSubsanacion);
router.post('/vinculaciones/:id/subsanacion',    checkPermission('captacion', 'WRITE'),  ctrl.pedirSubsanacion);
router.post('/vinculaciones/:id/subsanacion/cerrar', checkPermission('captacion', 'WRITE'), ctrl.cerrarSubsanacion);
router.get ('/vinculaciones/:id/validacion-voz', checkPermission('captacion', 'READ'),   ctrl.getValidacionVoz);
router.post('/vinculaciones/:id/validacion-voz', checkPermission('captacion', 'WRITE'),  ctrl.registrarValidacionVoz);
router.get ('/vinculaciones/:id/documentos',   checkPermission('captacion', 'READ'),     ctrl.getDocumentosVinculacion);
router.get ('/vinculaciones/:id/formato',      checkPermission('captacion', 'READ'),     ctrl.descargarFormato);
router.post ('/vinculaciones/:id/documentos/:lado/solicitar', checkPermission('captacion', 'WRITE'), ctrl.solicitarDocumentoAsesor);
router.patch('/vinculaciones/:id/documentos/:lado/confirmar', checkPermission('captacion', 'WRITE'), auditarAsesor, ctrl.confirmarDocumentoAsesor);
router.put ('/vinculaciones/:id/aportes',      checkPermission('captacion', 'WRITE'),    auditarAsesor, ctrl.asesorSeccionAportes);
router.put ('/vinculaciones/:id/valores',     checkPermission('captacion', 'WRITE'),    auditarAsesor, ctrl.actualizarValoresAsesor);
router.post('/vinculaciones/:id/entregar',     checkPermission('captacion', 'ENTREGAR'), ctrl.entregar);

export default router;
