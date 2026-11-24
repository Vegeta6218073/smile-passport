import { dryRunProvider } from './dryRun.mjs';
import { createMetaCloudProvider } from './metaCloud.mjs';

// WHATSAPP_PROVIDER = dry_run (default) | meta_cloud. Adding a provider means adding one file here.
export function getProvider(env = process.env) {
  switch (env.WHATSAPP_PROVIDER ?? 'dry_run') {
    case 'dry_run':
      return dryRunProvider;
    case 'meta_cloud':
      return createMetaCloudProvider({
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        apiVersion: env.WHATSAPP_API_VERSION,
      });
    default:
      throw new Error(`Unknown WHATSAPP_PROVIDER "${env.WHATSAPP_PROVIDER}"`);
  }
}
