export const localPairingToken = "local-development-only";

export interface PairingRequestContext {
  host?: string | undefined;
  origin?: string | undefined;
  forwardedByCloudflare?: boolean;
}

function isLoopbackUrl(value: string | undefined, defaultProtocol?: "http:"): boolean {
  if (!value) return false;

  try {
    const url = new URL(defaultProtocol ? `${defaultProtocol}//${value}` : value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "127.0.0.1"
      || url.hostname === "localhost"
      || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function acceptsPairingToken(
  receivedToken: string,
  configuredToken: string,
  request: PairingRequestContext,
): boolean {
  return receivedToken === configuredToken
    || (
      receivedToken === localPairingToken
      && !request.forwardedByCloudflare
      && isLoopbackUrl(request.host, "http:")
      && isLoopbackUrl(request.origin)
    );
}
