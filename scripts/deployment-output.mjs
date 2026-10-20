/** Keep build diagnostics bounded without exposing this disposable stack's credentials. */
export function summarizeOutput(stdout, stderr, secrets) {
  const redact = (output) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), output);
  return `${redact(stdout).slice(-6000)}\n${redact(stderr).slice(-2500)}`;
}
