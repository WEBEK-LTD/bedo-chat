export declare const ADMIN_CSP: string;
export declare const INFO_CSP: string;
export declare function storageOrigin(value: string): string;
export declare function webCsp(options: { nonce: string; apiUrl?: string; storage?: string; dev?: boolean; https?: boolean }): string;
