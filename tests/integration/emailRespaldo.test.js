import { jest } from '@jest/globals';
import { enviarConRespaldo, enviarPorCadena } from '../../src/services/emailService.js';

describe('Email — respaldo del relay', () => {
  const args = ['a@b.co', 'Asunto', '<p>hola</p>', 'hola'];

  test('si el relay funciona, no se usa el respaldo', async () => {
    const principal = jest.fn().mockResolvedValue();
    const respaldo = jest.fn();
    await enviarConRespaldo(principal, respaldo, args);
    expect(principal).toHaveBeenCalledWith(...args);
    expect(respaldo).not.toHaveBeenCalled();
  });

  test('si el relay falla, se envía por el respaldo con los mismos argumentos', async () => {
    const principal = jest.fn().mockRejectedValue(new Error('relay caído'));
    const respaldo = jest.fn().mockResolvedValue();
    await enviarConRespaldo(principal, respaldo, args);
    expect(respaldo).toHaveBeenCalledWith(...args);
  });

  test('si falla el relay y no hay respaldo, propaga el error del relay', async () => {
    const principal = jest.fn().mockRejectedValue(new Error('relay caído'));
    await expect(enviarConRespaldo(principal, null, args)).rejects.toThrow('relay caído');
  });

  test('si fallan ambos, propaga el error del respaldo', async () => {
    const principal = jest.fn().mockRejectedValue(new Error('relay caído'));
    const respaldo = jest.fn().mockRejectedValue(new Error('SES rechazó el correo'));
    await expect(enviarConRespaldo(principal, respaldo, args)).rejects.toThrow('SES rechazó el correo');
  });
});

describe('enviarPorCadena — Resend → relay → SES', () => {
  const args = ['a@b.co', 'Asunto', '<p>x</p>', 'x'];

  test('usa el primer canal si funciona y no toca los demás', async () => {
    const a = jest.fn().mockResolvedValue(); const b = jest.fn();
    await enviarPorCadena([a, b], args);
    expect(a).toHaveBeenCalledWith(...args);
    expect(b).not.toHaveBeenCalled();
  });

  test('salta al siguiente canal cuando falla el anterior', async () => {
    const a = jest.fn().mockRejectedValue(new Error('resend caído'));
    const b = jest.fn().mockRejectedValue(new Error('relay apagado'));
    const c = jest.fn().mockResolvedValue();
    await enviarPorCadena([a, b, c], args);
    expect(c).toHaveBeenCalledTimes(1);
  });

  test('si todos fallan lanza el error del último', async () => {
    const a = jest.fn().mockRejectedValue(new Error('uno'));
    const b = jest.fn().mockRejectedValue(new Error('dos'));
    await expect(enviarPorCadena([a, b], args)).rejects.toThrow('dos');
  });
});
