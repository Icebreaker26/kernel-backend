import winston from 'winston';
import { env } from './env.js';

const jsonFormat = winston.format.combine(winston.format.timestamp(), winston.format.json());

const transports = [
  new winston.transports.Console({
    format: env.NODE_ENV === 'development'
      ? winston.format.combine(winston.format.colorize(), winston.format.simple())
      : jsonFormat,
  }),
];

// F-09: en producción escribir logs a archivo con rotación diaria (5 años = 1825 archivos)
if (env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: jsonFormat,
      maxFiles: 1825,   // 5 años de rotación diaria
      tailable: true,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: jsonFormat,
      maxFiles: 1825,
      tailable: true,
    })
  );
}

const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: jsonFormat,
  transports,
});

export default logger;
