// Errores de negocio con su código HTTP. El errorHandler general oculta el mensaje de los errores con `status` en producción,
// y aquí el mensaje ES la respuesta útil (p. ej. "Falta el desprendible"), así que se responde directamente.
export class ErrorNegocio extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Envuelve un controlador: los ErrorNegocio se responden tal cual; el resto (Zod, Postgres, imprevistos) va al errorHandler
export const manejar = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ErrorNegocio) return res.status(err.status).json({ error: err.message, ...err.extra });
    next(err);
  }
};
