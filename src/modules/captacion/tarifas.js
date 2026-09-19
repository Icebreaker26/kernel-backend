// Valores vigentes de los aportes y beneficios de la cooperativa (COP, mensuales salvo cuota_admision).
// Única fuente de verdad: el formulario público los recibe en GET /pub/:token y el backend los
// vuelve a aplicar al guardar, así que el cliente nunca decide el precio de fondo, seguro ni bono.
export const TARIFAS = {
  aporte_minimo:   74000,   // el asociado puede elegir un valor superior
  aporte_paso:     1000,    // múltiplos de $1.000: así también se reparte exacto en dos quincenas
  fondo_bienestar: 5300,    // fijo y obligatorio
  seguro_vida:     5000,    // opcional
  bono_sorteo:     3000,    // opcional; participa y paga cada mes
  cuota_admision:  35000,   // solo el primer mes
};

export const PERIODICIDADES = ['mensual', 'quincenal'];
