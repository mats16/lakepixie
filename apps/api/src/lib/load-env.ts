import { config } from 'dotenv';
import path from 'path';

const __dirname = import.meta.dirname;

export function loadRootEnv(): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  config({
    path: [
      path.join(__dirname, '../../../../.env.local'),
      path.join(__dirname, '../../../../.env'),
    ],
  });
}
