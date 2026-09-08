import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const CLI_VERSION: string = pkg.version;
export const CLI_PACKAGE_NAME: string = pkg.name;
