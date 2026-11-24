// Error monitoring hook. Phase 0 task: pick a vendor and wire it here once.
// Until then errors go to the server log. Never send patient data in the payload.
export function captureError(error: unknown, context?: Record<string, string>) {
  console.error('[error]', error, context ?? {});
}
