import { redactSecretText } from '@mavis/shared/logging/redact-log-secret';

export function normalizeTurnFailureReason(message: string | undefined): string | undefined {
  const text = message?.trim();
  return text ? redactSecretText(text).slice(0, 1024) : undefined;
}
