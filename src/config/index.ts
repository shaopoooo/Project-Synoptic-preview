export * from './env';
export * from './constants';
export * from './abis';

import { env } from './env';
import { constants } from './constants';
import { abis } from './abis';

export const config = {
  ...env,
  ...constants,
  ...abis,
};
