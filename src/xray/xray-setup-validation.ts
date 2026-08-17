import { normalizeSiteUrl } from "./xray-adapter";
import { parseXrayRegion } from "./xray-region";

export interface XraySetupValidationErrors {
  site?: string | undefined;
  region?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  jiraEmail?: string | undefined;
  jiraToken?: string | undefined;
}

// Validate the normalized host, not the raw string: "https://" trims non-empty but normalizes to
// "", which would store secrets under a degenerate key no command can ever address again.
export function validateXraySetupInput(
  site: string,
  clientId: string,
  clientSecret: string,
  region = "global"
): XraySetupValidationErrors | undefined {
  const errors: XraySetupValidationErrors = {};
  const normalized = normalizeSiteUrl(site);
  if (normalized === "") {
    errors.site = "Enter a host like acme.atlassian.net";
  } else {
    try {
      if (new URL(`https://${normalized}`).hostname !== normalized) {
        errors.site = "Enter a bare host (no path or port), like acme.atlassian.net";
      }
    } catch {
      errors.site = "Not a valid host";
    }
  }
  if (clientId.trim() === "") {errors.clientId = "Client id is required";}
  if (clientSecret.trim() === "") {errors.clientSecret = "Client secret is required";}
  if (parseXrayRegion(region) !== region) {errors.region = "Select Global, US, EU, or AU";}
  return Object.keys(errors).length > 0 ? errors : undefined;
}
