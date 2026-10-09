import { convertToWranglerConfig, InputConfigSchema } from '@cloudflare/config';
import { preview } from '../../tools/cloudflare/preview.ts';

await preview((input) => convertToWranglerConfig(InputConfigSchema.parse(input)));
