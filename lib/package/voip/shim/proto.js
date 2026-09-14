import { resolveBaileysModule } from './baileys-resolve.js';

let cachedProto;

export async function getProto() {
    if (cachedProto) return cachedProto;
    const mod = await resolveBaileysModule();
    cachedProto = mod.proto;
    return cachedProto;
}
