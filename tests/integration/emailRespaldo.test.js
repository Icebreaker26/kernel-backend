import { jest } from '@jest/globals';
import { enviarConRespaldo } from '../../src/services/emailService.js';

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
