export type XrayRegion = "global" | "us" | "eu" | "au";

const REGIONS: readonly XrayRegion[] = ["global", "us", "eu", "au"];

// `xray.apiRegion` is a closed enum in package.json, but the value still arrives as a raw string and
// a hand-edited settings.json can hold anything — treat an unknown value as the global default
// rather than build a bogus host.
export function parseXrayRegion(raw: string): XrayRegion {
  return (REGIONS as readonly string[]).includes(raw) ? (raw as XrayRegion) : "global";
}

// One host, used consistently for auth + GraphQL + cache identity (§5). The global region uses the
// bare host; every other region prefixes its code.
export function xrayBaseUrl(region: XrayRegion): string {
  const host = region === "global" ? "xray.cloud.getxray.app" : `${region}.xray.cloud.getxray.app`;
  return `https://${host}/api/v2`;
}
