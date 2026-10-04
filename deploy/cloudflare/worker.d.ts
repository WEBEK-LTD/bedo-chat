/** Types for the edge router, used by the browser tests' local edge (packages/e2e). */
export interface RouterEnv {
  WEB_ORIGIN: string;
  ADMIN_ORIGIN: string;
  API_ORIGIN: string;
}
export declare function route(pathname: string, env: RouterEnv): { origin: string; path: string };
export declare function destinationUrl(origin: string, path: string, search: string): URL | null;
export declare function publicLocation(location: string, origin: string, publicOrigin: string, publicPrefix: string): string;
declare const worker: { fetch(request: Request, env: Partial<RouterEnv> & { EDGE_SECRET?: string }): Promise<Response> };
export default worker;
