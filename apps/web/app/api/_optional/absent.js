// D-36: stands in for optional packages that NestJS, Fastify and pg try to load only when a feature that Bedo
// Chat does not use is turned on (class-validator, microservices, WebSockets, native pg). Bundling the API
// into the web app's /api route needs every import to resolve; these never run.
export {};
