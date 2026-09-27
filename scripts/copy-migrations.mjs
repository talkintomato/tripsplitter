// Copies the SQL migration files next to the compiled output, because tsc only emits .ts files.
import { cpSync } from 'node:fs';

cpSync(new URL('../src/db/migrations/', import.meta.url), new URL('../dist/db/migrations/', import.meta.url), {
  recursive: true,
});
