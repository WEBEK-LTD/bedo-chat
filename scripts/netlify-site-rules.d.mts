/** Types for the Netlify site rules reader, used by the browser tests' local Netlify site (packages/e2e). */
export interface RedirectRule {
  from: string;
  to: string;
  status?: number;
  force?: boolean;
}
export interface HeaderRule {
  for: string;
  values: Record<string, string>;
}
export interface SiteRules {
  redirects: RedirectRule[];
  headers: HeaderRule[];
}
export declare const SITE_CONFIG: string;
export declare function parseSiteRules(toml: string): SiteRules;
export declare function readSiteRules(file?: string): SiteRules;
export declare function pathMatches(pattern: string, pathname: string): boolean;
export declare function staticCandidates(pathname: string): string[];
export declare function resolveStatic(publicDir: string, pathname: string): string | null;
export declare function headersFor(rules: SiteRules, pathname: string): Record<string, string>;
