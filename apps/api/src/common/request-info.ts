import type { FastifyRequest } from 'fastify';

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
}

/** Client IP (respecting API_TRUST_PROXY_HOPS through Fastify) and a bounded user agent. */
export function requestInfo(request: FastifyRequest): RequestInfo {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 1000) : null,
  };
}

/** A short, human-readable device label from the user agent, used when the client does not send one. */
export function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) {
    return null;
  }
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
      : /OPR\/|Opera/.test(userAgent) ? 'Opera'
        : /Firefox\//.test(userAgent) ? 'Firefox'
          : /Chrome\//.test(userAgent) ? 'Chrome'
            : /Safari\//.test(userAgent) ? 'Safari'
              : null;
  const os =
    /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
      : /Android/.test(userAgent) ? 'Android'
        : /Windows/.test(userAgent) ? 'Windows'
          : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
            : /Linux/.test(userAgent) ? 'Linux'
              : null;
  if (browser && os) {
    return `${browser} on ${os}`;
  }
  return browser ?? os;
}
