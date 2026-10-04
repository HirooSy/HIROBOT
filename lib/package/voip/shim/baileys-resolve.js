const DEFAULT_CANDIDATES = [
    'baileys',
    '@whiskeysockets/baileys',
    '@adiwajshing/baileys',
    '@itsliaaa/baileys',
];

function candidateNames() {
    return DEFAULT_CANDIDATES;
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
        `Install one of these packages or add an npm alias for it named "baileys" in your package.json. ` +
        `Last error: ${lastError?.message || lastError}`
    );
}
