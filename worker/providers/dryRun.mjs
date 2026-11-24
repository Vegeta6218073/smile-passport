import { maskPhone } from '../templates.mjs';

// Default provider. Sends nothing; logs what would be sent so the whole flow can be tested for free.
export const dryRunProvider = {
  name: 'dry_run',
  async send(message) {
    console.log(
      `[dry-run] would send template "${message.templateName}" (${message.language}) to ${maskPhone(message.to)}:`,
      message.params,
    );
    return { providerMessageId: `dry-${message.id}` };
  },
};
