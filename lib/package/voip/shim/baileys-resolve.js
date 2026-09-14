const DEFAULT_CANDIDATES = [
    'baileys',
    '@whiskeysockets/baileys',
    '@adiwajshing/baileys',
    '@itsliaaa/baileys',
];

function candidateNames() {
    const override = process.env.VOIP_BAILEYS_PACKAGE;
    if (!override) return DEFAULT_CANDIDATES;
    const extra = override.split(',').map((s) => s.trim()).filter(Boolean);
    return [...new Set([...extra, ...DEFAULT_CANDIDATES])];
}

let cachedModule = null;

export async function resolveBaileysModule() {
    if (cachedModule) return cachedModule;
    const names = candidateNames();
    let lastError;
    for (const name of names) {
        try {
            cachedModule = await import(name);
            return cachedModule;
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error(
        `voip: could not find a Baileys install (tried: ${names.join(', ')}). ` +
        `Install one of these packages, add an npm alias for it named "baileys" in your package.json, ` +
        `or set VOIP_BAILEYS_PACKAGE to the package name you use. ` +
        `Last error: ${lastError?.message || lastError}`
    );
}
