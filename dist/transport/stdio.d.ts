/**
 * The stdio transport, for laptop users running the bundled server.
 *
 * One server, one transport, for the life of the process. Nothing may be
 * written to stdout except protocol traffic, so every diagnostic goes to
 * stderr: a stray `console.log` here corrupts the stream and the client sees a
 * parse error rather than a message.
 */
import { type CreateServerOptions } from "../server.js";
export declare function serveStdio(options?: CreateServerOptions): Promise<void>;
//# sourceMappingURL=stdio.d.ts.map